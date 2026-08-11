use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};
use window_vibrancy::apply_mica;

#[derive(serde::Serialize, Clone, Debug)]
struct ProgressPayload {
    current: usize,
    total: usize,
    file_name: String,
}

#[derive(serde::Serialize, Clone, Debug)]
struct MediaFile {
    path: String,
    name: String,
    size: u64,
    file_type: String,
    date: String,
    timestamp: u64, // Epoch time in milliseconds (for sub-second burst precision)
    thumbnail_url: String,
}

#[derive(serde::Deserialize, Debug)]
struct ImportFile {
    source_path: String,
    file_type: String,
    is_favorite: bool,
}

#[derive(serde::Deserialize, Debug)]
struct DayImportConfig {
    date: String,
    suffix: String,
    files: Vec<ImportFile>,
}

// Find the offset of the TIFF header within a JPEG file by searching for "Exif\0\0"
fn find_tiff_header_offset(path: &Path) -> Option<u64> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    
    // Read the first 128 KB which contains the EXIF APP1 segment
    let mut buffer = vec![0u8; 131072];
    let bytes_read = file.read(&mut buffer).ok()?;
    
    // Search for "Exif\0\0" signature prefix
    let signature = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
    let pos = buffer[..bytes_read].windows(signature.len())
        .position(|window| window == signature)?;
        
    Some((pos + 6) as u64)
}

// Inject EXIF Orientation APP1 header into raw embedded JPEG previews if missing
fn inject_exif_orientation_if_missing(buffer: Vec<u8>, orientation: u32) -> Vec<u8> {
    if orientation <= 1 || buffer.len() < 4 || buffer[0] != 0xFF || buffer[1] != 0xD8 {
        return buffer;
    }
    // Check if JPEG buffer already has an APP1 EXIF segment (0xFF, 0xE1)
    if buffer[2] == 0xFF && buffer[3] == 0xE1 {
        return buffer;
    }

    let orient_low = (orientation & 0xFF) as u8;
    let orient_high = ((orientation >> 8) & 0xFF) as u8;
    let app1: [u8; 36] = [
        0xFF, 0xE1, // APP1 marker
        0x00, 0x20, // Length (32 bytes following marker length field)
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
        0x49, 0x49, // Little Endian ("II")
        0x2A, 0x00, // Fixed 42
        0x08, 0x00, 0x00, 0x00, // Offset to IFD0 (8)
        0x01, 0x00, // 1 field count
        0x12, 0x01, // Tag 0x0112 (Orientation)
        0x03, 0x00, // Type 3 (SHORT)
        0x01, 0x00, 0x00, 0x00, // Count 1
        orient_low, orient_high, 0x00, 0x00, // Value + 2 bytes padding
        0x00, 0x00, 0x00, 0x00, // Offset to next IFD (NULL)
    ];

    let mut result = Vec::with_capacity(buffer.len() + app1.len());
    result.extend_from_slice(&buffer[0..2]);
    result.extend_from_slice(&app1);
    result.extend_from_slice(&buffer[2..]);
    result
}

// Extract embedded JPEG preview from EXIF/TIFF containers (RAW or JPEG files)
fn get_embedded_jpeg(path: &Path) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exifreader = exif::Reader::new().read_from_container(&mut reader).ok();

    let orientation = exifreader.as_ref().and_then(|r| {
        r.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
    }).unwrap_or(1);

    let offset_field = exifreader.as_ref().and_then(|r| {
        r.get_field(exif::Tag::JPEGInterchangeFormat, exif::In(1))
            .or_else(|| r.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::PRIMARY))
    })?;
    let length_field = exifreader.as_ref().and_then(|r| {
        r.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In(1))
            .or_else(|| r.get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::PRIMARY))
    })?;
        
    let relative_offset = offset_field.value.get_uint(0)? as u64;
    let length = length_field.value.get_uint(0)? as usize;
    
    // Compute the absolute offset
    // JPEGs wrap Exif in APP1; TIFF RAW files start directly with the TIFF header (offset 0)
    let base_offset = find_tiff_header_offset(path).unwrap_or(0);
    let absolute_offset = base_offset + relative_offset;
    
    use std::io::{Seek, SeekFrom, Read};
    let mut underlying_file = reader.into_inner();
    underlying_file.seek(SeekFrom::Start(absolute_offset)).ok()?;
    let mut buffer = vec![0u8; length];
    underlying_file.read_exact(&mut buffer).ok()?;
    
    Some(inject_exif_orientation_if_missing(buffer, orientation))
}

// Find and extract the embedded JPEG preview from Canon CR3 files (ISOBMFF format)
fn get_cr3_thumbnail(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    
    // Read the first 4 MB of the CR3 file (where preview boxes are located)
    let mut buffer = vec![0u8; 4 * 1024 * 1024];
    let bytes_read = file.read(&mut buffer).ok()?;
    
    // Find the "prvw" box type signature
    let prvw_sig = [0x70, 0x72, 0x76, 0x77];
    let prvw_pos = buffer[..bytes_read].windows(prvw_sig.len())
        .position(|window| window == prvw_sig)?;
        
    // Find the JPEG start marker [0xFF, 0xD8, 0xFF] starting from prvw_pos
    let jpeg_start_sig = [0xFF, 0xD8, 0xFF];
    let jpeg_start = buffer[prvw_pos..bytes_read].windows(jpeg_start_sig.len())
        .position(|window| window == jpeg_start_sig)
        .map(|pos| prvw_pos + pos)?;
        
    // Find the JPEG end marker [0xFF, 0xD9] starting from jpeg_start
    let jpeg_end_sig = [0xFF, 0xD9];
    let jpeg_end = buffer[jpeg_start..bytes_read].windows(jpeg_end_sig.len())
        .position(|window| window == jpeg_end_sig)
        .map(|pos| jpeg_start + pos + 2)?;
        
    let raw_jpeg = buffer[jpeg_start..jpeg_end].to_vec();
    let orientation = get_raw_orientation(path);
    Some(inject_exif_orientation_if_missing(raw_jpeg, orientation))
}

fn get_raw_orientation(path: &Path) -> u32 {
    if let Ok(file) = fs::File::open(path) {
        let mut reader = BufReader::new(file);
        if let Ok(exifreader) = exif::Reader::new().read_from_container(&mut reader) {
            if let Some(field) = exifreader.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
                if let Some(val) = field.value.get_uint(0) {
                    return val;
                }
            }
        }
    }
    1
}

// Find and extract the embedded JPEG preview from Fujifilm RAF files
fn get_raf_thumbnail(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    
    // Read the first 4 MB of the RAF file (where preview bytes are located)
    let mut buffer = vec![0u8; 4 * 1024 * 1024];
    let bytes_read = file.read(&mut buffer).ok()?;
    
    // Search for the JPEG start marker [0xFF, 0xD8, 0xFF] after the 16-byte magic header
    let jpeg_start_sig = [0xFF, 0xD8, 0xFF];
    let jpeg_start = buffer[16..bytes_read].windows(jpeg_start_sig.len())
        .position(|window| window == jpeg_start_sig)
        .map(|pos| 16 + pos)?;
        
    // Find the JPEG end marker [0xFF, 0xD9] starting from jpeg_start
    let jpeg_end_sig = [0xFF, 0xD9];
    let jpeg_end = buffer[jpeg_start..bytes_read].windows(jpeg_end_sig.len())
        .position(|window| window == jpeg_end_sig)
        .map(|pos| jpeg_start + pos + 2)?;
        
    let raw_jpeg = buffer[jpeg_start..jpeg_end].to_vec();
    let orientation = get_raw_orientation(path);
    Some(inject_exif_orientation_if_missing(raw_jpeg, orientation))
}
// Extract capture date (YYYY-MM-DD) and UNIX timestamp in milliseconds (with EXIF SubSecTime precision)
fn get_capture_info(path: &Path, file_type: &str, metadata: &fs::Metadata) -> (String, u64) {
    if file_type != "video" {
        if let Ok(file) = fs::File::open(path) {
            let mut reader = BufReader::new(file);
            if let Ok(exifreader) = exif::Reader::new().read_from_container(&mut reader) {
                if let Some(field) = exifreader.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
                    let val_str = field.display_value().to_string();
                    let date_part = if val_str.len() >= 10 {
                        val_str.chars().take(10).collect::<String>().replace(':', "-")
                    } else {
                        "Unknown-Date".to_string()
                    };

                    // Try parsing full datetime for base seconds
                    let mut timestamp_sec = 0u64;
                    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&val_str, "%Y-%m-%d %H:%M:%S") {
                        timestamp_sec = naive.and_utc().timestamp() as u64;
                    } else if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(&val_str, "%Y:%m:%d %H:%M:%S") {
                        timestamp_sec = naive.and_utc().timestamp() as u64;
                    }

                    if timestamp_sec > 0 {
                        // Extract SubSecTimeOriginal for sub-second precision (millisecond resolution)
                        let subsec_ms = if let Some(sub_field) = exifreader.get_field(exif::Tag::SubSecTimeOriginal, exif::In::PRIMARY)
                            .or_else(|| exifreader.get_field(exif::Tag::SubSecTime, exif::In::PRIMARY)) {
                            let s = sub_field.display_value().to_string();
                            let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
                            if digits.len() == 1 {
                                digits.parse::<u64>().unwrap_or(0) * 100
                            } else if digits.len() == 2 {
                                digits.parse::<u64>().unwrap_or(0) * 10
                            } else if digits.len() >= 3 {
                                digits[..3].parse::<u64>().unwrap_or(0)
                            } else {
                                0
                            }
                        } else {
                            0
                        };

                        return (date_part, timestamp_sec * 1000 + subsec_ms);
                    }
                }
            }
        }
    }

    // Fallback to system metadata creation/modification time
    if let Ok(system_time) = metadata.created().or_else(|_| metadata.modified()) {
        let datetime: chrono::DateTime<chrono::Local> = system_time.into();
        let date_str = datetime.format("%Y-%m-%d").to_string();
        let ts_ms = system_time.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        return (date_str, ts_ms);
    }

    ("Unknown-Date".to_string(), 0)
}

// Classify file based on its extension
fn get_file_type(path: &Path) -> &'static str {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" | "webp" => "jpg",
            "cr3" | "cr2" | "arw" | "nef" | "dng" | "raf" | "orf" | "rw2" | "pef" => "raw",
            "mp4" | "mov" | "avi" | "mkv" => "video",
            _ => "autres",
        }
    } else {
        "autres"
    }
}

// Collect file paths recursively
fn scan_directory(dir: &Path, files: &mut Vec<PathBuf>) {
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Skip Sony metadata and thumbnail directories
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    let name_lower = name.to_lowercase();
                    if name_lower == "thmbnl" || name_lower == "sony" {
                        continue;
                    }
                }
                scan_directory(&path, files);
            } else {
                files.push(path);
            }
        }
    }
}

#[tauri::command]
async fn scan_source(app: tauri::AppHandle, source_path: String) -> Result<HashMap<String, Vec<MediaFile>>, String> {
    use rayon::prelude::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    let src_dir = Path::new(&source_path);
    if !src_dir.exists() || !src_dir.is_dir() {
        return Err("Le dossier source n'existe pas ou n'est pas valide.".to_string());
    }

    let mut file_paths = Vec::new();
    scan_directory(src_dir, &mut file_paths);

    let total_files = file_paths.len();
    let progress_counter = AtomicUsize::new(0);

    // Process files in parallel to hide slow SD card I/O latencies
    let media_files: Vec<MediaFile> = file_paths
        .into_par_iter()
        .filter_map(|path| {
            let app = app.clone();
            let name = path.file_name()?.to_str()?.to_string();

            // Skip hidden/system files
            if name.starts_with('.') || name == "Thumbs.db" || name == "desktop.ini" {
                return None;
            }

            // Double check to ignore files in Sony metadata/thumbnail directories (e.g. PRIVATE/M4ROOT/THMBNL)
            let path_str = path.to_string_lossy().replace('\\', "/");
            let path_lower = path_str.to_lowercase();
            if path_lower.contains("/thmbnl/") || path_lower.contains("/sony/") {
                return None;
            }

            let metadata = fs::metadata(&path).ok()?;
            let size = metadata.len();
            let file_type = get_file_type(&path).to_string();
            
            // Skip unknown assets that are not images, raws or videos to keep the list clean
            if file_type == "autres" {
                return None;
            }

            let (date, timestamp) = get_capture_info(&path, &file_type, &metadata);
            let thumbnail_url = if file_type == "video" {
                "".to_string()
            } else {
                #[cfg(target_os = "windows")]
                let url = format!("http://vault-asset.localhost/{}", path_str);
                #[cfg(not(target_os = "windows"))]
                let url = format!("vault-asset://localhost/{}", path_str);
                url
            };

            let current = progress_counter.fetch_add(1, Ordering::SeqCst) + 1;
            if current % 5 == 0 || current == total_files {
                let _ = app.emit("scan-progress", ProgressPayload {
                    current,
                    total: total_files,
                    file_name: name.clone(),
                });
            }

            Some(MediaFile {
                path: path.to_string_lossy().to_string(),
                name,
                size,
                file_type,
                date,
                timestamp,
                thumbnail_url,
            })
        })
        .collect();

    // Group media files by date (sequentially in-memory is extremely fast)
    let mut grouped: HashMap<String, Vec<MediaFile>> = HashMap::new();
    for media_file in media_files {
        grouped.entry(media_file.date.clone()).or_default().push(media_file);
    }

    Ok(grouped)
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn start_import(app: tauri::AppHandle, destination: String, days: Vec<DayImportConfig>, delete_source: bool) -> Result<(), String> {
    let dest_dir = Path::new(&destination);
    if !dest_dir.exists() {
        fs::create_dir_all(dest_dir)
            .map_err(|e| format!("Impossible de créer le dossier de destination: {:?}", e))?;
    }

    let total_files = days.iter().map(|d| d.files.len()).sum::<usize>();
    let mut current = 0;

    for day in days {
        let folder_name = if day.suffix.trim().is_empty() {
            day.date.clone()
        } else {
            format!("{} - {}", day.date, day.suffix.trim())
        };

        let day_dir = dest_dir.join(folder_name);
        let jpg_dir = day_dir.join("jpg");
        let raw_dir = day_dir.join("raw");
        let video_dir = day_dir.join("video");
        let favoris_dir = day_dir.join("favoris");

        for file in day.files {
            let src_path = Path::new(&file.source_path);
            if !src_path.exists() {
                continue;
            }

            let file_name = match src_path.file_name() {
                Some(name) => name,
                None => continue,
            };

            let type_dir = match file.file_type.as_str() {
                "jpg" => &jpg_dir,
                "raw" => &raw_dir,
                "video" => &video_dir,
                _ => continue, // skip unrecognized files
            };

            // Ensure destination subdirectory (jpg, raw, video) exists on-demand
            if !type_dir.exists() {
                fs::create_dir_all(type_dir)
                    .map_err(|e| format!("Erreur lors de la création du dossier {:?}: {:?}", type_dir, e))?;
            }

            let target_path = type_dir.join(file_name);

            // Copy file physically
            fs::copy(src_path, &target_path)
                .map_err(|e| format!("Erreur lors de la copie de {:?} vers {:?}: {:?}", src_path, target_path, e))?;

            // If it's a favorite, create favoris directory on-demand and create a hardlink
            if file.is_favorite {
                if !favoris_dir.exists() {
                    fs::create_dir_all(&favoris_dir)
                        .map_err(|e| format!("Erreur lors de la création du dossier favoris {:?}: {:?}", favoris_dir, e))?;
                }
                let fav_path = favoris_dir.join(file_name);
                if let Err(_) = fs::hard_link(&target_path, &fav_path) {
                     // Fallback to physical copy if hardlinking fails (e.g. cross-device)
                     fs::copy(&target_path, &fav_path)
                         .map_err(|e| format!("Erreur de copie de secours du favori vers {:?}: {:?}", fav_path, e))?;
                }
            }

            // If delete_source is true, remove the source file from SD Card
            if delete_source {
                if let Err(e) = fs::remove_file(src_path) {
                    eprintln!("Impossible de supprimer le fichier source original {:?}: {:?}", src_path, e);
                }
            }

            current += 1;
            let _ = app.emit("import-progress", ProgressPayload {
                current,
                total: total_files,
                file_name: file_name.to_string_lossy().into_owned(),
            });
        }
    }

    Ok(())
}

#[tauri::command]
fn select_folder(title: Option<String>) -> Option<String> {
    let mut dialog = rfd::FileDialog::new();
    if let Some(t) = title {
        dialog = dialog.set_title(&t);
    }
    let result = dialog.pick_folder();
    result.map(|path| path.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                let _ = apply_mica(&window, None);
                
                #[cfg(target_os = "macos")]
                let _ = window_vibrancy::apply_vibrancy(
                    &window,
                    window_vibrancy::NSVisualEffectMaterial::HudWindow,
                    None,
                    None,
                );
            }
            Ok(())
        })
        .register_uri_scheme_protocol("vault-asset", |_ctx, request| {
            let uri = request.uri();
            let path_str = uri.path();
            
            // Decode percent-encoded paths (e.g. spaces, accents)
            let decoded_path = percent_encoding::percent_decode_str(path_str).decode_utf8_lossy();
            
            // Normalize path for Windows drive letters (strip leading slash)
            let mut final_path = decoded_path.into_owned();
            if final_path.starts_with('/') && final_path.chars().nth(2) == Some(':') {
                final_path.remove(0);
            }
            let is_full = uri.query().map(|q| q.contains("full=true")).unwrap_or(false);
            
            let path = Path::new(&final_path);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            
            let is_video = ext == "mp4" || ext == "mov" || ext == "avi" || ext == "mkv";
            
            let mut mime = mime_guess::from_path(&final_path)
                .first_or_octet_stream()
                .to_string();

            // Handle range requests for video streaming / partial content
            let range_header = request.headers().get("range").and_then(|h| h.to_str().ok());
            let mut range_start = None;
            let mut range_end = None;
            if let Some(range_str) = range_header {
                if range_str.starts_with("bytes=") {
                    let parts: Vec<&str> = range_str["bytes=".len()..].split('-').collect();
                    if !parts.is_empty() {
                        if let Ok(start) = parts[0].trim().parse::<u64>() {
                            range_start = Some(start);
                        }
                    }
                    if parts.len() > 1 && !parts[1].trim().is_empty() {
                        if let Ok(end) = parts[1].trim().parse::<u64>() {
                            range_end = Some(end);
                        }
                    }
                }
            } else if is_video {
                // If it's a video file, default to starting from 0 to trigger chunked responses
                range_start = Some(0);
            }

            if let Some(start) = range_start {
                let file_size = fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
                if start >= file_size {
                    return tauri::http::Response::builder()
                        .status(416) // Range Not Satisfiable
                        .header("Content-Range", format!("bytes */{}", file_size))
                        .body(Vec::new())
                        .unwrap();
                }

                let end = range_end.unwrap_or(file_size.saturating_sub(1)).min(file_size.saturating_sub(1));
                let max_chunk = 4 * 1024 * 1024; // Stream in 4MB chunks
                let chunk_size = ((end - start + 1) as usize).min(max_chunk);

                use std::io::{Seek, SeekFrom, Read};
                let mut file = match fs::File::open(&final_path) {
                    Ok(f) => f,
                    Err(_) => {
                        return tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new())
                            .unwrap();
                    }
                };

                if file.seek(SeekFrom::Start(start)).is_ok() {
                    let mut chunk = vec![0u8; chunk_size];
                    let mut bytes_read = 0;
                    if let Ok(n) = file.take(chunk_size as u64).read(&mut chunk) {
                        bytes_read = n;
                    }
                    chunk.truncate(bytes_read);

                    let actual_end = start + bytes_read as u64 - 1;
                    return tauri::http::Response::builder()
                        .status(206) // Partial Content
                        .header("Content-Type", mime)
                        .header("Accept-Ranges", "bytes")
                        .header("Content-Range", format!("bytes {}-{}/{}", start, actual_end, file_size))
                        .header("Content-Length", bytes_read.to_string())
                        .header("Access-Control-Allow-Origin", "*")
                        .body(chunk)
                        .unwrap();
                }
            }

            let mut file_data = None;
            
            // Try to extract embedded JPEG preview for RAW/JPG files to drastically reduce SD card reads.
            // If full=true is requested, we bypass thumbnail extraction for native images to load the full file.
            let is_native_image = ext == "jpg" || ext == "jpeg" || ext == "webp";
            let should_extract_thumbnail = if is_full && is_native_image {
                false
            } else {
                ext == "arw" || ext == "nef" || ext == "cr2" || ext == "dng" || ext == "cr3" || ext == "raf" || ext == "orf" || ext == "rw2" || ext == "pef" || is_native_image
            };

            if should_extract_thumbnail {
                let thumb_bytes = if ext == "cr3" {
                    get_cr3_thumbnail(path)
                } else if ext == "raf" {
                    get_raf_thumbnail(path)
                } else {
                    get_embedded_jpeg(path)
                };

                if let Some(bytes) = thumb_bytes {
                    file_data = Some(bytes);
                    mime = "image/jpeg".to_string();
                }
            }

            let is_raw = ext == "arw" || ext == "nef" || ext == "cr2" || ext == "dng" || ext == "cr3" || ext == "raf" || ext == "orf" || ext == "rw2" || ext == "pef";

            let bytes = match file_data {
                Some(data) => data,
                None => {
                    if is_raw {
                        eprintln!("Aucun aperçu JPEG trouvé dans le fichier RAW : {}", final_path);
                        return tauri::http::Response::builder()
                            .status(404)
                            .body(Vec::new())
                            .unwrap();
                    }
                    match fs::read(&final_path) {
                        Ok(data) => data,
                        Err(e) => {
                            eprintln!("Failed to read asset path {}: {:?}", final_path, e);
                            return tauri::http::Response::builder()
                                .status(404)
                                .body(Vec::new())
                                .unwrap();
                        }
                    }
                }
            };
            
            tauri::http::Response::builder()
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![scan_source, start_import, select_folder, get_app_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
