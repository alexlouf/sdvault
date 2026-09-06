#[test]
fn test_encode_decode_path() {
    const FRAGMENT: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS
        .add(b' ')
        .add(b'"')
        .add(b'<')
        .add(b'>')
        .add(b'`')
        .add(b'#')
        .add(b'?')
        .add(b'{')
        .add(b'}')
        .add(b'%');

    let raw_path = "/home/alouf/Photos/2026-08-16 - Séance photo #1 & test 100%/jpg/DSC0001.JPG";
    let encoded = percent_encoding::utf8_percent_encode(raw_path, FRAGMENT).to_string();
    assert!(!encoded.contains('#'), "Encoded string must not contain literal #");
    assert!(!encoded.contains(' '), "Encoded string must not contain literal spaces");
    assert!(!encoded.contains('?'), "Encoded string must not contain literal ?");

    let decoded = percent_encoding::percent_decode_str(&encoded).decode_utf8_lossy();
    assert_eq!(decoded, raw_path);
}

// Function to generate a minimal valid JPEG image bytes
fn make_minimal_jpeg(width: u16, height: u16) -> Vec<u8> {
    let mut jpeg = Vec::new();
    jpeg.extend_from_slice(&[0xFF, 0xD8]); // SOI
    jpeg.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x10]); // APP0 marker + length 16
    jpeg.extend_from_slice(b"JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    // SOF0 marker
    let w_bytes = width.to_be_bytes();
    let h_bytes = height.to_be_bytes();
    jpeg.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x0B, 0x08, h_bytes[0], h_bytes[1], w_bytes[0], w_bytes[1], 0x01, 0x01, 0x11, 0x00]);
    // SOS marker
    jpeg.extend_from_slice(&[0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00]);
    jpeg.extend_from_slice(&[0x00, 0x00]); // scan data
    jpeg.extend_from_slice(&[0xFF, 0xD9]); // EOI
    jpeg
}

// Function to construct a mock TIFF file with embedded JPEG in StripOffsets
fn make_mock_tiff_raw(jpeg_data: &[u8]) -> Vec<u8> {
    let mut tiff = Vec::new();
    // Header
    tiff.extend_from_slice(&[0x49, 0x49, 0x2A, 0x00]); // "II" + 42
    tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at offset 8

    // IFD0 at offset 8:
    // 2 entries
    let num_entries = 2u16;
    tiff.extend_from_slice(&num_entries.to_le_bytes());

    let jpeg_offset = (8 + 2 + 12 * 2 + 4) as u32; // after header + IFD0
    let jpeg_len = jpeg_data.len() as u32;

    // Entry 1: StripOffsets (0x0111)
    tiff.extend_from_slice(&0x0111u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes()); // LONG
    tiff.extend_from_slice(&1u32.to_le_bytes()); // count 1
    tiff.extend_from_slice(&jpeg_offset.to_le_bytes());

    // Entry 2: StripByteCounts (0x0117)
    tiff.extend_from_slice(&0x0117u16.to_le_bytes());
    tiff.extend_from_slice(&4u16.to_le_bytes()); // LONG
    tiff.extend_from_slice(&1u32.to_le_bytes()); // count 1
    tiff.extend_from_slice(&jpeg_len.to_le_bytes());

    // Next IFD offset: 0
    tiff.extend_from_slice(&0u32.to_le_bytes());

    // Append JPEG data at jpeg_offset
    tiff.extend_from_slice(jpeg_data);
    tiff
}

#[test]
fn test_mock_tiff_raw_extraction() {
    let temp_dir = std::env::temp_dir();
    let raw_file_path = temp_dir.join("test_camera.arw");

    let original_jpeg = make_minimal_jpeg(320, 240);
    let raw_bytes = make_mock_tiff_raw(&original_jpeg);
    std::fs::write(&raw_file_path, raw_bytes).unwrap();

    // 1. Test thumbnail mode (high_res = false)
    let thumb_extracted = sd_vault_lib::get_embedded_jpeg(&raw_file_path, false);
    assert!(thumb_extracted.is_some(), "Embedded thumbnail MUST be extracted in thumbnail mode (high_res = false)");
    let thumb_bytes = thumb_extracted.unwrap();
    assert_eq!(&thumb_bytes[0..2], &[0xFF, 0xD8], "Thumbnail must be valid JPEG SOI");

    // 2. Test fullscreen mode (high_res = true)
    let full_extracted = sd_vault_lib::get_embedded_jpeg(&raw_file_path, true);
    assert!(full_extracted.is_some(), "Embedded JPEG MUST be extracted in fullscreen mode (high_res = true)");
    let full_bytes = full_extracted.unwrap();
    assert_eq!(&full_bytes[0..2], &[0xFF, 0xD8], "Fullscreen preview must be valid JPEG SOI");

    let _ = std::fs::remove_file(&raw_file_path);
}

#[test]
fn test_raw_scan_fallback_without_exif_tags() {
    let temp_dir = std::env::temp_dir();
    let raw_file_path = temp_dir.join("test_scan_camera.nef");

    // Create a dummy RAW file containing junk bytes followed by a valid embedded JPEG
    let mut raw_data = vec![0x12u8, 0x34, 0x56, 0x78].repeat(1000); // 4000 junk bytes
    let original_jpeg = make_minimal_jpeg(640, 480);
    raw_data.extend_from_slice(&original_jpeg);
    raw_data.extend_from_slice(&[0x99; 500]); // trailing bytes

    std::fs::write(&raw_file_path, raw_data).unwrap();

    // 1. Test thumbnail extraction via scan fallback
    let thumb = sd_vault_lib::get_embedded_jpeg(&raw_file_path, false);
    assert!(thumb.is_some(), "Fallback scan MUST extract thumbnail even without EXIF tags");
    assert_eq!(&thumb.unwrap()[0..2], &[0xFF, 0xD8]);

    // 2. Test fullscreen extraction via scan fallback
    let full = sd_vault_lib::get_embedded_jpeg(&raw_file_path, true);
    assert!(full.is_some(), "Fallback scan MUST extract preview even without EXIF tags");
    assert_eq!(&full.unwrap()[0..2], &[0xFF, 0xD8]);

    let _ = std::fs::remove_file(&raw_file_path);
}

#[test]
fn test_path_normalization() {
    // Windows drive letter paths with spaces, hashtags, accents
    assert_eq!(
        sd_vault_lib::normalize_asset_path("/C:/Photos/2026-08-16 - Suffix/jpg/DSC0001.JPG"),
        "C:/Photos/2026-08-16 - Suffix/jpg/DSC0001.JPG"
    );
    assert_eq!(
        sd_vault_lib::normalize_asset_path("/D:/Photos/2026-08-16%20-%20S%C3%A9ance%20photo%20%231/raw/DSC0001.ARW"),
        "D:/Photos/2026-08-16 - Séance photo #1/raw/DSC0001.ARW"
    );

    // Unix / Linux paths (double-slashed from custom scheme or single-slashed)
    assert_eq!(
        sd_vault_lib::normalize_asset_path("//home/alouf/Photos/2026-08-16 - Suffix/jpg/DSC0001.JPG"),
        "/home/alouf/Photos/2026-08-16 - Suffix/jpg/DSC0001.JPG"
    );
    assert_eq!(
        sd_vault_lib::normalize_asset_path("/home/alouf/Photos/2026-08-16%20-%20S%C3%A9ance%20photo%20%231/raw/DSC0001.ARW"),
        "/home/alouf/Photos/2026-08-16 - Séance photo #1/raw/DSC0001.ARW"
    );
}

#[test]
fn test_build_asset_url() {
    let raw_path = "/home/alouf/Photos/2026-08-16 - Séance photo #1 & 100%/jpg/DSC0001.JPG";
    let url = sd_vault_lib::build_asset_url(raw_path);
    // Ensure URL has no unencoded spaces or hashtag fragment delimiters
    assert!(!url.contains('#'), "URL should not contain literal #");
    assert!(!url.contains(' '), "URL should not contain literal spaces");
    assert!(!url.contains("://localhost//"), "URL should not have double slashes after host");

    // Simulating browser requesting url.pathname:
    // When browser requests this URL, Tauri gets the path component.
    // Let's verify normalize_asset_path recovers the original path!
    let pathname = if url.starts_with("vault-asset://localhost/") {
        &url["vault-asset://localhost".len()..]
    } else {
        &url
    };
    let restored = sd_vault_lib::normalize_asset_path(pathname);
    assert_eq!(restored, raw_path);
}


