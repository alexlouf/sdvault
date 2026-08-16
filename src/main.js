import { enableZoom } from './zoom.js';

window.addEventListener("error", (e) => {
  alert("Global Error: " + e.message + " at " + e.filename + ":" + e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  alert("Unhandled Promise Rejection: " + e.reason);
});

let tauriCore, tauriEvent;
try {
  tauriCore = window.__TAURI__.core;
  tauriEvent = window.__TAURI__.event;
} catch (e) {
  console.error("Tauri initialization error: ", e);
  alert("Erreur critique: Tauri n'est pas initialisé correctement.");
}

const invoke = (...args) => tauriCore.invoke(...args);
const listen = (...args) => tauriEvent.listen(...args);

// ----------------------------------------------------
// Application State
// ----------------------------------------------------
let scannedDays = {};          // { [date]: MediaFile[] }
let cachedGroupedDays = {};    // { [date]: GroupedItem[] } - Memoized grouping cache
let selectedFiles = new Set(); // Set of absolute file paths
let favoriteFiles = new Set(); // Set of absolute file paths
let daySuffixes = {};          // { [date]: string }
let deleteSourceAfterImport = false; // Toggle for Copy (false) vs Cut (true)
let stackModes = {};           // { [baseKey]: 'both' | 'jpg' }

// Burst Inspector State
let currentBurstItem = null;
let activeBurstIdx = 0;
let burstViewMode = 'solo';    // 'solo' | 'split'

// ----------------------------------------------------
// UI Elements References
// ----------------------------------------------------
let elSourcePath, elDestPath, elBtnScan, elBtnImport, elTimelineArea;
let elEmptyState, elScanLoader, elTxtSummary;
let elModalImport, elModalTitle, elImportProgressView, elImportProgressFill;
let elImportStatusText, elImportReportView, elBtnModalClose;
let elStatCopied, elStatFavs, elStatSaved;
let elBtnSelectSource, elBtnSelectDest;
let elTimelineControls, elBtnSelectAll, elBtnDeselectAll;
let elBtnModeCopy, elBtnModeCut, elBtnGlobalBoth, elBtnGlobalJpg;

// Lightbox Elements
let elModalLightbox, elLightboxImg, elLightboxVideo, elLightboxStackControl;
let elLightboxFilename, elLightboxDetails;
let elBtnLightboxClose, elBtnLightboxPrev, elBtnLightboxNext;
let elBtnLightboxSelect, elBtnLightboxStar;
let lightboxItems = [];
let lightboxIndex = -1;

// Image load request trackers to prevent black photos and race conditions
let currentLightboxLoadId = 0;
let currentBurstSoloLoadId = 0;
let currentBurstSplitActiveLoadId = 0;
let currentBurstSplitRefLoadId = 0;
let lightboxHdTimeout = null;
let burstSoloHdTimeout = null;
let burstSplitActiveHdTimeout = null;
let burstSplitRefHdTimeout = null;

// Image Cache for high definition previews
const hdImageCache = new Set();

function preloadHdImage(url) {
  if (!url) return;
  const hdUrl = url.includes('?full=true') ? url : `${url}?full=true`;
  if (hdImageCache.has(hdUrl)) return;
  const img = new Image();
  img.onload = () => {
    hdImageCache.add(hdUrl);
  };
  img.src = hdUrl;
}

// Burst Inspector Elements
let elModalBurstInspector, elBurstInspectorTitle, elBurstInspectorSubtitle;
let elBtnBurstViewSolo, elBtnBurstViewSplit, elBtnBurstClose;
let elBurstStageSolo, elBurstStageSplit, elBurstSoloImg;
let elBurstSplitImgActive, elBurstSplitImgRef, elBurstSplitActiveNum;
let elBurstActiveMeta, elBtnBurstKeepLast, elBtnBurstKeepStarred;
let elBtnBurstActiveSelect, elBtnBurstActiveStar, elBurstActiveStackControl;
let elBtnBurstSelectAll, elBtnBurstDeselectAll;
let elBtnBurstPrev, elBtnBurstNext, elBurstFilmstrip;

// Refresh Lucide icons scoped to a node for high performance
function refreshIcons(rootNode = null) {
  const lucideLib = window.lucide || (typeof exports !== 'undefined' ? exports : null);
  if (lucideLib && lucideLib.createIcons) {
    if (rootNode) {
      lucideLib.createIcons({ root: rootNode });
    } else {
      lucideLib.createIcons();
    }
  } else {
    console.warn("Lucide library not found. Icons will not be rendered.");
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

// ----------------------------------------------------
// Grouping Engine: RAW+JPG pairing & Burst Stacking
// ----------------------------------------------------

function groupDayItems(files) {
  // 1. Group by base filename to pair RAW + JPG
  const groupedByBase = {};
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const dotIndex = file.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const baseKey = baseName.toLowerCase();
    
    if (!groupedByBase[baseKey]) {
      groupedByBase[baseKey] = [];
    }
    groupedByBase[baseKey].push(file);
  }

  const baseItems = [];
  const groupValues = Object.values(groupedByBase);
  for (let i = 0; i < groupValues.length; i++) {
    const group = groupValues[i];
    if (group.length === 2) {
      const rawFile = group.find(f => f.file_type === 'raw');
      const jpgFile = group.find(f => f.file_type === 'jpg');
      if (rawFile && jpgFile) {
        const dotIdx = jpgFile.name.lastIndexOf('.');
        const bName = dotIdx !== -1 ? jpgFile.name.substring(0, dotIdx) : jpgFile.name;
        const timestamp = jpgFile.timestamp || rawFile.timestamp || 0;
        baseItems.push({
          type: 'stack',
          name: `${bName} (RAW+JPG)`,
          files: [rawFile, jpgFile],
          rawFile,
          jpgFile,
          baseKey: bName.toLowerCase(),
          file_type: 'raw+jpg',
          size: rawFile.size + jpgFile.size,
          date: jpgFile.date,
          timestamp,
          thumbnail_url: jpgFile.thumbnail_url || rawFile.thumbnail_url
        });
        continue;
      }
    }
    
    for (let j = 0; j < group.length; j++) {
      const file = group[j];
      baseItems.push({
        type: 'single',
        name: file.name,
        files: [file],
        file_type: file.file_type,
        size: file.size,
        date: file.date,
        timestamp: file.timestamp || 0,
        thumbnail_url: file.thumbnail_url
      });
    }
  }

  // Sort base items by timestamp ascending
  baseItems.sort((a, b) => {
    if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  // 2. Group consecutive items taken <= 1 second apart into BurstStacks
  const finalItems = [];
  let currentBurst = [];

  for (let i = 0; i < baseItems.length; i++) {
    const item = baseItems[i];
    
    // Videos do not participate in burst stacking
    if (item.file_type === 'video') {
      if (currentBurst.length > 0) {
        pushBurstOrSingle(currentBurst, finalItems);
        currentBurst = [];
      }
      finalItems.push(item);
      continue;
    }

    if (currentBurst.length === 0) {
      currentBurst.push(item);
    } else {
      const prevItem = currentBurst[currentBurst.length - 1];
      const timeDiffMs = (item.timestamp && prevItem.timestamp) ? Math.abs(item.timestamp - prevItem.timestamp) : 999999;
      
      // Strict burst condition: consecutive shots taken within <= 1000ms (1.0 second) of each other
      const isBurstPair = timeDiffMs <= 1000;

      if (isBurstPair) {
        currentBurst.push(item);
      } else {
        pushBurstOrSingle(currentBurst, finalItems);
        currentBurst = [item];
      }
    }
  }

  if (currentBurst.length > 0) {
    pushBurstOrSingle(currentBurst, finalItems);
  }

  return finalItems;
}

function pushBurstOrSingle(burstList, targetArray) {
  if (burstList.length >= 2) {
    const coverIdx = burstList.length - 1; // Default cover photo = LAST photo of the burst sequence
    const coverItem = burstList[coverIdx];
    const totalSize = burstList.reduce((acc, it) => acc + it.size, 0);

    targetArray.push({
      type: 'burst',
      name: `Rafale (${burstList.length} photos)`,
      items: burstList,
      coverIndex: coverIdx,
      file_type: 'burst',
      date: coverItem.date,
      timestamp: coverItem.timestamp,
      size: totalSize,
      thumbnail_url: coverItem.thumbnail_url
    });
  } else {
    targetArray.push(burstList[0]);
  }
}

// ----------------------------------------------------
// UI Logic & Renderers
// ----------------------------------------------------

// Render timeline grid using DocumentFragment for maximum batching speed
function renderTimeline() {
  const scrollTop = elTimelineArea ? elTimelineArea.scrollTop : 0;
  if (!elTimelineArea) return;
  
  const dates = Object.keys(cachedGroupedDays).sort((a, b) => b.localeCompare(a));

  if (dates.length === 0) {
    elEmptyState.classList.remove('hidden');
    elTimelineArea.classList.add('hidden');
    elTimelineControls.classList.add('hidden');
    elTimelineArea.innerHTML = '';
    return;
  }

  elEmptyState.classList.add('hidden');
  elTimelineArea.classList.remove('hidden');
  elTimelineControls.classList.remove('hidden');

  const fragment = document.createDocumentFragment();

  dates.forEach(date => {
    const files = scannedDays[date] || [];
    const dayItems = cachedGroupedDays[date] || [];

    const dayBlock = document.createElement('div');
    dayBlock.className = 'day-block card';
    dayBlock.dataset.date = date;

    if (!daySuffixes[date]) daySuffixes[date] = "";

    const jpgs = files.filter(f => f.file_type === 'jpg').length;
    const raws = files.filter(f => f.file_type === 'raw').length;
    const videos = files.filter(f => f.file_type === 'video').length;
    const burstsCount = dayItems.filter(it => it.type === 'burst').length;
    
    let summaryText = [];
    if (jpgs > 0) summaryText.push(`${jpgs} JPG`);
    if (raws > 0) summaryText.push(`${raws} RAW`);
    if (videos > 0) summaryText.push(`${videos} Vidéo${videos > 1 ? 's' : ''}`);
    if (burstsCount > 0) summaryText.push(`${burstsCount} Rafale${burstsCount > 1 ? 's' : ''}`);

    const isAllDaySelected = dayItems.every(item => {
      if (item.type === 'burst') {
        const coverItem = item.items[item.coverIndex];
        return coverItem.type === 'stack' ? selectedFiles.has(coverItem.jpgFile.path) : selectedFiles.has(coverItem.files[0].path);
      } else if (item.type === 'stack') {
        return selectedFiles.has(item.jpgFile.path);
      }
      return selectedFiles.has(item.files[0].path);
    });

    const dayHasStacks = dayItems.some(it => it.type === 'stack' || (it.type === 'burst' && it.items.some(sub => sub.type === 'stack')));

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

    dayItems.forEach(item => {
      if (item.type === 'burst') {
        renderBurstCard(item, grid);
      } else {
        renderStandardCard(item, grid);
      }
    });

    // Event handlers on Day Block Header
    dayBlock.querySelector('.day-checkbox').addEventListener('change', (e) => {
      selectDayFiles(date, e.target.checked);
    });

    dayBlock.querySelector('.day-suffix-input').addEventListener('input', (e) => {
      daySuffixes[date] = e.target.value;
    });

    dayBlock.querySelectorAll('.btn-day-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        setDayStackMode(date, btn.dataset.mode);
      });
    });

    updateDayHeaderSelectionState(dayBlock);
    fragment.appendChild(dayBlock);
  });

  elTimelineArea.innerHTML = '';
  elTimelineArea.appendChild(fragment);

  if (elTimelineArea) elTimelineArea.scrollTop = scrollTop;
  refreshIcons(elTimelineArea);
}

// Render a Standard Single or RAW+JPG Stack Card
function renderStandardCard(item, grid) {
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
    previewHTML = `<img src="${item.thumbnail_url}" class="media-preview" alt="${item.name}" loading="lazy" decoding="async" />`;
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

  card.addEventListener('click', (e) => {
    if (e.target.closest('input') || e.target.closest('button') || e.target.closest('.stack-mode-pill')) return;
    toggleItemSelection(item, card);
  });

  card.addEventListener('dblclick', () => {
    lightboxItems = getTimelineItems();
    const currentIdx = lightboxItems.findIndex(x => {
      if (x.type === 'burst') return false;
      return x.files && x.files.some(f => item.files.some(i => i.path === f.path));
    });
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
    const currentIdx = lightboxItems.findIndex(x => {
      if (x.type === 'burst') return false;
      return x.files && x.files.some(f => item.files.some(i => i.path === f.path));
    });
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
}

// Calculate selection info for a burst item
function getBurstSelectionInfo(burstItem) {
  let selectedCount = 0;
  const totalCount = burstItem.items.length;

  for (let i = 0; i < burstItem.items.length; i++) {
    const item = burstItem.items[i];
    const isSel = item.type === 'stack'
      ? selectedFiles.has(item.jpgFile.path)
      : selectedFiles.has(item.files[0].path);
    if (isSel) selectedCount++;
  }

  return {
    selectedCount,
    totalCount,
    isAll: selectedCount === totalCount && totalCount > 0,
    isNone: selectedCount === 0,
    isPartial: selectedCount > 0 && selectedCount < totalCount
  };
}

// Render a Burst Stack Card (showing cover image thumbnail = last photo of burst sequence)
function renderBurstCard(burstItem, grid) {
  const coverItem = burstItem.items[burstItem.coverIndex];
  const info = getBurstSelectionInfo(burstItem);
  const isStarred = burstItem.items.some(item =>
    item.type === 'stack' ? favoriteFiles.has(item.jpgFile.path) : favoriteFiles.has(item.files[0].path)
  );

  const card = document.createElement('div');
  const isCardActive = !info.isNone;
  card.className = `file-card card-burst ${isCardActive ? 'selected' : ''}`;
  card.dataset.path = coverItem.type === 'stack' ? coverItem.jpgFile.path : coverItem.files[0].path;

  let previewHTML = coverItem.thumbnail_url 
    ? `<img src="${coverItem.thumbnail_url}" class="media-preview" alt="${burstItem.name}" loading="lazy" decoding="async" />`
    : `<div class="media-placeholder"><i data-lucide="zap"></i><span>Rafale (${burstItem.items.length})</span></div>`;

  card.innerHTML = `
    ${previewHTML}
    <span class="type-badge badge-burst"><i data-lucide="zap"></i> Rafale (${burstItem.items.length})</span>
    <div class="card-overlay">
      <div class="overlay-top">
        <input type="checkbox" class="item-checkbox" />
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn-preview-zoom btn-inspect-trigger" title="Inspecter la rafale">
            <i data-lucide="eye"></i>
          </button>
          <button class="btn-star ${isStarred ? 'starred' : ''}">
            <i data-lucide="star"></i>
          </button>
        </div>
      </div>
      <div class="overlay-bottom">
        <span class="file-name" title="${coverItem.name}">${coverItem.name} <small>(${info.selectedCount}/${info.totalCount} sél.)</small></span>
        <div class="stack-row" style="margin-top: 4px;">
          <span class="file-size">${formatBytes(coverItem.size)}</span>
          <button class="btn-inspect-burst"><i data-lucide="zap"></i> Inspecter (${burstItem.items.length})</button>
        </div>
      </div>
    </div>
  `;

  const cb = card.querySelector('.item-checkbox');
  if (cb) {
    cb.checked = info.isAll;
    cb.indeterminate = info.isPartial;
  }

  card.addEventListener('click', (e) => {
    if (e.target.closest('input') || e.target.closest('button')) return;
    toggleBurstSelection(burstItem, card);
  });

  const handleOpenBurst = () => {
    lightboxItems = getTimelineItems();
    const coverPath = coverItem.type === 'stack' ? coverItem.jpgFile.path : coverItem.files[0].path;
    lightboxIndex = lightboxItems.findIndex(x => {
      if (x.type !== 'burst') return false;
      const xCover = x.items[x.coverIndex];
      const xCoverPath = xCover.type === 'stack' ? xCover.jpgFile.path : xCover.files[0].path;
      return xCoverPath === coverPath;
    });
    openBurstInspector(burstItem);
  };

  card.addEventListener('dblclick', handleOpenBurst);

  if (cb) {
    cb.addEventListener('change', () => {
      toggleBurstSelection(burstItem, card);
    });
  }

  card.querySelector('.btn-star').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleBurstFavorite(burstItem, card.querySelector('.btn-star'));
  });

  card.querySelector('.btn-inspect-burst').addEventListener('click', (e) => {
    e.stopPropagation();
    handleOpenBurst();
  });

  card.querySelector('.btn-inspect-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    handleOpenBurst();
  });

  grid.appendChild(card);
}

// Helper to select an item respecting stackModes (JPG vs RAW+JPG)
function selectItem(item) {
  if (!item) return;
  if (item.type === 'stack') {
    const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
    const mode = stackModes[baseKey] || 'both';
    selectedFiles.add(item.jpgFile.path);
    if (mode === 'both') {
      if (item.rawFile) selectedFiles.add(item.rawFile.path);
    } else {
      if (item.rawFile) selectedFiles.delete(item.rawFile.path);
    }
  } else if (item.files && item.files.length > 0) {
    selectedFiles.add(item.files[0].path);
  }
}

// Helper to deselect an item
function deselectItem(item) {
  if (!item || !item.files) return;
  for (let i = 0; i < item.files.length; i++) {
    selectedFiles.delete(item.files[i].path);
  }
}

// Select/Deselect files for a specific day block without full re-render
function selectDayFiles(date, checked) {
  const items = cachedGroupedDays[date] || [];

  items.forEach(item => {
    if (item.type === 'burst') {
      item.items.forEach(sub => {
        if (checked) selectItem(sub);
        else deselectItem(sub);
      });
    } else {
      if (checked) selectItem(item);
      else deselectItem(item);
    }
  });

  const dayBlock = document.querySelector(`.day-block[data-date="${date}"]`);
  if (dayBlock) {
    updateDayBlockVisuals(dayBlock, date);
  }
  updateSummary();
}

// Toggle stack mode: both (RAW+JPG) or jpg (JPG only)
function setStackMode(baseKey, mode) {
  stackModes[baseKey] = mode;
  let matchedItem = null;

  for (const date of Object.keys(cachedGroupedDays)) {
    const items = cachedGroupedDays[date];
    for (const item of items) {
      if (item.type === 'burst') {
        const found = item.items.find(it => it.type === 'stack' && it.jpgFile.name.substring(0, it.jpgFile.name.lastIndexOf('.')).toLowerCase() === baseKey);
        if (found) { matchedItem = found; break; }
      } else if (item.type === 'stack' && item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase() === baseKey) {
        matchedItem = item;
        break;
      }
    }
    if (matchedItem) break;
  }

  if (matchedItem) {
    const isSelected = selectedFiles.has(matchedItem.jpgFile.path) || (matchedItem.rawFile && selectedFiles.has(matchedItem.rawFile.path));
    if (isSelected) {
      selectItem(matchedItem);
    }
    updateTimelineCardVisuals(matchedItem);
  }

  updateSummary();
}

// Toggle global stack mode in place
function setGlobalStackMode(mode) {
  Object.keys(cachedGroupedDays).forEach(date => {
    setDayStackMode(date, mode, false);
  });
  updateAllCardsDOM();
  updateSummary();
}

// Toggle day stack mode in place
function setDayStackMode(date, mode, updateUI = true) {
  const dayItems = cachedGroupedDays[date] || [];

  const applyModeToItem = (item) => {
    if (item.type === 'stack') {
      const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
      stackModes[baseKey] = mode;
      const isSelected = selectedFiles.has(item.jpgFile.path) || (item.rawFile && selectedFiles.has(item.rawFile.path));
      if (isSelected) {
        selectItem(item);
      }
    }
  };

  dayItems.forEach(item => {
    if (item.type === 'burst') {
      item.items.forEach(applyModeToItem);
    } else {
      applyModeToItem(item);
    }
  });

  if (updateUI) {
    const dayBlock = document.querySelector(`.day-block[data-date="${date}"]`);
    if (dayBlock) updateDayBlockVisuals(dayBlock, date);
    updateSummary();
  }
}

// Toggle item selection
function toggleItemSelection(item, cardEl) {
  const isSelected = item.type === 'stack' 
    ? selectedFiles.has(item.jpgFile.path) 
    : selectedFiles.has(item.files[0].path);
    
  deselectItem(item);

  const newSelectedState = !isSelected;
  if (newSelectedState) {
    selectItem(item);
    if (cardEl) {
      cardEl.classList.add('selected');
      const cb = cardEl.querySelector('.item-checkbox');
      if (cb) cb.checked = true;
    }
  } else {
    if (cardEl) {
      cardEl.classList.remove('selected');
      const cb = cardEl.querySelector('.item-checkbox');
      if (cb) cb.checked = false;
    }
  }

  if (cardEl) {
    updateDayHeaderSelectionState(cardEl.closest('.day-block'));
  }
  updateSummary();
}

// Update day header checkbox state using memoized grouped days
function updateDayHeaderSelectionState(dayBlockEl) {
  if (!dayBlockEl) return;
  const date = dayBlockEl.dataset.date;
  const items = cachedGroupedDays[date];
  if (!items) return;
  const dayCheckbox = dayBlockEl.querySelector('.day-checkbox');
  if (!dayCheckbox) return;

  let totalCount = 0;
  let selectedCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    totalCount++;
    if (item.type === 'burst') {
      const burstInfo = getBurstSelectionInfo(item);
      if (burstInfo.isAll) {
        selectedCount++;
      } else if (burstInfo.isPartial) {
        selectedCount += 0.5;
      }
    } else if (item.type === 'stack') {
      if (selectedFiles.has(item.jpgFile.path)) selectedCount++;
    } else {
      if (selectedFiles.has(item.files[0].path)) selectedCount++;
    }
  }

  if (selectedCount === 0) {
    dayCheckbox.checked = false;
    dayCheckbox.indeterminate = false;
  } else if (selectedCount >= totalCount) {
    dayCheckbox.checked = true;
    dayCheckbox.indeterminate = false;
  } else {
    dayCheckbox.checked = false;
    dayCheckbox.indeterminate = true;
  }
}

// Update all cards and header in a day block in-place
function updateDayBlockVisuals(dayBlock, date) {
  if (!dayBlock) return;
  const items = cachedGroupedDays[date] || [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'burst') {
      updateBurstCardVisuals(item);
    } else {
      updateTimelineCardVisuals(item);
    }
  }
  updateDayHeaderSelectionState(dayBlock);
}

// Fast in-place DOM update for all day blocks (used in select-all / deselect-all)
function updateAllCardsDOM() {
  const blocks = document.querySelectorAll('.day-block');
  blocks.forEach(dayBlock => {
    const date = dayBlock.dataset.date;
    if (date) updateDayBlockVisuals(dayBlock, date);
  });
}

// Toggle burst selection
function toggleBurstSelection(burstItem, cardEl) {
  const info = getBurstSelectionInfo(burstItem);
  const shouldSelectAll = !info.isAll;

  burstItem.items.forEach(item => {
    if (shouldSelectAll) {
      selectItem(item);
    } else {
      deselectItem(item);
    }
  });

  if (cardEl) {
    const updatedInfo = getBurstSelectionInfo(burstItem);
    cardEl.classList.toggle('selected', !updatedInfo.isNone);
    const cb = cardEl.querySelector('.item-checkbox');
    if (cb) {
      cb.checked = updatedInfo.isAll;
      cb.indeterminate = updatedInfo.isPartial;
    }
    const labelSmall = cardEl.querySelector('.file-name small');
    if (labelSmall) {
      labelSmall.textContent = `(${updatedInfo.selectedCount}/${updatedInfo.totalCount} sél.)`;
    }
    updateDayHeaderSelectionState(cardEl.closest('.day-block'));
  }
  updateSummary();
}

// Toggle burst favorite
function toggleBurstFavorite(burstItem, starBtnEl) {
  const isAnyStarred = burstItem.items.some(item =>
    item.type === 'stack' ? favoriteFiles.has(item.jpgFile.path) : favoriteFiles.has(item.files[0].path)
  );

  burstItem.items.forEach(item => {
    item.files.forEach(f => {
      if (isAnyStarred) favoriteFiles.delete(f.path);
      else favoriteFiles.add(f.path);
    });
  });

  if (starBtnEl) {
    starBtnEl.classList.toggle('starred', !isAnyStarred);
  }
  updateSummary();
}

// Toggle item favorite state
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
    if (starBtnEl) starBtnEl.classList.add('starred');
    const isSelected = item.type === 'stack'
      ? selectedFiles.has(item.jpgFile.path)
      : selectedFiles.has(item.files[0].path);
    if (!isSelected) {
      toggleItemSelection(item, starBtnEl ? starBtnEl.closest('.file-card') : null);
    }
  } else {
    if (starBtnEl) starBtnEl.classList.remove('starred');
  }
}

// Compile an ordered array of all items in timeline using pre-calculated cachedGroupedDays
function getTimelineItems() {
  const dates = Object.keys(cachedGroupedDays).sort((a, b) => b.localeCompare(a));
  const allItems = [];
  for (let i = 0; i < dates.length; i++) {
    const items = cachedGroupedDays[dates[i]];
    if (items) {
      for (let j = 0; j < items.length; j++) {
        allItems.push(items[j]);
      }
    }
  }
  return allItems;
}

// ----------------------------------------------------
// Lightbox Operations
// ----------------------------------------------------

function openLightbox(index, direction = 0) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const item = lightboxItems[index];

  if (item.type === 'burst') {
    elModalLightbox.classList.add("hidden");
    const startIdx = direction === 1 ? 0 : (direction === -1 ? item.items.length - 1 : undefined);
    openBurstInspector(item, startIdx);
    return;
  }

  if (lightboxHdTimeout) {
    clearTimeout(lightboxHdTimeout);
    lightboxHdTimeout = null;
  }

  elLightboxImg.classList.add("hidden");
  elLightboxVideo.classList.add("hidden");
  elLightboxVideo.pause();
  elLightboxVideo.src = "";
  
  if (item.file_type === 'video') {
    elLightboxVideo.src = `http://vault-asset.localhost/${item.files[0].path}`;
    elLightboxVideo.classList.remove("hidden");
  } else if (item.thumbnail_url) {
    const loadId = ++currentLightboxLoadId;
    const hdUrl = `${item.thumbnail_url}?full=true`;

    elLightboxImg.classList.remove("hidden");
    if (elLightboxImg.resetZoom) elLightboxImg.resetZoom();

    if (hdImageCache.has(hdUrl)) {
      elLightboxImg.src = hdUrl;
    } else {
      elLightboxImg.src = item.thumbnail_url;

      const hdImg = new Image();
      hdImg.onload = () => {
        hdImageCache.add(hdUrl);
        if (currentLightboxLoadId === loadId) {
          const isZoomed = elLightboxImg.isZoomed && elLightboxImg.isZoomed();
          const zoomState = isZoomed ? elLightboxImg.getZoomState() : null;
          elLightboxImg.src = hdUrl;
          if (zoomState) elLightboxImg.setZoomState(zoomState);
        }
      };
      hdImg.src = hdUrl;
    }

    // Preload next and previous lightbox items
    if (index > 0 && lightboxItems[index - 1] && lightboxItems[index - 1].thumbnail_url) {
      preloadHdImage(lightboxItems[index - 1].thumbnail_url);
    }
    if (index < lightboxItems.length - 1 && lightboxItems[index + 1] && lightboxItems[index + 1].thumbnail_url) {
      preloadHdImage(lightboxItems[index + 1].thumbnail_url);
    }
  }

  updateLightboxMetadata(item);

  elBtnLightboxPrev.style.display = index === 0 ? "none" : "flex";
  elBtnLightboxNext.style.display = index === lightboxItems.length - 1 ? "none" : "flex";

  elModalLightbox.classList.remove("hidden");
  updateLightboxSelectionVisuals(item);
  updateLightboxFavoriteVisuals(item);
  refreshIcons(elModalLightbox);
}

function closeLightbox() {
  currentLightboxLoadId++;
  if (lightboxHdTimeout) {
    clearTimeout(lightboxHdTimeout);
    lightboxHdTimeout = null;
  }
  elModalLightbox.classList.add("hidden");
  elLightboxImg.src = "";
  elLightboxVideo.pause();
  elLightboxVideo.src = "";
  updateSummary();
}

function navigateLightbox(direction) {
  const newIdx = lightboxIndex + direction;
  if (newIdx >= 0 && newIdx < lightboxItems.length) {
    openLightbox(newIdx, direction);
  }
}

// ----------------------------------------------------
// Burst Inspector Implementation
// ----------------------------------------------------

function preloadAdjacentBurstHd() {
  if (!currentBurstItem || !currentBurstItem.items.length) return;
  const total = currentBurstItem.items.length;
  for (let offset of [1, -1, 2, -2]) {
    const idx = activeBurstIdx + offset;
    if (idx >= 0 && idx < total) {
      if (currentBurstItem.items[idx]) preloadHdImage(currentBurstItem.items[idx].thumbnail_url);
    }
  }
}

function openBurstInspector(burstItem, startIdx) {
  currentBurstItem = burstItem;
  if (startIdx !== undefined) {
    activeBurstIdx = startIdx;
  } else {
    activeBurstIdx = burstItem.coverIndex !== undefined ? burstItem.coverIndex : burstItem.items.length - 1;
  }
  burstViewMode = 'solo';

  elModalBurstInspector.classList.remove("hidden");
  if (elBurstSoloImg.resetZoom) elBurstSoloImg.resetZoom();
  if (elBurstSplitImgActive.resetZoom) elBurstSplitImgActive.resetZoom();
  if (elBurstSplitImgRef.resetZoom) elBurstSplitImgRef.resetZoom();
  initBurstFilmstrip(burstItem);
  renderBurstInspector();
  refreshIcons(elModalBurstInspector);
}

function closeBurstInspector() {
  currentBurstSoloLoadId++;
  currentBurstSplitActiveLoadId++;
  currentBurstSplitRefLoadId++;
  if (burstSoloHdTimeout) { clearTimeout(burstSoloHdTimeout); burstSoloHdTimeout = null; }
  if (burstSplitActiveHdTimeout) { clearTimeout(burstSplitActiveHdTimeout); burstSplitActiveHdTimeout = null; }
  if (burstSplitRefHdTimeout) { clearTimeout(burstSplitRefHdTimeout); burstSplitRefHdTimeout = null; }
  elModalBurstInspector.classList.add("hidden");
  currentBurstItem = null;
  updateSummary();
}

function renderBurstInspector() {
  renderBurstInspectorCanvas();
  updateBurstInspectorUI();
}

function renderBurstInspectorCanvas() {
  if (!currentBurstItem || !currentBurstItem.items.length) return;

  if (burstSoloHdTimeout) { clearTimeout(burstSoloHdTimeout); burstSoloHdTimeout = null; }
  if (burstSplitActiveHdTimeout) { clearTimeout(burstSplitActiveHdTimeout); burstSplitActiveHdTimeout = null; }
  if (burstSplitRefHdTimeout) { clearTimeout(burstSplitRefHdTimeout); burstSplitRefHdTimeout = null; }

  const total = currentBurstItem.items.length;
  const activeItem = currentBurstItem.items[activeBurstIdx];
  const coverItem = currentBurstItem.items[currentBurstItem.coverIndex];

  // Stages
  if (burstViewMode === 'solo') {
    elBurstStageSolo.classList.remove('hidden');
    elBurstStageSplit.classList.add('hidden');
    
    const loadId = ++currentBurstSoloLoadId;
    const hdUrl = `${activeItem.thumbnail_url}?full=true`;
    const isZoomed = elBurstSoloImg.isZoomed && elBurstSoloImg.isZoomed();
    const zoomState = isZoomed ? elBurstSoloImg.getZoomState() : null;

    if (hdImageCache.has(hdUrl)) {
      elBurstSoloImg.src = hdUrl;
      if (zoomState) elBurstSoloImg.setZoomState(zoomState);
    } else {
      elBurstSoloImg.src = activeItem.thumbnail_url;
      if (zoomState) elBurstSoloImg.setZoomState(zoomState);

      const hdImg = new Image();
      hdImg.onload = () => {
        hdImageCache.add(hdUrl);
        if (currentBurstSoloLoadId === loadId && burstViewMode === 'solo' && currentBurstItem) {
          const currentZoom = elBurstSoloImg.isZoomed && elBurstSoloImg.isZoomed() ? elBurstSoloImg.getZoomState() : null;
          elBurstSoloImg.src = hdUrl;
          if (currentZoom) elBurstSoloImg.setZoomState(currentZoom);
        }
      };
      hdImg.src = hdUrl;
    }

    preloadAdjacentBurstHd();

  } else {
    elBurstStageSolo.classList.add('hidden');
    elBurstStageSplit.classList.remove('hidden');
    
    const loadActiveId = ++currentBurstSplitActiveLoadId;
    const loadRefId = ++currentBurstSplitRefLoadId;

    const hdActiveUrl = `${activeItem.thumbnail_url}?full=true`;
    const hdRefUrl = `${coverItem.thumbnail_url}?full=true`;

    const activeZoom = elBurstSplitImgActive.isZoomed && elBurstSplitImgActive.isZoomed() ? elBurstSplitImgActive.getZoomState() : null;
    const refZoom = elBurstSplitImgRef.isZoomed && elBurstSplitImgRef.isZoomed() ? elBurstSplitImgRef.getZoomState() : null;

    if (hdImageCache.has(hdActiveUrl)) {
      elBurstSplitImgActive.src = hdActiveUrl;
      if (activeZoom) elBurstSplitImgActive.setZoomState(activeZoom);
    } else {
      elBurstSplitImgActive.src = activeItem.thumbnail_url;
      if (activeZoom) elBurstSplitImgActive.setZoomState(activeZoom);

      const hdActiveImg = new Image();
      hdActiveImg.onload = () => {
        hdImageCache.add(hdActiveUrl);
        if (currentBurstSplitActiveLoadId === loadActiveId && burstViewMode === 'split' && currentBurstItem) {
          const z = elBurstSplitImgActive.isZoomed && elBurstSplitImgActive.isZoomed() ? elBurstSplitImgActive.getZoomState() : null;
          elBurstSplitImgActive.src = hdActiveUrl;
          if (z) elBurstSplitImgActive.setZoomState(z);
        }
      };
      hdActiveImg.src = hdActiveUrl;
    }

    if (hdImageCache.has(hdRefUrl)) {
      elBurstSplitImgRef.src = hdRefUrl;
      if (refZoom) elBurstSplitImgRef.setZoomState(refZoom);
    } else {
      elBurstSplitImgRef.src = coverItem.thumbnail_url;
      if (refZoom) elBurstSplitImgRef.setZoomState(refZoom);

      const hdRefImg = new Image();
      hdRefImg.onload = () => {
        hdImageCache.add(hdRefUrl);
        if (currentBurstSplitRefLoadId === loadRefId && burstViewMode === 'split' && currentBurstItem) {
          const z = elBurstSplitImgRef.isZoomed && elBurstSplitImgRef.isZoomed() ? elBurstSplitImgRef.getZoomState() : null;
          elBurstSplitImgRef.src = hdRefUrl;
          if (z) elBurstSplitImgRef.setZoomState(z);
        }
      };
      hdRefImg.src = hdRefUrl;
    }

    if (elBurstSplitActiveNum) {
      elBurstSplitActiveNum.textContent = `${activeBurstIdx + 1}/${total}`;
    }

    preloadAdjacentBurstHd();
  }
}

function initBurstFilmstrip(burstItem) {
  elBurstFilmstrip.innerHTML = '';
  burstItem.items.forEach((item, idx) => {
    const tile = document.createElement('div');
    const itemIsSelected = item.type === 'stack' ? selectedFiles.has(item.jpgFile.path) : selectedFiles.has(item.files[0].path);
    const itemIsStarred = item.type === 'stack' ? favoriteFiles.has(item.jpgFile.path) : favoriteFiles.has(item.files[0].path);

    tile.className = `filmstrip-item ${idx === activeBurstIdx ? 'active' : ''} ${idx === burstItem.coverIndex ? 'is-cover' : ''}`;
    tile.dataset.index = idx;
    
    let coverTag = idx === burstItem.coverIndex ? `<span class="filmstrip-cover-tag">DERNIÈRE</span>` : '';
    let starIcon = itemIsStarred ? `<i data-lucide="star" style="width:12px; height:12px; fill:#f59e0b; color:#f59e0b;"></i>` : '';

    tile.innerHTML = `
      <img src="${item.thumbnail_url}" alt="${item.name}" loading="lazy" decoding="async" />
      <input type="checkbox" class="filmstrip-check" ${itemIsSelected ? 'checked' : ''} />
      ${coverTag}
      <span class="filmstrip-badge">${idx + 1} <span class="filmstrip-star-holder">${starIcon}</span></span>
    `;

    tile.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT') return;
      activeBurstIdx = idx;
      renderBurstInspector();
    });

    tile.querySelector('.filmstrip-check').addEventListener('change', (e) => {
      e.stopPropagation();
      toggleItemSelection(item);
      updateBurstInspectorUI();
      updateBurstCardVisuals(currentBurstItem);
    });

    elBurstFilmstrip.appendChild(tile);
  });
  refreshIcons(elBurstFilmstrip);
}

function updateBurstInspectorUI() {
  if (!currentBurstItem || !currentBurstItem.items.length) return;

  const total = currentBurstItem.items.length;
  const activeItem = currentBurstItem.items[activeBurstIdx];

  if (elBtnBurstPrev && elBtnBurstNext) {
    const isFirstInTimeline = lightboxIndex === 0 && activeBurstIdx === 0;
    const isLastInTimeline = (lightboxIndex === lightboxItems.length - 1 || lightboxItems.length === 0) && activeBurstIdx === total - 1;
    elBtnBurstPrev.style.visibility = isFirstInTimeline ? "hidden" : "visible";
    elBtnBurstNext.style.visibility = isLastInTimeline ? "hidden" : "visible";
  }

  // Header texts
  elBurstInspectorTitle.textContent = `Visionneuse de Rafale (${total} photos)`;
  elBurstInspectorSubtitle.textContent = `Du cliché 1 à ${total} — ${currentBurstItem.date}`;

  // Mode toggles visuals
  elBtnBurstViewSolo.classList.toggle('active', burstViewMode === 'solo');
  elBtnBurstViewSplit.classList.toggle('active', burstViewMode === 'split');

  // Active item meta
  const isSelected = activeItem.type === 'stack' ? selectedFiles.has(activeItem.jpgFile.path) : selectedFiles.has(activeItem.files[0].path);
  const isStarred = activeItem.type === 'stack' ? favoriteFiles.has(activeItem.jpgFile.path) : favoriteFiles.has(activeItem.files[0].path);

  elBtnBurstActiveSelect.checked = isSelected;
  if (isStarred) {
    elBtnBurstActiveStar.classList.add("starred");
  } else {
    elBtnBurstActiveStar.classList.remove("starred");
  }

  if (activeItem.type === "stack") {
    elBurstActiveStackControl.classList.remove("hidden");
    const baseKey = activeItem.baseKey || activeItem.jpgFile.name.substring(0, activeItem.jpgFile.name.lastIndexOf('.')).toLowerCase();
    const smode = stackModes[baseKey] || "both";
    elBurstActiveStackControl.querySelectorAll('.mode-opt').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.mode === smode);
    });
  } else {
    elBurstActiveStackControl.classList.add("hidden");
  }

  let metaDesc = `${activeItem.name} — ${formatBytes(activeItem.size)}`;
  if (activeBurstIdx === currentBurstItem.coverIndex) {
    metaDesc += ` ⭐ [DERNIÈRE PHOTO]`;
  }
  elBurstActiveMeta.textContent = metaDesc;

  // Filmstrip state update (fast DOM update without re-creating <img> elements)
  const tiles = elBurstFilmstrip.querySelectorAll('.filmstrip-item');
  if (tiles.length !== currentBurstItem.items.length) {
    initBurstFilmstrip(currentBurstItem);
    return;
  }

  tiles.forEach((tile, idx) => {
    const item = currentBurstItem.items[idx];
    const itemIsSelected = item.type === 'stack' ? selectedFiles.has(item.jpgFile.path) : selectedFiles.has(item.files[0].path);
    const itemIsStarred = item.type === 'stack' ? favoriteFiles.has(item.jpgFile.path) : favoriteFiles.has(item.files[0].path);

    tile.classList.toggle('active', idx === activeBurstIdx);
    const cb = tile.querySelector('.filmstrip-check');
    if (cb) cb.checked = itemIsSelected;

    const starHolder = tile.querySelector('.filmstrip-star-holder');
    if (starHolder) {
      const starIcon = itemIsStarred ? `<i data-lucide="star" style="width:12px; height:12px; fill:#f59e0b; color:#f59e0b;"></i>` : '';
      if (starHolder.innerHTML !== starIcon) {
        starHolder.innerHTML = starIcon;
        refreshIcons(starHolder);
      }
    }
  });

  const activeTile = tiles[activeBurstIdx];
  if (activeTile) {
    activeTile.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }
}

// ----------------------------------------------------
// Summary & Import Actions
// ----------------------------------------------------

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

  const dates = Object.keys(scannedDays);
  for (let i = 0; i < dates.length; i++) {
    const files = scannedDays[dates[i]];
    for (let j = 0; j < files.length; j++) {
      const file = files[j];
      if (selectedFiles.has(file.path)) {
        totalSize += file.size;
        if (file.file_type === 'jpg') countJpg++;
        else if (file.file_type === 'raw') countRaw++;
        else if (file.file_type === 'video') countVid++;
      }
    }
  }

  let parts = [];
  if (countJpg > 0) parts.push(`${countJpg} JPG`);
  if (countRaw > 0) parts.push(`${countRaw} RAW`);
  if (countVid > 0) parts.push(`${countVid} Vidéo${countVid > 1 ? 's' : ''}`);

  elTxtSummary.textContent = `${selectedFiles.size} fichier${selectedFiles.size > 1 ? 's' : ''} sélectionné${selectedFiles.size > 1 ? 's' : ''} (${parts.join(', ')}) — Taille totale : ${formatBytes(totalSize)}`;
  elBtnImport.disabled = false;
}

// Start SD Card Scan
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
    const elScanProgressFill = document.querySelector("#scan-progress-fill");
    const elScanStatusText = document.querySelector("#scan-status-text");
    if (elScanProgressFill) elScanProgressFill.style.width = "0%";
    if (elScanStatusText) elScanStatusText.textContent = "Recherche des fichiers...";

    unlistenScan = await listen("scan-progress", (event) => {
      const { current, total, file_name } = event.payload;
      const percentage = Math.round((current / total) * 100);
      if (elScanProgressFill) elScanProgressFill.style.width = `${percentage}%`;
      if (elScanStatusText) elScanStatusText.textContent = `[${current}/${total}] Analyse de ${file_name}...`;
    });

    scannedDays = await invoke("scan_source", { sourcePath });

    // Compute and memoize grouping cache once per scan
    cachedGroupedDays = {};
    Object.keys(scannedDays).forEach(date => {
      cachedGroupedDays[date] = groupDayItems(scannedDays[date]);
    });

    selectedFiles.clear();
    favoriteFiles.clear();
    stackModes = {};

    // Group into items and select ONLY the LAST photo of each burst sequence by default!
    Object.keys(cachedGroupedDays).forEach(date => {
      const items = cachedGroupedDays[date];
      items.forEach(item => {
        if (item.type === 'burst') {
          const coverItem = item.items[item.coverIndex];
          selectItem(coverItem);
        } else {
          selectItem(item);
        }
      });
    });

    renderTimeline();
    updateSummary();

  } catch (error) {
    console.error(error);
    alert(`Erreur de scan : ${error}`);
    elEmptyState.classList.remove('hidden');
  } finally {
    if (unlistenScan) unlistenScan();
    elScanLoader.classList.add('hidden');
    elBtnScan.disabled = false;
  }
}

// Run Import operation
async function runImport() {
  const destPath = elDestPath.value.trim();
  if (!destPath) {
    alert("Veuillez renseigner un dossier de destination.");
    return;
  }

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

  elModalImport.classList.remove('hidden');
  elImportProgressView.classList.remove('hidden');
  elImportReportView.classList.add('hidden');
  elBtnModalClose.classList.add('hidden');
  elImportProgressFill.style.width = '0%';
  elModalTitle.innerHTML = `<i data-lucide="loader-2" class="spin"></i> Importation en cours...`;
  refreshIcons(elModalImport);

  let totalFilesToCopy = 0;
  let copiedCount = 0;
  let favoriteCount = 0;
  let savedBytes = 0;

  importDaysConfig.forEach(day => {
    totalFilesToCopy += day.files.length;
    day.files.forEach(f => {
      if (f.is_favorite) {
        favoriteCount++;
        const details = Object.values(scannedDays).flat().find(sd => sd.path === f.source_path);
        if (details) savedBytes += details.size;
      }
    });
  });

  try {
    elImportStatusText.textContent = `Préparation de l'importation...`;
    
    const unlistenImport = await listen("import-progress", (event) => {
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

    copiedCount = totalFilesToCopy;
    elStatCopied.textContent = copiedCount;
    elStatFavs.textContent = favoriteCount;
    elStatSaved.textContent = formatBytes(savedBytes);

    elImportProgressView.classList.add('hidden');
    elImportReportView.classList.remove('hidden');
    elBtnModalClose.classList.remove('hidden');
    elModalTitle.innerHTML = `<i data-lucide="check" style="color: #10b981"></i> Terminé`;
    refreshIcons(elModalImport);

  } catch (error) {
    console.error(error);
    alert(`Erreur d'importation : ${error}`);
    elModalImport.classList.add('hidden');
  }
}

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

  toggleItemSelection(item);
  updateLightboxSelectionVisuals(item);
  updateTimelineCardVisuals(item);
  updateSummary();
}

function toggleLightboxFavorite() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;

  toggleItemFavorite(item);
  updateLightboxFavoriteVisuals(item);
  updateLightboxSelectionVisuals(item);
  updateTimelineCardVisuals(item);
  updateSummary();
}

function updateLightboxMetadata(item) {
  if (!item) return;
  elLightboxFilename.textContent = item.name;

  let displaySize = item.size;
  let activeExtensions = item.files ? item.files.map(f => f.name.split('.').pop().toUpperCase()).join("+") : '';

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
}

function toggleLightboxStackMode() {
  const item = lightboxItems[lightboxIndex];
  if (!item || item.type !== 'stack') return;

  const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
  const currentMode = stackModes[baseKey] || 'both';
  const newMode = currentMode === 'both' ? 'jpg' : 'both';

  setStackMode(baseKey, newMode);
  updateLightboxMetadata(item);
  updateTimelineCardVisuals(item);
}

function toggleBurstActiveStackMode() {
  if (!currentBurstItem) return;
  const activeItem = currentBurstItem.items[activeBurstIdx];
  if (!activeItem || activeItem.type !== 'stack') return;

  const baseKey = activeItem.baseKey || activeItem.jpgFile.name.substring(0, activeItem.jpgFile.name.lastIndexOf('.')).toLowerCase();
  const currentMode = stackModes[baseKey] || 'both';
  const newMode = currentMode === 'both' ? 'jpg' : 'both';

  setStackMode(baseKey, newMode);
  updateBurstInspectorUI();
  updateBurstCardVisuals(currentBurstItem);
}

function updateBurstCardVisuals(burstItem) {
  if (!burstItem || !burstItem.items || !burstItem.items.length) return;
  const coverItem = burstItem.items[burstItem.coverIndex !== undefined ? burstItem.coverIndex : burstItem.items.length - 1];
  const coverPath = coverItem.type === 'stack' ? coverItem.jpgFile.path : coverItem.files[0].path;
  const card = document.querySelector(`.file-card.card-burst[data-path="${coverPath}"]`);
  if (!card) return;

  const info = getBurstSelectionInfo(burstItem);
  const isStarred = burstItem.items.some(item =>
    item.type === 'stack' ? favoriteFiles.has(item.jpgFile.path) : favoriteFiles.has(item.files[0].path)
  );

  card.classList.toggle('selected', !info.isNone);
  const cb = card.querySelector('.item-checkbox');
  if (cb) {
    cb.checked = info.isAll;
    cb.indeterminate = info.isPartial;
  }
  const labelSmall = card.querySelector('.file-name small');
  if (labelSmall) {
    labelSmall.textContent = `(${info.selectedCount}/${info.totalCount} sél.)`;
  }
  const starBtn = card.querySelector('.btn-star');
  if (starBtn) {
    starBtn.classList.toggle('starred', isStarred);
  }

  const dayBlock = card.closest('.day-block');
  if (dayBlock) updateDayHeaderSelectionState(dayBlock);
}

function updateTimelineCardVisuals(item) {
  if (!item) return;
  const itemKey = item.type === 'stack' ? item.jpgFile.path : (item.files && item.files.length > 0 ? item.files[0].path : null);
  if (itemKey) {
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

      // If it's a stack, update stack mode pill and badge
      if (item.type === 'stack') {
        const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
        const mode = stackModes[baseKey] || 'both';
        cardEl.querySelectorAll('.stack-mode-pill .mode-opt').forEach(opt => {
          opt.classList.toggle('active', opt.dataset.mode === mode);
        });

        const badge = cardEl.querySelector('.type-badge');
        const sizeLabel = cardEl.querySelector('.file-size');
        if (mode === 'jpg') {
          if (badge) {
            badge.className = 'type-badge badge-jpg';
            badge.textContent = 'jpg';
          }
          if (sizeLabel) sizeLabel.textContent = formatBytes(item.jpgFile.size);
        } else {
          if (badge) {
            badge.className = 'type-badge badge-raw-jpg';
            badge.textContent = 'raw+jpg';
          }
          if (sizeLabel) sizeLabel.textContent = formatBytes(item.size);
        }
      }

      const dayBlock = cardEl.closest('.day-block');
      if (dayBlock) updateDayHeaderSelectionState(dayBlock);
    }
  }

  if (currentBurstItem) {
    updateBurstCardVisuals(currentBurstItem);
  }
}

// ----------------------------------------------------
// DOMContentLoaded Event Binding
// ----------------------------------------------------

window.addEventListener("DOMContentLoaded", async () => {
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
  elStatCopied = document.querySelector("#stat-copied");
  elStatFavs = document.querySelector("#stat-favs");
  elStatSaved = document.querySelector("#stat-saved");

  // Fetch and display version
  try {
    const version = await invoke("get_app_version");
    const badge = document.querySelector("#app-version-badge");
    if (badge && version) {
      badge.textContent = "v" + version;
    }
  } catch (e) {
    console.warn("Could not fetch app version:", e);
  }
  
  elBtnSelectSource = document.querySelector("#btn-select-source");
  elBtnSelectDest = document.querySelector("#btn-select-dest");
  
  elTimelineControls = document.querySelector("#timeline-controls");
  elBtnSelectAll = document.querySelector("#btn-select-all");
  elBtnDeselectAll = document.querySelector("#btn-deselect-all");
  elBtnGlobalBoth = document.querySelector("#btn-global-both");
  elBtnGlobalJpg = document.querySelector("#btn-global-jpg");
  elBtnModeCopy = document.querySelector("#btn-mode-copy");
  elBtnModeCut = document.querySelector("#btn-mode-cut");

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

  // Burst Inspector Bindings
  elModalBurstInspector = document.querySelector("#modal-burst-inspector");
  elBurstInspectorTitle = document.querySelector("#burst-inspector-title");
  elBurstInspectorSubtitle = document.querySelector("#burst-inspector-subtitle");
  elBtnBurstViewSolo = document.querySelector("#btn-burst-view-solo");
  elBtnBurstViewSplit = document.querySelector("#btn-burst-view-split");
  elBtnBurstClose = document.querySelector("#btn-burst-close");
  elBurstStageSolo = document.querySelector("#burst-stage-solo");
  elBurstStageSplit = document.querySelector("#burst-stage-split");
  elBurstSoloImg = document.querySelector("#burst-solo-img");
  elBurstSplitImgActive = document.querySelector("#burst-split-img-active");
  elBurstSplitImgRef = document.querySelector("#burst-split-img-ref");
  elBurstSplitActiveNum = document.querySelector("#burst-split-active-num");
  elBurstActiveMeta = document.querySelector("#burst-active-meta");
  elBtnBurstActiveSelect = document.querySelector("#btn-burst-active-select");
  elBtnBurstActiveStar = document.querySelector("#btn-burst-active-star");
  elBurstActiveStackControl = document.querySelector("#burst-active-stack-control");
  elBtnBurstKeepLast = document.querySelector("#btn-burst-keep-last");
  elBtnBurstKeepStarred = document.querySelector("#btn-burst-keep-starred");
  elBtnBurstSelectAll = document.querySelector("#btn-burst-select-all");
  elBtnBurstDeselectAll = document.querySelector("#btn-burst-deselect-all");
  elBtnBurstPrev = document.querySelector("#btn-burst-prev");
  elBtnBurstNext = document.querySelector("#btn-burst-next");
  elBurstFilmstrip = document.querySelector("#burst-filmstrip");

  // Enable Zoom
  enableZoom(elLightboxImg);
  enableZoom(elBurstSoloImg);
  enableZoom(elBurstSplitImgActive);
  enableZoom(elBurstSplitImgRef);

  // Event Listeners
  elBtnScan.addEventListener("click", startScan);
  elBtnImport.addEventListener("click", runImport);

  elBtnSelectAll.addEventListener("click", () => {
    Object.keys(cachedGroupedDays).forEach(date => {
      cachedGroupedDays[date].forEach(item => {
        if (item.type === 'burst') {
          item.items.forEach(sub => selectItem(sub));
        } else {
          selectItem(item);
        }
      });
    });
    updateAllCardsDOM();
    updateSummary();
  });

  elBtnDeselectAll.addEventListener("click", () => {
    selectedFiles.clear();
    updateAllCardsDOM();
    updateSummary();
  });

  elBtnGlobalBoth.addEventListener("click", () => setGlobalStackMode("both"));
  elBtnGlobalJpg.addEventListener("click", () => setGlobalStackMode("jpg"));

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
    const selected = await invoke("select_folder", { title: "Sélectionner le dossier source (Carte SD)" });
    if (selected) elSourcePath.value = selected;
  });

  elBtnSelectDest.addEventListener("click", async () => {
    const selected = await invoke("select_folder", { title: "Sélectionner le dossier de destination (Archivage)" });
    if (selected) elDestPath.value = selected;
  });

  elBtnModalClose.addEventListener("click", () => {
    elModalImport.classList.add('hidden');

    // If original source files were moved/deleted from SD Card, update state
    if (deleteSourceAfterImport) {
      Object.keys(scannedDays).forEach(date => {
        scannedDays[date] = scannedDays[date].filter(f => !selectedFiles.has(f.path));
        if (scannedDays[date].length === 0) {
          delete scannedDays[date];
          delete cachedGroupedDays[date];
        } else {
          cachedGroupedDays[date] = groupDayItems(scannedDays[date]);
        }
      });
    }

    selectedFiles.clear();
    renderTimeline();
    updateSummary();
  });

  elBtnLightboxClose.addEventListener("click", closeLightbox);
  elBtnLightboxPrev.addEventListener("click", () => navigateLightbox(-1));
  elBtnLightboxNext.addEventListener("click", () => navigateLightbox(1));
  elBtnLightboxSelect.addEventListener("change", toggleLightboxSelection);
  elBtnLightboxStar.addEventListener("click", toggleLightboxFavorite);

  elLightboxStackControl.addEventListener("click", (e) => {
    const opt = e.target.closest('.mode-opt');
    if (!opt) return;
    const mode = opt.dataset.mode;
    const item = lightboxItems[lightboxIndex];
    if (item && item.type === 'stack') {
      const baseKey = item.jpgFile.name.substring(0, item.jpgFile.name.lastIndexOf('.')).toLowerCase();
      setStackMode(baseKey, mode);
      updateLightboxMetadata(item);
      updateTimelineCardVisuals(item);
    }
  });

  elModalLightbox.addEventListener("click", (e) => {
    if (e.target === elModalLightbox) closeLightbox();
  });

  // Burst Inspector Listeners
  elBtnBurstClose.addEventListener("click", closeBurstInspector);

  elBtnBurstViewSolo.addEventListener("click", () => {
    burstViewMode = 'solo';
    renderBurstInspector();
  });

  elBtnBurstViewSplit.addEventListener("click", () => {
    burstViewMode = 'split';
    renderBurstInspector();
  });

  elBtnBurstPrev.addEventListener("click", () => {
    if (currentBurstItem && activeBurstIdx > 0) {
      activeBurstIdx--;
      renderBurstInspector();
    } else if (lightboxIndex !== -1 && lightboxIndex > 0) {
      closeBurstInspector();
      openLightbox(lightboxIndex - 1, -1);
    }
  });

  elBtnBurstNext.addEventListener("click", () => {
    if (currentBurstItem && activeBurstIdx < currentBurstItem.items.length - 1) {
      activeBurstIdx++;
      renderBurstInspector();
    } else if (lightboxIndex !== -1 && lightboxIndex < lightboxItems.length - 1) {
      closeBurstInspector();
      openLightbox(lightboxIndex + 1, 1);
    }
  });

  elBtnBurstActiveSelect.addEventListener("change", () => {
    if (!currentBurstItem) return;
    const activeItem = currentBurstItem.items[activeBurstIdx];
    toggleItemSelection(activeItem);
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
  });

  elBtnBurstActiveStar.addEventListener("click", () => {
    if (!currentBurstItem) return;
    const activeItem = currentBurstItem.items[activeBurstIdx];
    toggleItemFavorite(activeItem);
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
  });

  elBurstActiveStackControl.addEventListener("click", (e) => {
    if (!currentBurstItem) return;
    const activeItem = currentBurstItem.items[activeBurstIdx];
    if (activeItem.type !== "stack") return;

    if (e.target.classList.contains('mode-opt')) {
      const mode = e.target.dataset.mode;
      const baseKey = activeItem.baseKey || activeItem.jpgFile.name.substring(0, activeItem.jpgFile.name.lastIndexOf('.')).toLowerCase();
      setStackMode(baseKey, mode);
      updateBurstInspectorUI();
      updateBurstCardVisuals(currentBurstItem);
    }
  });

  elBtnBurstKeepLast.addEventListener("click", () => {
    if (!currentBurstItem) return;
    const lastItem = currentBurstItem.items[currentBurstItem.coverIndex];
    currentBurstItem.items.forEach(it => deselectItem(it));
    selectItem(lastItem);
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
    updateSummary();
  });

  elBtnBurstKeepStarred.addEventListener("click", () => {
    if (!currentBurstItem) return;
    currentBurstItem.items.forEach(it => {
      const isStarred = it.type === 'stack' ? favoriteFiles.has(it.jpgFile.path) : favoriteFiles.has(it.files[0].path);
      if (isStarred) selectItem(it);
      else deselectItem(it);
    });
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
    updateSummary();
  });

  elBtnBurstSelectAll.addEventListener("click", () => {
    if (!currentBurstItem) return;
    currentBurstItem.items.forEach(it => selectItem(it));
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
    updateSummary();
  });

  elBtnBurstDeselectAll.addEventListener("click", () => {
    if (!currentBurstItem) return;
    currentBurstItem.items.forEach(it => deselectItem(it));
    updateBurstInspectorUI();
    updateBurstCardVisuals(currentBurstItem);
    updateSummary();
  });

  elModalBurstInspector.addEventListener("click", (e) => {
    if (e.target === elModalBurstInspector) closeBurstInspector();
  });

  // Global Keyboard Navigation (Lightbox & Burst Inspector)
  window.addEventListener("keydown", (e) => {
    // Burst Inspector Keyboard Controls
    if (!elModalBurstInspector.classList.contains("hidden")) {
      if (e.key === "Escape") {
        closeBurstInspector();
      } else if (e.key === "ArrowLeft") {
        if (activeBurstIdx > 0) {
          activeBurstIdx--;
          renderBurstInspector();
        } else if (lightboxIndex !== -1 && lightboxIndex > 0) {
          closeBurstInspector();
          openLightbox(lightboxIndex - 1, -1);
        }
      } else if (e.key === "ArrowRight") {
        if (activeBurstIdx < currentBurstItem.items.length - 1) {
          activeBurstIdx++;
          renderBurstInspector();
        } else if (lightboxIndex !== -1 && lightboxIndex < lightboxItems.length - 1) {
          closeBurstInspector();
          openLightbox(lightboxIndex + 1, 1);
        }
      } else if (e.key === " " || e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (currentBurstItem) {
          const activeItem = currentBurstItem.items[activeBurstIdx];
          toggleItemSelection(activeItem);
          updateBurstInspectorUI();
          updateBurstCardVisuals(currentBurstItem);
        }
      } else if (e.key.toLowerCase() === "f") {
        if (currentBurstItem) {
          const activeItem = currentBurstItem.items[activeBurstIdx];
          toggleItemFavorite(activeItem);
          updateBurstInspectorUI();
          updateBurstCardVisuals(currentBurstItem);
        }
      } else if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === "m") {
        e.preventDefault();
        if (e.repeat) return;
        toggleBurstActiveStackMode();
      }
      return;
    }

    // Lightbox Keyboard Controls
    if (!elModalLightbox.classList.contains("hidden")) {
      if (e.key === "Escape") {
        closeLightbox();
      } else if (e.key === "ArrowLeft") {
        navigateLightbox(-1);
      } else if (e.key === "ArrowRight") {
        navigateLightbox(1);
      } else if (e.key === " " || e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.repeat) return;
        toggleLightboxSelection();
      } else if (e.key.toLowerCase() === "f") {
        if (e.repeat) return;
        toggleLightboxFavorite();
      } else if (e.key.toLowerCase() === "r" || e.key.toLowerCase() === "m") {
        e.preventDefault();
        if (e.repeat) return;
        toggleLightboxStackMode();
      }
    }
  });

  refreshIcons();
});
