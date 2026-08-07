// Check if we are running in Tauri or a standard web browser
const isTauri = typeof window !== 'undefined' && window.__TAURI__ !== undefined;

let invoke;
if (isTauri) {
  invoke = window.__TAURI__.core.invoke;
}

// ----------------------------------------------------
// Application State
// ----------------------------------------------------
let scannedDays = {};      // { [date]: MediaFile[] }
let selectedFiles = new Set(); // Set of absolute file paths
let favoriteFiles = new Set(); // Set of absolute file paths
let daySuffixes = {};      // { [date]: string }
let deleteSourceAfterImport = false; // Toggle for Copy (false) vs Cut (true)

// ----------------------------------------------------
// UI Elements
// ----------------------------------------------------
let elSourcePath, elDestPath, elBtnScan, elBtnImport, elTimelineArea;
let elEmptyState, elScanLoader, elTxtSummary;
let elModalImport, elModalTitle, elImportProgressView, elImportProgressFill;
let elImportStatusText, elImportReportView, elBtnModalClose;
let elStatCopied, elStatFavs, elStatSaved;
let elBtnSelectSource, elBtnSelectDest;
let elTimelineControls, elBtnSelectAll, elBtnDeselectAll;
let elBtnModeCopy, elBtnModeCut, elBtnGlobalBoth, elBtnGlobalJpg;
let elModalLightbox, elLightboxImg, elLightboxVideo, elLightboxStackControl;
let elLightboxFilename, elLightboxDetails;
let elBtnLightboxClose, elBtnLightboxPrev, elBtnLightboxNext;
let elBtnLightboxSelect, elBtnLightboxStar;
let lightboxItems = [];
let lightboxIndex = -1;
let stackModes = {}; // { [baseKey]: 'both' | 'jpg' }

// Initialize Lucide icons
function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Format bytes into human-readable size
function formatBytes(bytes, decimals = 1) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Get modern mock data for web simulation
function getMockData() {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const prevDay = new Date(Date.now() - 172800000).toISOString().split('T')[0];

  return {
    [today]: [
      {
        path: `C:/MockSD/DCIM/DSC01928.ARW`,
        name: "DSC01928.ARW",
        size: 44040192,
        file_type: "raw",
        date: today,
        thumbnail_url: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/DSC01928.JPG`,
        name: "DSC01928.JPG",
        size: 8388608,
        file_type: "jpg",
        date: today,
        thumbnail_url: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/DSC01929.ARW`,
        name: "DSC01929.ARW",
        size: 42991616,
        file_type: "raw",
        date: today,
        thumbnail_url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/DSC01929.JPG`,
        name: "DSC01929.JPG",
        size: 7130316,
        file_type: "jpg",
        date: today,
        thumbnail_url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/MV00102.MP4`,
        name: "MV00102.MP4",
        size: 335544320,
        file_type: "video",
        date: today,
        thumbnail_url: ""
      }
    ],
    [yesterday]: [
      {
        path: `C:/MockSD/DCIM/DSC01920.ARW`,
        name: "DSC01920.ARW",
        size: 45097152,
        file_type: "raw",
        date: yesterday,
        thumbnail_url: "https://images.unsplash.com/photo-1682687220063-4742bd7fd538?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/DSC01920.JPG`,
        name: "DSC01920.JPG",
        size: 8178892,
        file_type: "jpg",
        date: yesterday,
        thumbnail_url: "https://images.unsplash.com/photo-1682687220063-4742bd7fd538?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/MV00101.MP4`,
        name: "MV00101.MP4",
        size: 188743680,
        file_type: "video",
        date: yesterday,
        thumbnail_url: ""
      }
    ],
    [prevDay]: [
      {
        path: `C:/MockSD/DCIM/DSC01910.ARW`,
        name: "DSC01910.ARW",
        size: 43620761,
        file_type: "raw",
        date: prevDay,
        thumbnail_url: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=400&q=80"
      },
      {
        path: `C:/MockSD/DCIM/DSC01910.JPG`,
        name: "DSC01910.JPG",
        size: 7864320,
        file_type: "jpg",
        date: prevDay,
        thumbnail_url: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=400&q=80"
      }
    ]
  };
}

// ----------------------------------------------------
// UI Logic & Renderers
// ----------------------------------------------------

// Render timeline grid based on scannedDays
function renderTimeline() {
  elTimelineArea.innerHTML = '';
  const dates = Object.keys(scannedDays).sort((a, b) => b.localeCompare(a));

  if (dates.length === 0) {
    elEmptyState.classList.remove('hidden');
    elTimelineArea.classList.add('hidden');
    elTimelineControls.classList.add('hidden');
    return;
  }

  elEmptyState.classList.add('hidden');
  elTimelineArea.classList.remove('hidden');
  elTimelineControls.classList.remove('hidden');

  dates.forEach(date => {
    const files = scannedDays[date];
    const dayBlock = document.createElement('div');
    dayBlock.className = 'day-block card';
    dayBlock.dataset.date = date;

    // Suffix init
    if (!daySuffixes[date]) daySuffixes[date] = "";

    // Count types
    const jpgs = files.filter(f => f.file_type === 'jpg').length;
    const raws = files.filter(f => f.file_type === 'raw').length;
    const videos = files.filter(f => f.file_type === 'video').length;
    
    let summaryText = [];
    if (jpgs > 0) summaryText.push(`${jpgs} JPG`);
    if (raws > 0) summaryText.push(`${raws} RAW`);
    if (videos > 0) summaryText.push(`${videos} Vidéo${videos > 1 ? 's' : ''}`);

    // Group files by base name to evaluate if all visual items are selected
    const renderGroupedByBase = {};
    files.forEach(file => {
      const dotIndex = file.name.lastIndexOf('.');
      const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
      const baseKey = baseName.toLowerCase();
      if (!renderGroupedByBase[baseKey]) renderGroupedByBase[baseKey] = [];
      renderGroupedByBase[baseKey].push(file);
    });

    const isAllDaySelected = Object.values(renderGroupedByBase).every(group => {
      if (group.length === 2) {
        const rawFile = group.find(f => f.file_type === 'raw');
        const jpgFile = group.find(f => f.file_type === 'jpg');
        if (rawFile && jpgFile) {
          return selectedFiles.has(jpgFile.path);
        }
      }
      return group.every(f => selectedFiles.has(f.path));
    });

    const dayHasStacks = Object.values(renderGroupedByBase).some(group => {
      return group.length === 2 && group.some(f => f.file_type === 'raw') && group.some(f => f.file_type === 'jpg');
    });

    let dayStackToggleHTML = '';
    if (dayHasStacks) {
      dayStackToggleHTML = `
        <div class="day-stack-toggle">
          <span>Piles :</span>
          <button class="btn-day-mode" data-mode="both" title="Mettre toutes les photos de ce jour en RAW+JPG"><i data-lucide="layers"></i> RAW+JPG</button>
          <button class="btn-day-mode" data-mode="jpg" title="Mettre toutes les photos de ce jour en JPG seul"><i data-lucide="file-image"></i> JPG seul</button>
        </div>
      `;
    }

    dayBlock.innerHTML = `
      <div class="day-header">
        <div class="day-info">
          <input type="checkbox" class="day-checkbox" ${isAllDaySelected ? 'checked' : ''} />
          <span class="day-title">${date}</span>
          <span class="day-summary-badge">${summaryText.join(', ')}</span>
        </div>
        <div class="day-actions">
          ${dayStackToggleHTML}
          <div class="suffix-input-group">
            <span>Suffixe :</span>
            <input type="text" class="day-suffix-input" placeholder="Ex: Match_Badminton" value="${daySuffixes[date]}" />
          </div>
        </div>
      </div>
      <div class="media-grid">
        <!-- Files dynamic injection -->
      </div>
    `;

    const grid = dayBlock.querySelector('.media-grid');

    // Group files by base name (case-insensitive) to create RAW+JPEG stacks
    const groupedByBase = {};
    files.forEach(file => {
      const dotIndex = file.name.lastIndexOf('.');
      const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
      const baseKey = baseName.toLowerCase();
      
      if (!groupedByBase[baseKey]) {
        groupedByBase[baseKey] = [];
      }
      groupedByBase[baseKey].push(file);
    });

    const stacks = [];
    Object.values(groupedByBase).forEach(group => {
      if (group.length === 2) {
        const rawFile = group.find(f => f.file_type === 'raw');
        const jpgFile = group.find(f => f.file_type === 'jpg');
        if (rawFile && jpgFile) {
          const dotIdx = jpgFile.name.lastIndexOf('.');
          const bName = dotIdx !== -1 ? jpgFile.name.substring(0, dotIdx) : jpgFile.name;
          stacks.push({
            type: 'stack',
            name: `${bName} (RAW+JPG)`,
            files: [rawFile, jpgFile],
            rawFile,
            jpgFile,
            file_type: 'raw+jpg',
            size: rawFile.size + jpgFile.size,
            date: jpgFile.date,
            thumbnail_url: jpgFile.thumbnail_url || rawFile.thumbnail_url
          });
          return;
        }
      }
      
      group.forEach(file => {
        stacks.push({
          type: 'single',
          name: file.name,
          files: [file],
          file_type: file.file_type,
          size: file.size,
          date: file.date,
          thumbnail_url: file.thumbnail_url
        });
      });
    });

    stacks.forEach(item => {
      const isSelected = item.type === 'stack' 
        ? selectedFiles.has(item.jpgFile.path) 
        : selectedFiles.has(item.files[0].path);
      const isStarred = item.type === 'stack'
        ? favoriteFiles.has(item.jpgFile.path)
        : favoriteFiles.has(item.files[0].path);

      const card = document.createElement('div');
      card.className = `file-card ${isSelected ? 'selected' : ''} ${item.type === 'stack' ? 'card-stacked' : ''}`;
      card.dataset.path = item.type === 'stack' ? item.jpgFile.path : item.files[0].path;
      
      let previewHTML = '';
      if (item.file_type === 'video') {
        previewHTML = `
          <div class="media-placeholder">
            <i data-lucide="video"></i>
            <span>Vidéo</span>
          </div>
        `;
      } else if (item.thumbnail_url) {
        previewHTML = `<img src="${item.thumbnail_url}" class="media-preview" alt="${item.name}" loading="lazy" />`;
      } else {
        previewHTML = `
          <div class="media-placeholder">
            <i data-lucide="image"></i>
            <span>Image</span>
          </div>
        `;
      }

      let displaySize = item.size;
      let displayBadgeType = item.file_type;
      let modePillHTML = '';

      if (item.type === 'stack') {
        const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
        const mode = stackModes[baseKey] || 'both';
        if (mode === 'jpg') {
          displaySize = item.jpgFile.size;
          displayBadgeType = 'jpg';
        }
        
        modePillHTML = `
          <div class="stack-mode-pill" data-basekey="${baseKey}">
            <span class="mode-opt ${mode === 'both' ? 'active' : ''}" data-mode="both" title="Importer RAW + JPG">RAW+JPG</span>
            <span class="mode-opt ${mode === 'jpg' ? 'active' : ''}" data-mode="jpg" title="Importer JPEG seul">JPG</span>
          </div>
        `;
      }

      card.innerHTML = `
        ${previewHTML}
        <span class="type-badge badge-${displayBadgeType.replace('+', '-')}">${displayBadgeType}</span>
        <div class="card-overlay">
          <div class="overlay-top">
            <input type="checkbox" class="item-checkbox" ${isSelected ? 'checked' : ''} />
            <div style="display: flex; gap: 8px; align-items: center;">
              <button class="btn-preview-zoom" title="Agrandir (Double-clic)">
                <i data-lucide="eye"></i>
              </button>
              <button class="btn-star ${isStarred ? 'starred' : ''}">
                <i data-lucide="star"></i>
              </button>
            </div>
          </div>
          <div class="overlay-bottom">
            <span class="file-name" title="${item.name}">${item.name}</span>
            <div class="stack-row">
              <span class="file-size">${formatBytes(displaySize)}</span>
              ${modePillHTML}
            </div>
          </div>
        </div>
      `;

      // Event handlers on File Card
      card.addEventListener('click', (e) => {
        if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.stack-mode-pill')) return;
        toggleItemSelection(item, card);
      });

      // Double click card opens lightbox
      card.addEventListener('dblclick', () => {
        lightboxItems = getTimelineItems();
        const currentIdx = lightboxItems.findIndex(x => x.files.some(f => item.files.some(i => i.path === f.path)));
        openLightbox(currentIdx);
      });

      card.querySelector('.item-checkbox').addEventListener('change', () => {
        toggleItemSelection(item, card);
      });

      card.querySelector('.btn-star').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleItemFavorite(item, card.querySelector('.btn-star'));
      });

      card.querySelector('.btn-preview-zoom').addEventListener('click', (e) => {
        e.stopPropagation();
        lightboxItems = getTimelineItems();
        const currentIdx = lightboxItems.findIndex(x => x.files.some(f => item.files.some(i => i.path === f.path)));
        openLightbox(currentIdx);
      });

      if (item.type === 'stack') {
        card.querySelectorAll('.stack-mode-pill .mode-opt').forEach(opt => {
          opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const baseKey = opt.closest('.stack-mode-pill').dataset.basekey;
            const mode = opt.dataset.mode;
            setStackMode(baseKey, mode);
          });
        });
      }

      grid.appendChild(card);
    });

    // Event handlers on Day Block Header
    dayBlock.querySelector('.day-checkbox').addEventListener('change', (e) => {
      selectDayFiles(date, e.target.checked);
    });

    dayBlock.querySelector('.day-suffix-input').addEventListener('input', (e) => {
      daySuffixes[date] = e.target.value;
    });

    if (dayHasStacks) {
      dayBlock.querySelectorAll('.btn-day-mode').forEach(btn => {
        btn.addEventListener('click', () => {
          setDayStackMode(date, btn.dataset.mode);
        });
      });
    }

    elTimelineArea.appendChild(dayBlock);
  });

  refreshIcons();
}

// Select/Deselect files for a specific day block, respecting stack modes
function selectDayFiles(date, checked) {
  const files = scannedDays[date];
  const groupedByBase = {};
  
  files.forEach(file => {
    const dotIndex = file.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const baseKey = baseName.toLowerCase();
    if (!groupedByBase[baseKey]) groupedByBase[baseKey] = [];
    groupedByBase[baseKey].push(file);
  });
  
  Object.values(groupedByBase).forEach(group => {
    if (group.length === 2) {
      const rawFile = group.find(f => f.file_type === 'raw');
      const jpgFile = group.find(f => f.file_type === 'jpg');
      if (rawFile && jpgFile) {
        const baseKey = jpgFile.name.substring(0, jpgFile.name.lastIndexOf('.')).toLowerCase();
        if (checked) {
          const mode = stackModes[baseKey] || 'both';
          selectedFiles.add(jpgFile.path);
          if (mode === 'both') {
            selectedFiles.add(rawFile.path);
          } else {
            selectedFiles.delete(rawFile.path);
          }
        } else {
          selectedFiles.delete(jpgFile.path);
          selectedFiles.delete(rawFile.path);
        }
        return;
      }
    }
    
    group.forEach(file => {
      if (checked) {
        selectedFiles.add(file.path);
      } else {
        selectedFiles.delete(file.path);
      }
    });
  });
  
  renderTimeline();
  updateSummary();
}

// Toggle stack mode: both (RAW+JPG) or jpg (JPG only)
function setStackMode(baseKey, mode) {
  stackModes[baseKey] = mode;
  
  let rawFile = null;
  let jpgFile = null;
  
  for (const date of Object.keys(scannedDays)) {
    const files = scannedDays[date];
    const match = files.filter(f => {
      const dotIndex = f.name.lastIndexOf('.');
      const bName = dotIndex !== -1 ? f.name.substring(0, dotIndex) : f.name;
      return bName.toLowerCase() === baseKey;
    });
    if (match.length === 2) {
      rawFile = match.find(f => f.file_type === 'raw');
      jpgFile = match.find(f => f.file_type === 'jpg');
      break;
    }
  }
  
  if (rawFile && jpgFile) {
    const isSelected = selectedFiles.has(jpgFile.path) || selectedFiles.has(rawFile.path);
    if (isSelected) {
      if (mode === 'jpg') {
        selectedFiles.delete(rawFile.path);
        selectedFiles.add(jpgFile.path);
      } else {
        selectedFiles.add(rawFile.path);
        selectedFiles.add(jpgFile.path);
      }
    }
  }
  
  renderTimeline();
  updateSummary();
}

// Toggle global stack mode: both (RAW+JPG) or jpg (JPG only) for all stacked items
function setGlobalStackMode(mode) {
  Object.keys(scannedDays).forEach(date => {
    const files = scannedDays[date];
    const groupedByBase = {};
    files.forEach(f => {
      const dotIndex = f.name.lastIndexOf('.');
      const baseName = dotIndex !== -1 ? f.name.substring(0, dotIndex) : f.name;
      const baseKey = baseName.toLowerCase();
      if (!groupedByBase[baseKey]) groupedByBase[baseKey] = [];
      groupedByBase[baseKey].push(f);
    });

    Object.values(groupedByBase).forEach(group => {
      if (group.length === 2) {
        const rawFile = group.find(f => f.file_type === 'raw');
        const jpgFile = group.find(f => f.file_type === 'jpg');
        if (rawFile && jpgFile) {
          const baseKey = jpgFile.name.substring(0, jpgFile.name.lastIndexOf('.')).toLowerCase();
          stackModes[baseKey] = mode;
          const isSelected = selectedFiles.has(jpgFile.path) || selectedFiles.has(rawFile.path);
          if (isSelected) {
            if (mode === 'jpg') {
              selectedFiles.delete(rawFile.path);
              selectedFiles.add(jpgFile.path);
            } else {
              selectedFiles.add(rawFile.path);
              selectedFiles.add(jpgFile.path);
            }
          }
        }
      }
    });
  });

  renderTimeline();
  updateSummary();
}

// Toggle day stack mode: both (RAW+JPG) or jpg (JPG only) for stacked items of a specific day
function setDayStackMode(date, mode) {
  const files = scannedDays[date];
  const groupedByBase = {};
  files.forEach(f => {
    const dotIndex = f.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? f.name.substring(0, dotIndex) : f.name;
    const baseKey = baseName.toLowerCase();
    if (!groupedByBase[baseKey]) groupedByBase[baseKey] = [];
    groupedByBase[baseKey].push(f);
  });

  Object.values(groupedByBase).forEach(group => {
    if (group.length === 2) {
      const rawFile = group.find(f => f.file_type === 'raw');
      const jpgFile = group.find(f => f.file_type === 'jpg');
      if (rawFile && jpgFile) {
        const baseKey = jpgFile.name.substring(0, jpgFile.name.lastIndexOf('.')).toLowerCase();
        stackModes[baseKey] = mode;
        const isSelected = selectedFiles.has(jpgFile.path) || selectedFiles.has(rawFile.path);
        if (isSelected) {
          if (mode === 'jpg') {
            selectedFiles.delete(rawFile.path);
            selectedFiles.add(jpgFile.path);
          } else {
            selectedFiles.add(rawFile.path);
            selectedFiles.add(jpgFile.path);
          }
        }
      }
    }
  });

  renderTimeline();
  updateSummary();
}

// Toggle item selection (stack or single)
function toggleItemSelection(item, cardEl) {
  const isSelected = item.type === 'stack' 
    ? selectedFiles.has(item.jpgFile.path) 
    : selectedFiles.has(item.files[0].path);
    
  item.files.forEach(f => {
    selectedFiles.delete(f.path);
  });

  const newSelectedState = !isSelected;
  if (newSelectedState) {
    if (item.type === 'stack') {
      const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
      const mode = stackModes[baseKey] || 'both';
      if (mode === 'jpg') {
        selectedFiles.add(item.jpgFile.path);
      } else {
        selectedFiles.add(item.jpgFile.path);
        selectedFiles.add(item.rawFile.path);
      }
    } else {
      selectedFiles.add(item.files[0].path);
    }
    cardEl.classList.add('selected');
    cardEl.querySelector('.item-checkbox').checked = true;
  } else {
    cardEl.classList.remove('selected');
    cardEl.querySelector('.item-checkbox').checked = false;
  }

  updateDayHeaderSelectionState(cardEl.closest('.day-block'));
  updateSummary();
}

// Update day header checkbox based on children states
function updateDayHeaderSelectionState(dayBlockEl) {
  const date = dayBlockEl.dataset.date;
  const files = scannedDays[date];
  const dayCheckbox = dayBlockEl.querySelector('.day-checkbox');
  
  // Group files by base name to match visual items
  const groupedByBase = {};
  files.forEach(file => {
    const dotIndex = file.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const baseKey = baseName.toLowerCase();
    if (!groupedByBase[baseKey]) groupedByBase[baseKey] = [];
    groupedByBase[baseKey].push(file);
  });

  const isAllSelected = Object.values(groupedByBase).every(group => {
    if (group.length === 2) {
      const rawFile = group.find(f => f.file_type === 'raw');
      const jpgFile = group.find(f => f.file_type === 'jpg');
      if (rawFile && jpgFile) {
        return selectedFiles.has(jpgFile.path);
      }
    }
    return group.every(f => selectedFiles.has(f.path));
  });

  dayCheckbox.checked = isAllSelected;
}

// Toggle item favorite state (star icon)
function toggleItemFavorite(item, starBtnEl) {
  const isStarred = item.type === 'stack'
    ? favoriteFiles.has(item.jpgFile.path)
    : favoriteFiles.has(item.files[0].path);

  item.files.forEach(f => {
    if (isStarred) {
      favoriteFiles.delete(f.path);
    } else {
      favoriteFiles.add(f.path);
    }
  });

  const newStarredState = !isStarred;
  if (newStarredState) {
    starBtnEl.classList.add('starred');
    
    // Auto-select when starring (workflow shortcut)
    const cardEl = starBtnEl.closest('.file-card');
    const isSelected = item.type === 'stack'
      ? selectedFiles.has(item.jpgFile.path)
      : selectedFiles.has(item.files[0].path);
    if (!isSelected) {
      toggleItemSelection(item, cardEl);
    }
  } else {
    starBtnEl.classList.remove('starred');
  }
}

// Compile a flat ordered array of all items in the timeline
function getTimelineItems() {
  const dates = Object.keys(scannedDays).sort((a, b) => b.localeCompare(a));
  const allItems = [];
  dates.forEach(date => {
    const files = scannedDays[date];
    const groupedByBase = {};
    files.forEach(file => {
      const dotIndex = file.name.lastIndexOf('.');
      const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
      const baseKey = baseName.toLowerCase();
      
      if (!groupedByBase[baseKey]) {
        groupedByBase[baseKey] = [];
      }
      groupedByBase[baseKey].push(file);
    });

    Object.values(groupedByBase).forEach(group => {
      if (group.length === 2) {
        const rawFile = group.find(f => f.file_type === 'raw');
        const jpgFile = group.find(f => f.file_type === 'jpg');
        if (rawFile && jpgFile) {
          const dotIdx = jpgFile.name.lastIndexOf('.');
          const bName = dotIdx !== -1 ? jpgFile.name.substring(0, dotIdx) : jpgFile.name;
          allItems.push({
            type: 'stack',
            name: `${bName} (RAW+JPG)`,
            files: [rawFile, jpgFile],
            rawFile,
            jpgFile,
            file_type: 'raw+jpg',
            size: rawFile.size + jpgFile.size,
            date: jpgFile.date,
            thumbnail_url: jpgFile.thumbnail_url || rawFile.thumbnail_url
          });
          return;
        }
      }
      
      group.forEach(file => {
        allItems.push({
          type: 'single',
          name: file.name,
          files: [file],
          file_type: file.file_type,
          size: file.size,
          date: file.date,
          thumbnail_url: file.thumbnail_url
        });
      });
    });
  });
  return allItems;
}

// Open Lightbox for an item index
function openLightbox(index) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const item = lightboxItems[index];

  // Clear previous state
  elLightboxImg.classList.add("hidden");
  elLightboxVideo.classList.add("hidden");
  elLightboxVideo.pause();
  elLightboxVideo.src = "";
  
  if (item.file_type === 'video') {
    const videoUrl = isTauri 
      ? `http://vault-asset.localhost/${item.files[0].path}` 
      : item.files[0].path;
    elLightboxVideo.src = videoUrl;
    elLightboxVideo.classList.remove("hidden");
  } else if (item.thumbnail_url) {
    elLightboxImg.src = `${item.thumbnail_url}?full=true`;
    elLightboxImg.classList.remove("hidden");
  }

  elLightboxFilename.textContent = item.name;
  
  let displaySize = item.size;
  let activeExtensions = item.files.map(f => f.name.split('.').pop().toUpperCase()).join("+");
  
  if (item.type === 'stack') {
    elLightboxStackControl.classList.remove("hidden");
    const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
    const mode = stackModes[baseKey] || 'both';
    
    elLightboxStackControl.querySelectorAll('.mode-opt').forEach(opt => {
      opt.classList.toggle("active", opt.dataset.mode === mode);
    });
    
    if (mode === 'jpg') {
      displaySize = item.jpgFile.size;
      activeExtensions = 'JPG';
    }
  } else {
    elLightboxStackControl.classList.add("hidden");
  }
  
  elLightboxDetails.textContent = `${activeExtensions} — ${formatBytes(displaySize)} — ${item.date}`;

  // Toggle navigation controls visibility
  elBtnLightboxPrev.style.display = index === 0 ? "none" : "flex";
  elBtnLightboxNext.style.display = index === lightboxItems.length - 1 ? "none" : "flex";

  elModalLightbox.classList.remove("hidden");
  updateLightboxSelectionVisuals(item);
  updateLightboxFavoriteVisuals(item);
  refreshIcons();
}

// Close Lightbox
function closeLightbox() {
  elModalLightbox.classList.add("hidden");
  elLightboxImg.src = "";
  elLightboxVideo.pause();
  elLightboxVideo.src = "";
}

// Navigate Lightbox previous / next
function navigateLightbox(direction) {
  const newIdx = lightboxIndex + direction;
  if (newIdx >= 0 && newIdx < lightboxItems.length) {
    openLightbox(newIdx);
  }
}

// Update the footer text summary and Import Button states
function updateSummary() {
  if (selectedFiles.size === 0) {
    elTxtSummary.textContent = "Aucun fichier sélectionné";
    elBtnImport.disabled = true;
    return;
  }

  let totalSize = 0;
  let countJpg = 0;
  let countRaw = 0;
  let countVid = 0;

  Object.values(scannedDays).flat().forEach(file => {
    if (selectedFiles.has(file.path)) {
      totalSize += file.size;
      if (file.file_type === 'jpg') countJpg++;
      else if (file.file_type === 'raw') countRaw++;
      else if (file.file_type === 'video') countVid++;
    }
  });

  let parts = [];
  if (countJpg > 0) parts.push(`${countJpg} JPG`);
  if (countRaw > 0) parts.push(`${countRaw} RAW`);
  if (countVid > 0) parts.push(`${countVid} Vidéo${countVid > 1 ? 's' : ''}`);

  elTxtSummary.textContent = `${selectedFiles.size} fichier${selectedFiles.size > 1 ? 's' : ''} sélectionné${selectedFiles.size > 1 ? 's' : ''} (${parts.join(', ')}) — Taille totale : ${formatBytes(totalSize)}`;
  elBtnImport.disabled = false;
}

// ----------------------------------------------------
// Core Operations: Scan & Import
// ----------------------------------------------------

async function startScan() {
  const sourcePath = elSourcePath.value.trim();
  if (!sourcePath) {
    alert("Veuillez renseigner un dossier source.");
    return;
  }

  elEmptyState.classList.add('hidden');
  elTimelineArea.classList.add('hidden');
  elScanLoader.classList.remove('hidden');
  elBtnScan.disabled = true;

  let unlistenScan;

  try {
    if (isTauri) {
      const elScanProgressFill = document.querySelector("#scan-progress-fill");
      const elScanStatusText = document.querySelector("#scan-status-text");
      if (elScanProgressFill) elScanProgressFill.style.width = "0%";
      if (elScanStatusText) elScanStatusText.textContent = "Recherche des fichiers...";

      unlistenScan = await window.__TAURI__.event.listen("scan-progress", (event) => {
        const { current, total, file_name } = event.payload;
        const percentage = Math.round((current / total) * 100);
        if (elScanProgressFill) elScanProgressFill.style.width = `${percentage}%`;
        if (elScanStatusText) elScanStatusText.textContent = `[${current}/${total}] Analyse de ${file_name}...`;
      });

      scannedDays = await invoke("scan_source", { sourcePath });
    } else {
      // Simulate reading network delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      scannedDays = getMockData();
    }

    // Default select all scanned files
    selectedFiles.clear();
    favoriteFiles.clear();
    stackModes = {};
    Object.values(scannedDays).flat().forEach(file => {
      selectedFiles.add(file.path);
      // Automatically star RAW files in simulation as a default showcase
      if (!isTauri && file.file_type === 'raw') {
        favoriteFiles.add(file.path);
      }
    });

    renderTimeline();
    updateSummary();

  } catch (error) {
    console.error(error);
    alert(`Erreur de scan : ${error}`);
    elEmptyState.classList.remove('hidden');
  } finally {
    if (unlistenScan) {
      unlistenScan();
    }
    elScanLoader.classList.add('hidden');
    elBtnScan.disabled = false;
  }
}

async function runImport() {
  const destPath = elDestPath.value.trim();
  if (!destPath) {
    alert("Veuillez renseigner un dossier de destination.");
    return;
  }

  // Build payload
  const importDaysConfig = Object.keys(scannedDays).map(date => {
    const dayFiles = scannedDays[date];
    const filesToImport = dayFiles
      .filter(f => selectedFiles.has(f.path))
      .map(f => ({
        source_path: f.path,
        file_type: f.file_type,
        is_favorite: favoriteFiles.has(f.path)
      }));

    return {
      date,
      suffix: daySuffixes[date] || "",
      files: filesToImport
    };
  }).filter(day => day.files.length > 0);

  if (importDaysConfig.length === 0) {
    alert("Aucun fichier sélectionné pour l'importation.");
    return;
  }

  // Setup UI for modal progress
  elModalImport.classList.remove('hidden');
  elImportProgressView.classList.remove('hidden');
  elImportReportView.classList.add('hidden');
  elBtnModalClose.classList.add('hidden');
  elImportProgressFill.style.width = '0%';
  elModalTitle.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Importation en cours...`;
  refreshIcons();

  let totalFilesToCopy = 0;
  let copiedCount = 0;
  let favoriteCount = 0;
  let savedBytes = 0;

  importDaysConfig.forEach(day => {
    totalFilesToCopy += day.files.length;
    day.files.forEach(f => {
      if (f.is_favorite) {
        favoriteCount++;
        // Find file details to calculate saved space
        const details = Object.values(scannedDays).flat().find(sd => sd.path === f.source_path);
        if (details) {
          savedBytes += details.size;
        }
      }
    });
  });

  try {
    if (isTauri) {
      elImportStatusText.textContent = `Préparation de l'importation...`;
      
      const unlistenImport = await window.__TAURI__.event.listen("import-progress", (event) => {
        const { current, total, file_name } = event.payload;
        const percentage = Math.round((current / total) * 100);
        elImportProgressFill.style.width = `${percentage}%`;
        elImportStatusText.textContent = `[${current}/${total}] Copie de ${file_name}...`;
      });

      try {
        await invoke("start_import", { destination: destPath, days: importDaysConfig, deleteSource: deleteSourceAfterImport });
      } finally {
        unlistenImport();
      }
      
      elImportProgressFill.style.width = '100%';

    } else {
      // High-fidelity simulation mode
      const allFiles = importDaysConfig.flatMap(d => d.files);
      for (let i = 0; i < allFiles.length; i++) {
        const file = allFiles[i];
        const fileName = file.source_path.split('/').pop();
        
        // Show actual copying/moving log
        const verb = deleteSourceAfterImport ? "Déplacement" : "Copie";
        elImportStatusText.textContent = `[${i + 1}/${allFiles.length}] ${verb} de ${fileName} (${file.file_type.toUpperCase()})...`;
        
        // Increment progress bar
        const progressPercentage = Math.round(((i + 1) / allFiles.length) * 100);
        elImportProgressFill.style.width = `${progressPercentage}%`;

        // Wait a tiny bit to simulate filesystem operations
        await new Promise(r => setTimeout(r, 250));
      }
    }

    // Success Screen transition
    copiedCount = totalFilesToCopy;
    
    // Fill stats
    elStatCopied.textContent = copiedCount;
    elStatFavs.textContent = favoriteCount;
    elStatSaved.textContent = formatBytes(savedBytes);

    elImportProgressView.classList.add('hidden');
    elImportReportView.classList.remove('hidden');
    elBtnModalClose.classList.remove('hidden');
    elModalTitle.innerHTML = `<i data-lucide="check" style="color: #10b981"></i> Terminé`;
    refreshIcons();

  } catch (error) {
    console.error(error);
    alert(`Erreur d'importation : ${error}`);
    elModalImport.classList.add('hidden');
  }
}

// ----------------------------------------------------
// Setup Initialization
// ----------------------------------------------------

// --- Lightbox Operations Sync ---

function updateLightboxSelectionVisuals(item) {
  const isSelected = item.type === 'stack'
    ? selectedFiles.has(item.jpgFile.path)
    : selectedFiles.has(item.files[0].path);

  if (elBtnLightboxSelect) {
    elBtnLightboxSelect.checked = isSelected;
  }
}

function updateLightboxFavoriteVisuals(item) {
  const isStarred = item.type === 'stack'
    ? favoriteFiles.has(item.jpgFile.path)
    : favoriteFiles.has(item.files[0].path);

  if (elBtnLightboxStar) {
    elBtnLightboxStar.classList.toggle("starred", isStarred);
  }
}

function toggleLightboxSelection() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;

  const isSelected = item.type === 'stack'
    ? selectedFiles.has(item.jpgFile.path)
    : selectedFiles.has(item.files[0].path);

  // Toggle selection state
  item.files.forEach(f => {
    if (isSelected) {
      selectedFiles.delete(f.path);
    } else {
      if (item.type === 'stack') {
        const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
        const mode = stackModes[baseKey] || 'both';
        if (mode === 'jpg') {
          selectedFiles.add(item.jpgFile.path);
        } else {
          selectedFiles.add(item.jpgFile.path);
          selectedFiles.add(item.rawFile.path);
        }
      } else {
        selectedFiles.add(item.files[0].path);
      }
    }
  });

  updateLightboxSelectionVisuals(item);
  updateTimelineCardVisuals(item);
  updateSummary();
  refreshIcons();
}

function toggleLightboxFavorite() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;

  const isStarred = item.type === 'stack'
    ? favoriteFiles.has(item.jpgFile.path)
    : favoriteFiles.has(item.files[0].path);

  item.files.forEach(f => {
    if (isStarred) {
      favoriteFiles.delete(f.path);
    } else {
      favoriteFiles.add(f.path);
    }
  });

  // Auto-select when starring
  const isSelected = item.type === 'stack'
    ? selectedFiles.has(item.jpgFile.path)
    : selectedFiles.has(item.files[0].path);
    
  if (!isStarred && !isSelected) {
    item.files.forEach(f => {
      if (item.type === 'stack') {
        const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
        const mode = stackModes[baseKey] || 'both';
        if (mode === 'jpg') {
          selectedFiles.add(item.jpgFile.path);
        } else {
          selectedFiles.add(item.jpgFile.path);
          selectedFiles.add(item.rawFile.path);
        }
      } else {
        selectedFiles.add(item.files[0].path);
      }
    });
  }

  updateLightboxFavoriteVisuals(item);
  updateLightboxSelectionVisuals(item);
  updateTimelineCardVisuals(item);
  updateSummary();
  refreshIcons();
}

function updateTimelineCardVisuals(item) {
  const itemKey = item.type === 'stack' ? item.jpgFile.path : item.files[0].path;
  const cardEl = document.querySelector(`.file-card[data-path="${itemKey}"]`);
  if (cardEl) {
    const isSelected = item.type === 'stack'
      ? selectedFiles.has(item.jpgFile.path)
      : selectedFiles.has(item.files[0].path);
    const isStarred = item.type === 'stack'
      ? favoriteFiles.has(item.jpgFile.path)
      : favoriteFiles.has(item.files[0].path);

    cardEl.classList.toggle('selected', isSelected);
    const cb = cardEl.querySelector('.item-checkbox');
    if (cb) cb.checked = isSelected;

    const starBtn = cardEl.querySelector('.btn-star');
    if (starBtn) starBtn.classList.toggle('starred', isStarred);

    // Also update day header checkbox
    const dayBlock = cardEl.closest('.day-block');
    if (dayBlock) {
      updateDayHeaderSelectionState(dayBlock);
    }
  }
}


window.addEventListener("DOMContentLoaded", () => {
  // Bind UI References
  elSourcePath = document.querySelector("#source-path");
  elDestPath = document.querySelector("#dest-path");
  elBtnScan = document.querySelector("#btn-scan");
  elBtnImport = document.querySelector("#btn-import");
  elTimelineArea = document.querySelector("#timeline-area");
  elEmptyState = document.querySelector("#empty-state");
  elScanLoader = document.querySelector("#scan-loader");
  elTxtSummary = document.querySelector("#txt-summary");
  
  elModalImport = document.querySelector("#modal-import");
  elModalTitle = document.querySelector("#modal-title");
  elImportProgressView = document.querySelector("#import-progress-view");
  elImportProgressFill = document.querySelector("#import-progress-fill");
  elImportStatusText = document.querySelector("#import-status-text");
  elImportReportView = document.querySelector("#import-report-view");
  elBtnModalClose = document.querySelector("#btn-modal-close");
  elBtnSelectSource = document.querySelector("#btn-select-source");
  elBtnSelectDest = document.querySelector("#btn-select-dest");
  
  elTimelineControls = document.querySelector("#timeline-controls");
  elBtnSelectAll = document.querySelector("#btn-select-all");
  elBtnDeselectAll = document.querySelector("#btn-deselect-all");
  elBtnGlobalBoth = document.querySelector("#btn-global-both");
  elBtnGlobalJpg = document.querySelector("#btn-global-jpg");
  elBtnModeCopy = document.querySelector("#btn-mode-copy");
  elBtnModeCut = document.querySelector("#btn-mode-cut");

  elStatCopied = document.querySelector("#stat-copied");
  elStatFavs = document.querySelector("#stat-favs");
  elStatSaved = document.querySelector("#stat-saved");

  elModalLightbox = document.querySelector("#modal-lightbox");
  elLightboxImg = document.querySelector("#lightbox-img");
  elLightboxVideo = document.querySelector("#lightbox-video");
  elLightboxStackControl = document.querySelector("#lightbox-stack-control");
  elLightboxFilename = document.querySelector("#lightbox-filename");
  elLightboxDetails = document.querySelector("#lightbox-details");
  elBtnLightboxClose = document.querySelector("#btn-lightbox-close");
  elBtnLightboxPrev = document.querySelector("#btn-lightbox-prev");
  elBtnLightboxNext = document.querySelector("#btn-lightbox-next");
  elBtnLightboxSelect = document.querySelector("#btn-lightbox-select");
  elBtnLightboxStar = document.querySelector("#btn-lightbox-star");

  // Event Listeners
  elBtnScan.addEventListener("click", startScan);
  elBtnImport.addEventListener("click", runImport);

  // Selection actions
  elBtnSelectAll.addEventListener("click", () => {
    Object.keys(scannedDays).forEach(date => selectDayFiles(date, true));
  });

  elBtnDeselectAll.addEventListener("click", () => {
    selectedFiles.clear();
    renderTimeline();
    updateSummary();
  });

  elBtnGlobalBoth.addEventListener("click", () => {
    setGlobalStackMode("both");
  });

  elBtnGlobalJpg.addEventListener("click", () => {
    setGlobalStackMode("jpg");
  });

  // Import mode toggles
  elBtnModeCopy.addEventListener("click", () => {
    deleteSourceAfterImport = false;
    elBtnModeCopy.classList.add("active");
    elBtnModeCut.classList.remove("active");
  });

  elBtnModeCut.addEventListener("click", () => {
    deleteSourceAfterImport = true;
    elBtnModeCut.classList.add("active");
    elBtnModeCopy.classList.remove("active");
  });

  elBtnSelectSource.addEventListener("click", async () => {
    if (isTauri) {
      const selected = await invoke("select_folder", { title: "Sélectionner le dossier source (Carte SD)" });
      if (selected) {
        elSourcePath.value = selected;
      }
    } else {
      const mockPath = prompt("Simulation : Entrez un dossier source", "E:\\DCIM\\100MSDCF");
      if (mockPath) {
        elSourcePath.value = mockPath;
      }
    }
  });

  elBtnSelectDest.addEventListener("click", async () => {
    if (isTauri) {
      const selected = await invoke("select_folder", { title: "Sélectionner le dossier de destination (Archivage)" });
      if (selected) {
        elDestPath.value = selected;
      }
    } else {
      const mockPath = prompt("Simulation : Entrez un dossier de destination", "C:\\Users\\loufa\\Photos_Backup");
      if (mockPath) {
        elDestPath.value = mockPath;
      }
    }
  });
  
  elBtnModalClose.addEventListener("click", () => {
    elModalImport.classList.add('hidden');
    // Clear selection on successful import
    selectedFiles.clear();
    favoriteFiles.clear();
    stackModes = {};
    scannedDays = {};
    renderTimeline();
    updateSummary();
  });



  elBtnLightboxClose.addEventListener("click", closeLightbox);
  elBtnLightboxPrev.addEventListener("click", () => navigateLightbox(-1));
  elBtnLightboxNext.addEventListener("click", () => navigateLightbox(1));
  elBtnLightboxSelect.addEventListener("change", toggleLightboxSelection);
  elBtnLightboxStar.addEventListener("click", toggleLightboxFavorite);

  // Lightbox stack-mode selector delegate listener
  elLightboxStackControl.addEventListener("click", (e) => {
    const opt = e.target.closest('.mode-opt');
    if (!opt) return;
    const mode = opt.dataset.mode;
    
    const item = lightboxItems[lightboxIndex];
    if (item && item.type === 'stack') {
      const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
      setStackMode(baseKey, mode);
      
      // Update active option visuals
      elLightboxStackControl.querySelectorAll('.mode-opt').forEach(o => {
        o.classList.toggle("active", o.dataset.mode === mode);
      });
      
      // Update details text and size description in lightbox
      const activeFiles = item.files.filter(f => selectedFiles.has(f.path));
      const finalSize = activeFiles.reduce((acc, f) => acc + f.size, 0) || item.size;
      const activeExtensions = activeFiles.length > 0 
        ? activeFiles.map(f => f.name.split('.').pop().toUpperCase()).join("+")
        : item.files.map(f => f.name.split('.').pop().toUpperCase()).join("+");
      elLightboxDetails.textContent = `${activeExtensions} — ${formatBytes(finalSize)} — ${item.date}`;
    }
  });

  // Close lightbox on backdrop click
  elModalLightbox.addEventListener("click", (e) => {
    if (e.target === elModalLightbox) {
      closeLightbox();
    }
  });

  // Keyboard navigation shortcuts
  window.addEventListener("keydown", (e) => {
    if (elModalLightbox.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      closeLightbox();
    } else if (e.key === "ArrowLeft") {
      navigateLightbox(-1);
    } else if (e.key === "ArrowRight") {
      navigateLightbox(1);
    } else if (e.key === " ") {
      e.preventDefault();
      toggleLightboxSelection();
    } else if (e.key.toLowerCase() === "f") {
      toggleLightboxFavorite();
    }
  });

  // Load initial icons
  refreshIcons();
});
