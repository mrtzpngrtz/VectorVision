let images = [];
let currentVisibleImages = [];
let hoveredIndex = -1;
let hardwareAccel = 'NATIVE_ONNX';
const mapContainer = document.getElementById('map-container');
const statusDiv = document.getElementById('status');
const statusDescDiv = document.getElementById('status-description');
const progressDiv = document.getElementById('progress');
const semanticInfoDiv = document.getElementById('semantic-info');
const loaderEl = document.getElementById('main-loader');
const statusProgress = document.getElementById('status-progress');
const fpsCounterEl = document.getElementById('fps-counter');

// Initialize Canvas Renderer
let renderer = null;
const renderCanvas = document.getElementById('render-canvas');
if (renderCanvas) {
    renderer = new CanvasRenderer(renderCanvas, {
        worldSize: 4000,
        gridDotSize: 40,
        imageSize2D: 80,
        imageSize3D: 80
    });
    
    // Set up interaction callbacks
    renderer.onHover = (item, index) => {
        if (item) {
            hoveredIndex = index;
            let content = `ID: ${item.name.toUpperCase()}<br>`;
            if (item.keywords && item.keywords.length > 0) {
                const tags = item.keywords.map(k => k.className.toUpperCase()).join(', ');
                content += `TAGS: ${tags}<br>`;
            }
            if (item.aestheticScore !== undefined && item.aestheticScore !== null) {
                const score = item.aestheticScore.toFixed(2);
                const stars = '★'.repeat(Math.round(item.aestheticScore / 2));
                content += `SCORE: ${score}/10 ${stars}<br>`;
            } else {
                content += `SCORE: N/A (Rescan to add)<br>`;
            }
            if (item.palette && item.palette.length > 0) {
                content += `PALETTE:<br>`;
                content += `<div class="palette-container">`;
                item.palette.forEach(c => {
                    content += `<div class="palette-swatch" style="background: rgb(${c[0]},${c[1]},${c[2]})" title="RGB: ${c.join(',')}"></div>`;
                });
                content += `</div>`;
            } else {
                content += `PALETTE: Scanning... (Rescan if missing)<br>`;
            }
            semanticInfoDiv.innerHTML = content;
            
            // Show semantic similarity when Shift is pressed OR when a tag filter is active
            const searchInput = document.getElementById('search-input');
            const hasActiveFilter = searchInput && searchInput.value.trim().length > 0;
            
            if (isShiftPressed || hasActiveFilter) {
                highlightNeighbors(index);
            }
            
            // Update preview image
            const previewImg = document.getElementById('preview-img');
            const previewPlaceholder = document.getElementById('preview-placeholder');
            if (previewImg && previewPlaceholder) {
                const imageUrl = isElectron ? `file:///${item.path.replace(/\\/g, '/')}` : (item.url || item.thumbUrl);
                const tempImg = new Image();
                tempImg.onload = () => {
                    previewImg.src = imageUrl;
                    previewImg.style.display = 'block';
                    previewPlaceholder.style.display = 'none';
                };
                tempImg.onerror = () => {};
                tempImg.src = imageUrl;
            }
        } else {
            hoveredIndex = -1;
            if (semanticInfoDiv) {
                semanticInfoDiv.textContent = 'Hover over an image to see details...';
            }
            clearHighlight();
            const previewImg = document.getElementById('preview-img');
            const previewPlaceholder = document.getElementById('preview-placeholder');
            if (previewImg && previewPlaceholder) {
                previewImg.style.display = 'none';
                previewPlaceholder.style.display = 'block';
                previewImg.src = '';
            }
        }
    };
    
    renderer.onClick = (item, index) => {
        // Zoom to image
        const coords = getItemCoordinates(item, index);
        zoomToImage(coords.x, coords.y, coords.z, coords.size, coords.size);
    };
    
    renderer.onDoubleClick = (item, index) => {
        showLightbox(index);
    };
    
    renderer.onRightClick = (item, index) => {
        // Check if Ctrl is pressed for vibe gradient mode
        if (event.ctrlKey) {
            setVibeAnchor(index, item);
        } else {
            // Set as reference for similarity sorting
            setReferenceImage(index);
            statusDiv.textContent = 'REFERENCE_IMAGE_SET';
            setTimeout(() => {
                if (statusDiv.textContent === 'REFERENCE_IMAGE_SET') {
                    statusDiv.textContent = 'SYSTEM_READY';
                }
            }, 1500);
        }
    };
    
    // Set up native event handlers for camera control
    renderCanvas.addEventListener('mousemove', (e) => renderer.handleMouseMove(e));
    renderCanvas.addEventListener('click', (e) => renderer.handleClick(e));
    renderCanvas.addEventListener('dblclick', (e) => renderer.handleDoubleClick(e));
    renderCanvas.addEventListener('contextmenu', (e) => renderer.handleRightClick(e));
}

// Helper function to get item coordinates based on current sort mode
function getItemCoordinates(item, index) {
    let x = 0, y = 0, z = 0, size = is3D ? 80 : 80;
    
    if (currentSort === 'grid') {
        if (is3D) {
            const side = Math.ceil(Math.cbrt(currentVisibleImages.length));
            x = index % side;
            y = Math.floor(index / side) % side;
            z = Math.floor(index / (side * side));
        } else {
            const cols = Math.ceil(Math.sqrt(currentVisibleImages.length));
            x = index % cols;
            y = Math.floor(index / cols);
        }
    } else if (currentSort === 'color') {
        x = is3D ? item.xC3 : item.xC;
        y = is3D ? item.yC3 : item.yC;
        z = is3D ? item.zC3 : 0;
    } else if (currentSort === 'lightness') {
        x = item.xLight;
        y = item.yLight;
        z = is3D ? item.zLight : 0;
    } else if (currentSort === 'similarity') {
        x = item.xSim;
        y = item.ySim;
        z = 0;
    } else if (currentSort === 'vibe') {
        x = item.xVibe;
        y = item.yVibe;
        z = 0;
    } else {
        x = is3D ? item.x3 : item.x;
        y = is3D ? item.y3 : item.y;
        z = is3D ? item.z3 : 0;
    }
    
    return { x, y, z, size };
}

// Check if running in Electron
const isElectron = window.electronAPI !== undefined;

// Helper function to update status with description
function updateStatus(code, description = null) {
    statusDiv.textContent = code;
    if (statusDescDiv && description) {
        statusDescDiv.textContent = description;
    } else if (statusDescDiv) {
        // Auto-generate description based on status code
        const descriptions = {
            'TRAINING': 'Training neural network to organize images by similarity...',
            'ANALYZING_NATIVE': 'Extracting visual features and identifying objects in images...',
            'ANALYZING_STREAM': 'Processing images with AI to detect objects and themes...',
            'FILESYSTEM_SCAN': 'Scanning folder for image files...',
            'MAPPING_SEMANTIC_2D': 'Organizing images by semantic similarity in 2D space...',
            'MAPPING_SEMANTIC_3D': 'Organizing images by semantic similarity in 3D space...',
            'MAPPING_COLOR_SPACE': 'Arranging images by color relationships...',
            'MAPPING_LIGHTNESS': 'Sorting images by brightness values...',
            'LOADING_NATIVE_CLIP': 'Loading AI vision model for image analysis...',
            'BOOTSTRAPPING_CLIP': 'Initializing image recognition system...',
            'SYSTEM_READY': 'All systems operational. Ready to explore your images.',
            'FILTERING...': 'Searching images and reorganizing matches...',
            'CLUSTERING': 'Grouping matched images by visual similarity...',
            'INIT_DB_LOAD': 'Loading saved analysis data...',
            'ANALYSIS_REQUIRED': 'New images detected. Preparing to analyze...',
            'FORCING_RESCAN': 'Re-analyzing all images with latest AI models...',
            'LOADING_LIBRARY': 'Loading image library...',
            'SCANNING_NEW_LIBRARY': 'Indexing new image library...'
        };
        
        // Check if it starts with certain patterns
        if (code.startsWith('TRAINING:')) {
            statusDescDiv.textContent = 'Training neural network to organize images by similarity...';
        } else if (code.startsWith('CLUSTERING:')) {
            statusDescDiv.textContent = 'Grouping matched images by visual similarity...';
        } else if (descriptions[code]) {
            statusDescDiv.textContent = descriptions[code];
        } else {
            statusDescDiv.textContent = '';
        }
    }
}

// Library Management Variables
let libraries = [];
let currentLibrary = null;
let pendingLibraryAction = null;
let selectedLibraryId = null;
let activeColorFilter = null;
let activeMediaFilter = 'all'; // 'all', 'video', or 'static'
let activeScoreFilter = 0; // Minimum aesthetic score filter (0-10)

function setLoading(active) {
    const loadingOverlay = document.getElementById('loading-overlay');
    if (loadingOverlay) {
        loadingOverlay.style.display = active ? 'flex' : 'none';
    }
    if (active) statusDiv.classList.add('analyzing');
    else statusDiv.classList.remove('analyzing');
}

let is3D = false;
let currentSort = 'semantic'; // 'semantic', 'similarity', 'color', 'grid', 'lightness', 'vibe'
let som2D = null;
let som3D = null;
let similarityReferenceIndex = null;
let similarityReferenceImage = null;
let vibeAnchorStart = null; // First anchor for vibe gradient
let vibeAnchorEnd = null;   // Second anchor for vibe gradient

function toggleSidebarSection(id) {
    const el = document.getElementById(id);
    if (!el) return;
    
    // Get chevron
    const label = el.parentElement.querySelector('.section-label .chevron');
    
    if (el.style.display === 'none') {
        el.style.display = 'flex';
        if (label) label.style.transform = 'rotate(0deg)';
    } else {
        el.style.display = 'none';
        if (label) label.style.transform = 'rotate(-90deg)';
    }
}

function toggleUI() {
    document.body.classList.toggle('ui-hidden');
    const btn = document.getElementById('bottom-ui-toggle');
    if (btn) {
        const isHidden = document.body.classList.contains('ui-hidden');
        btn.textContent = isHidden ? 'SHOW UI' : 'HIDE UI';
    }
}

function toggleSection(sectionId) {
    const section = document.getElementById(sectionId);
    const header = event.target.closest('.collapsible-header');
    
    if (section.style.display === 'none') {
        section.style.display = 'block';
        if (header) header.classList.add('expanded');
    } else {
        section.style.display = 'none';
        if (header) header.classList.remove('expanded');
    }
}

// --- Lightbox Logic ---
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
let currentLightboxPath = null;
let currentLightboxIndex = -1;

// Initialize state to ensure checks work
lightbox.style.display = 'none';

function showLightbox(indexOrUrl) {
    const lightboxVideo = document.getElementById('lightbox-video');
    
    if (typeof indexOrUrl === 'number') {
        // Index mode (supports navigation)
        const index = indexOrUrl;
        if (index < 0 || index >= currentVisibleImages.length) return;
        
        currentLightboxIndex = index;
        const img = currentVisibleImages[index];
        
        const url = isElectron ? `file:///${img.path.replace(/\\/g, '/')}` : (img.url || img.thumbUrl);
        currentLightboxPath = img.path;
        
        // Check if it's a video file
        const ext = img.path ? img.path.toLowerCase() : '';
        const isVideoFile = ext.endsWith('.mp4') || ext.endsWith('.webm');
        
        if (isVideoFile) {
            // Show video element, hide image
            lightboxImg.style.display = 'none';
            lightboxVideo.style.display = 'block';
            lightboxVideo.src = url;
        } else {
            // Show image element, hide video
            lightboxVideo.style.display = 'none';
            lightboxImg.style.display = 'block';
            lightboxImg.src = url;
        }
    } else {
        // Legacy URL mode (no navigation)
        const ext = indexOrUrl.toLowerCase();
        const isVideoFile = ext.endsWith('.mp4') || ext.endsWith('.webm');
        
        if (isVideoFile) {
            lightboxImg.style.display = 'none';
            lightboxVideo.style.display = 'block';
            lightboxVideo.src = indexOrUrl;
        } else {
            lightboxVideo.style.display = 'none';
            lightboxImg.style.display = 'block';
            lightboxImg.src = indexOrUrl;
        }
        
        currentLightboxPath = null;
        if (indexOrUrl.startsWith('file:///')) {
            try {
                currentLightboxPath = decodeURIComponent(indexOrUrl.replace('file:///', ''));
            } catch (e) {}
        }
    }
    lightbox.style.display = 'flex';
}

function navigateLightbox(direction) {
    if (currentLightboxIndex === -1 || currentVisibleImages.length === 0) return;
    
    let newIndex = currentLightboxIndex + direction;
    if (newIndex < 0) newIndex = currentVisibleImages.length - 1;
    if (newIndex >= currentVisibleImages.length) newIndex = 0;
    
    showLightbox(newIndex);
}

async function copyLightboxImage() {
    if (!currentLightboxPath || !isElectron) return;
    const res = await window.electronAPI.copyToClipboard(currentLightboxPath);
    if (res.success) {
        statusDiv.textContent = 'COPIED_TO_CLIPBOARD';
        setTimeout(() => statusDiv.textContent = 'SYSTEM_READY', 2000);
    }
}

async function saveLightboxImage() {
    if (!currentLightboxPath || !isElectron) return;
    await window.electronAPI.saveImage(currentLightboxPath);
}

async function openLightboxFolder() {
    if (!currentLightboxPath || !isElectron) return;
    await window.electronAPI.openInFolder(currentLightboxPath);
}

lightbox.onclick = (e) => {
    if (e.target.closest('.lightbox-btn')) return;
    if (e.target.closest('#lightbox-img')) return;
    lightbox.style.display = 'none';
    lightboxImg.src = '';
};

// --- SOM Worker Initialization ---
let somWorker = null;

function initSOMWorker() {
    if (somWorker) return somWorker;
    
    somWorker = new Worker('js/som-worker.js');
    
    somWorker.onerror = (error) => {
        console.error('SOM Worker Error:', error);
        statusDiv.textContent = 'ERR: WORKER_FAILED';
        setLoading(false);
    };
    
    return somWorker;
}

// Train SOM using Web Worker (non-blocking)
function trainSOMAsync(vectors, width, height, depth, iterations) {
    return new Promise((resolve, reject) => {
        const worker = initSOMWorker();
        
        // Set up message handler for this training session
        const messageHandler = (e) => {
            const { type, data } = e.data;
            
            if (type === 'progress') {
                const { current, total } = data;
                updateStatus(`TRAINING: ${Math.round(current/total*100)}%`);
            } else if (type === 'complete') {
                worker.removeEventListener('message', messageHandler);
                resolve(data.positions);
            }
        };
        
        worker.addEventListener('message', messageHandler);
        
        // Send training job to worker
        worker.postMessage({
            type: 'train',
            data: { width, height, depth, vectors, iterations }
        });
    });
}

// Native folder picker dialog
async function selectFolderDialog() {
    if (!isElectron) return;
    
    try {
        const result = await window.electronAPI.selectFolder();
        if (result.path) {
            document.getElementById('folder-path').value = result.path;
            // Auto-scan after folder selection
            scanFolder();
        }
    } catch (error) {
        console.error('Error selecting folder:', error);
    }
}

// --- App Logic ---
async function scanFolder() {
    if (!currentLibrary) {
        statusDiv.textContent = 'ERR: NO_LIBRARY_SELECTED';
        return;
    }
    
    const folderPath = currentLibrary.path;
    if (!folderPath) {
        statusDiv.textContent = 'ERR: NO_FOLDER_PATH';
        return;
    }

    if (!isElectron) {
        statusDiv.textContent = 'ERR: ELECTRON_REQUIRED';
        return;
    }

    statusDiv.textContent = 'INIT_DB_LOAD';
    try {
        const libraryId = currentLibrary ? currentLibrary.id : null;
        const dbRes = await window.electronAPI.loadDatabase(libraryId);
        let dbData = {};
        if (dbRes.data) dbData = dbRes.data; 
        if (Array.isArray(dbRes.data)) {
            const map = {};
            dbRes.data.forEach(item => map[item.path] = item);
            dbData = map;
        }

        statusDiv.textContent = 'FILESYSTEM_SCAN';
        setLoading(true);
        
        // Use the recursive setting from the library (default to false if not set)
        const recursive = currentLibrary.recursive || false;
        const data = await window.electronAPI.scanFolder(folderPath, recursive);
        if (data.error) throw new Error(data.error);
        
        images = data.images.map(img => {
            if (dbData[img.path]) {
                return { ...img, ...dbData[img.path], created: img.created || dbData[img.path].created };
            }
            return img;
        });

        const toAnalyze = images.filter(img => !img.features || !img.color);
        
        if (toAnalyze.length > 0) {
            statusDiv.textContent = `ANALYSIS_REQUIRED: ${toAnalyze.length}`;
            await processImagesNative(toAnalyze);
        } else {
            const hasCoords = images.some(img => img.x !== undefined);
            if (!hasCoords && images.length > 0) {
                 train2D();
            } else {
                statusDiv.textContent = `SYSTEM_READY: ${images.length}_IMG`;
                setLoading(false);
                displayImages(images);
            }
        }
    } catch (error) {
        statusDiv.textContent = 'ERR: ' + error.message;
        setLoading(false);
    }
}

async function rescanFolder(skipConfirmation = false) {
    if (!currentLibrary) {
        statusDiv.textContent = 'ERR: NO_LIBRARY_SELECTED';
        return;
    }
    
    const folderPath = currentLibrary.path;
    if (!folderPath) {
        statusDiv.textContent = 'ERR: NO_FOLDER_PATH';
        return;
    }
    
    if (!isElectron) {
        statusDiv.textContent = 'ERR: ELECTRON_REQUIRED';
        return;
    }
    
    // Use custom confirm only if not already confirmed
    if (!skipConfirmation) {
        const confirmed = await customConfirm(
            'FORCE RESCAN',
            'Re-analyze all images with updated categories?\n\nThis will take several minutes for large libraries.'
        );
        
        if (!confirmed) {
            statusDiv.textContent = 'RESCAN_CANCELLED';
            return;
        }
    }

    statusDiv.textContent = 'FILESYSTEM_SCAN';
    setLoading(true);
    
    try {
        const data = await window.electronAPI.scanFolder(folderPath);
        if (data.error) throw new Error(data.error);
        
        // Force re-analysis by clearing cached features and keywords
        images = data.images.map(img => ({
            ...img,
            features: null,
            keywords: null,
            color: null,
            colorVector: null,
            palette: null
        }));
        
        statusDiv.textContent = `FORCING_RESCAN: ${images.length}`;
        await processImagesNative(images);
        
        // Update lastScanned timestamp
        if (currentLibrary) {
            currentLibrary.lastScanned = Date.now();
            const lib = libraries.find(l => l.id === currentLibrary.id);
            if (lib) {
                lib.lastScanned = Date.now();
                await window.electronAPI.saveLibraries(libraries);
                renderLibrariesList();
            }
        }
    } catch (error) {
        statusDiv.textContent = 'ERR: ' + error.message;
        setLoading(false);
    }
}

// Native image processing using Electron IPC
async function processImagesNative(toAnalyzeList) {
    try {
        updateStatus('LOADING_NATIVE_CLIP');
        setLoading(true);

        const startTime = Date.now();
        const total = toAnalyzeList.length;
        
        hardwareAccel = 'NATIVE_ONNX';
        const hwAccelEl = document.getElementById('hw-accel-status');
        if (hwAccelEl) {
            hwAccelEl.textContent = hardwareAccel;
            hwAccelEl.style.color = '#00ff00';
        }
        
        // Listen for model download progress
        if (isElectron) {
            window.electronAPI.onModelDownloadProgress((progress) => {
                const { modelName, percent, loaded, total } = progress;
                const loadedMB = (loaded / 1024 / 1024).toFixed(1);
                const totalMB = (total / 1024 / 1024).toFixed(1);
                updateStatus(`DOWNLOADING_${modelName.toUpperCase().replace(/ /g, '_')}: ${percent}%`, 
                    `Downloading ${modelName}: ${loadedMB}MB / ${totalMB}MB`);
            });
            
            window.electronAPI.onModelDownloadComplete((data) => {
                updateStatus(`${data.modelName.toUpperCase().replace(/ /g, '_')}_DOWNLOADED`, 
                    `${data.modelName} downloaded successfully`);
            });
        }
        
        // Listen for model system info
        if (isElectron) {
            window.electronAPI.onModelSystemInfo((info) => {
                const modelSystemEl = document.getElementById('model-system-status');
                if (modelSystemEl) {
                    modelSystemEl.textContent = `${info.modelSystem} MODEL SYSTEM`;
                    modelSystemEl.style.color = info.hasAestheticModel ? '#00ff00' : '#ffaa00';
                    modelSystemEl.title = info.hasAestheticModel 
                        ? 'SigLIP + DINOv2 + Aesthetic Predictor'
                        : 'SigLIP + DINOv2 (Aesthetic model not available)';
                    modelSystemEl.style.display = 'block'; // Show in loading overlay
                }
            });
        }

        // Initialize stats
        const progressBar = document.getElementById('progress-bar');
        const progressPercentage = document.getElementById('progress-percentage');
        const statProcessed = document.getElementById('stat-processed');
        const statTotal = document.getElementById('stat-total');
        const statSpeed = document.getElementById('stat-speed');
        const statEta = document.getElementById('stat-eta');

        if (statTotal) statTotal.textContent = total;

        // Set up progress listener
        const detectedTagsSet = new Set();
        const detectedTagsArray = [];
        const detectedTagsEl = document.getElementById('detected-tags');
        const maxDisplayTags = 12; // Max tags to show at once
        
        window.electronAPI.onAnalysisProgress((progress) => {
            const { current, total: progressTotal, fileName, keywords } = progress;
            
            // Filename display removed per user request
            
            // Update progress bar
            const percentage = (current / progressTotal) * 100;
            if (progressBar) progressBar.style.width = `${percentage}%`;
            if (progressPercentage) progressPercentage.textContent = `${Math.round(percentage)}%`;
            
            // Update processed count
            if (statProcessed) {
                statProcessed.textContent = current;
                statProcessed.classList.add('pulse');
                setTimeout(() => statProcessed.classList.remove('pulse'), 500);
            }
            
            // Calculate and update speed & ETA
            const currentTime = Date.now();
            const elapsed = (currentTime - startTime) / 1000;
            const speed = current / elapsed;
            const remaining = progressTotal - current;
            const eta = remaining / speed;
            
            if (statSpeed) {
                statSpeed.textContent = `${speed.toFixed(1)}/s`;
            }
            
            if (statEta && eta > 0) {
                if (eta < 60) {
                    statEta.textContent = `${Math.round(eta)}s`;
                } else {
                    const mins = Math.floor(eta / 60);
                    const secs = Math.round(eta % 60);
                    statEta.textContent = `${mins}m ${secs}s`;
                }
            }
            
            // Update detected tags display as vertical ticker with auto-scroll
            if (keywords && detectedTagsEl) {
                keywords.forEach(kw => {
                    const tag = kw.className || kw;
                    if (!detectedTagsSet.has(tag)) {
                        detectedTagsSet.add(tag);
                        detectedTagsArray.push(tag);
                        
                        // Add new tag to ticker
                        const tagEl = document.createElement('span');
                        tagEl.className = 'tag-item';
                        tagEl.textContent = tag;
                        detectedTagsEl.appendChild(tagEl);
                        
                        // Auto-scroll to bottom to show latest tags
                        detectedTagsEl.scrollTop = detectedTagsEl.scrollHeight;
                    }
                });
            }
        });

        updateStatus('ANALYZING_NATIVE');
        
        // Send to native analyzer
        const imagePaths = toAnalyzeList.map(img => img.path);
        // Pass true to reload labels when doing a force rescan (allows labels.js edits to take effect)
        const result = await window.electronAPI.analyzeImages(imagePaths, true);
        
        // Update images with results
        result.results.forEach(analyzed => {
            const img = images.find(i => i.path === analyzed.path);
            if (img && !analyzed.error) {
                img.features = analyzed.features;
                img.keywords = analyzed.keywords;
                img.color = analyzed.color;
                img.colorVector = analyzed.colorVector;
                img.palette = analyzed.palette;
                img.aestheticScore = analyzed.aestheticScore; // Add aesthetic score
            }
        });
        
        // Clean up progress listener
        window.electronAPI.removeAnalysisProgressListener();
        
        // Clear tags display
        if (detectedTagsEl) detectedTagsEl.innerHTML = '';
        
        train2D();
    } catch (error) {
        statusDiv.textContent = 'ERR: ' + error.message;
        setLoading(false);
        console.error('Native analysis error:', error);
    }
}

async function processImagesBrowser(toAnalyzeList) {
    try {
        if (!clipImageModel) {
            statusDiv.textContent = 'BOOTSTRAPPING_CLIP';
            // Wait for transformers to be loaded
            while (!window.transformers) {
                await new Promise(r => setTimeout(r, 100));
            }
            const { pipeline } = window.transformers;
            
            // Try to use WebGPU for hardware acceleration
            let deviceConfig = {};
            try {
                // Check if WebGPU is available
                if (navigator.gpu) {
                    deviceConfig = { device: 'webgpu', dtype: 'fp32' };
                    hardwareAccel = 'WEBGPU';
                    console.log('WebGPU available - enabling GPU acceleration');
                } else {
                    hardwareAccel = 'WASM_MT';
                    console.log('WebGPU not available - using multithreaded WASM');
                }
            } catch (e) {
                hardwareAccel = 'WASM_MT';
                console.log('Falling back to multithreaded WASM');
            }
            
            // Load CLIP models with quantized versions for better performance
            statusDiv.textContent = `LOADING_CLIP [${hardwareAccel}]`;
            try {
                // Try quantized model first (faster, smaller)
                clipImageModel = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32', deviceConfig);
                clipTextModel = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', deviceConfig);
                console.log(`CLIP loaded successfully with ${hardwareAccel}`);
            } catch (e) {
                console.error('Error loading with preferred device:', e);
                // Fallback to default (WASM)
                hardwareAccel = 'WASM';
                clipImageModel = await pipeline('image-feature-extraction', 'Xenova/clip-vit-base-patch32');
                clipTextModel = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32');
            }
            
            // Update hardware acceleration status in UI
            const hwAccelEl = document.getElementById('hw-accel-status');
            if (hwAccelEl) {
                hwAccelEl.textContent = hardwareAccel;
                if (hardwareAccel === 'WEBGPU') {
                    hwAccelEl.style.color = '#00ff00';
                } else if (hardwareAccel === 'WASM_MT') {
                    hwAccelEl.style.color = '#ffaa00';
                } else {
                    hwAccelEl.style.color = '#ff6666';
                }
            }
        }

        let processedCount = 0;
        const total = toAnalyzeList.length;

        const loadImage = (url) => new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = url;
            img.onload = () => resolve(img);
            img.onerror = reject;
        });

        const getDominantColor = (imgEl) => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 1;
            canvas.height = 1;
            ctx.drawImage(imgEl, 0, 0, 1, 1);
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            return [r, g, b];
        };

        // Refined categories for more accurate zero-shot classification
        const candidateLabels = [
            'a photo of a person', 'a photo of people',
            'a photo of a car', 'a photo of a vehicle',
            'a photo of a building', 'a photo of architecture',
            'a photo of an animal', 'a photo of a dog', 'a photo of a cat',
            'a photo of nature', 'a photo of a landscape',
            'a photo of food', 'a photo of a meal',
            'indoor scene', 'outdoor scene',
            'a photo of the sky', 'a photo of water',
            'a photo of a city', 'a photo of a street',
            'a photo of art', 'a photo of a painting'
        ];

        statusDiv.textContent = `ANALYZING_STREAM`;
        setLoading(true);

        // Initialize stats
        const startTime = Date.now();
        let lastUpdateTime = startTime;
        const progressBar = document.getElementById('progress-bar');
        const progressPercentage = document.getElementById('progress-percentage');
        const statProcessed = document.getElementById('stat-processed');
        const statTotal = document.getElementById('stat-total');
        const statSpeed = document.getElementById('stat-speed');
        const statEta = document.getElementById('stat-eta');

        if (statTotal) statTotal.textContent = total;

        for (let i = 0; i < total; i++) {
            const imgData = toAnalyzeList[i];
            try {
                // Update current file display
                if (progressDiv) {
                    progressDiv.textContent = `▸ ${imgData.name}`;
                }
                
                const imgEl = await loadImage(imgData.thumbUrl);
                
                const color = getDominantColor(imgEl);
                imgData.color = color;
                imgData.colorVector = [color[0]/255, color[1]/255, color[2]/255];

                if (!imgData.features) {
                    // Extract CLIP image features - pass URL instead of element
                    const output = await clipImageModel(imgData.thumbUrl, { pooling: 'mean', normalize: true });
                    imgData.features = Array.from(output.data);
                }
                
                if (!imgData.keywords) {
                    // Zero-shot classification with CLIP - pass URL instead of element
                    const classifications = await clipTextModel(imgData.thumbUrl, candidateLabels, { topk: 5 });
                    
                    // Filter by confidence threshold (0.25 = 25%) and clean up labels
                    const minConfidence = 0.25;
                    imgData.keywords = classifications
                        .filter(c => c.score >= minConfidence)
                        .map(c => ({ 
                            className: c.label.replace('a photo of ', '').replace('a photo of a ', '').replace('a photo of an ', '').trim(),
                            probability: c.score 
                        }))
                        .slice(0, 3); // Keep top 3 after filtering
                        
                    // If no tags pass threshold, use the top result anyway
                    if (imgData.keywords.length === 0 && classifications.length > 0) {
                        imgData.keywords = [{
                            className: classifications[0].label.replace('a photo of ', '').replace('a photo of a ', '').replace('a photo of an ', '').trim(),
                            probability: classifications[0].score
                        }];
                    }
                }
                processedCount++;
                
                // Update progress every image
                const progress = (processedCount / total) * 100;
                if (progressBar) progressBar.style.width = `${progress}%`;
                if (progressPercentage) progressPercentage.textContent = `${Math.round(progress)}%`;
                
                // Update processed count with pulse animation
                if (statProcessed) {
                    statProcessed.textContent = processedCount;
                    statProcessed.classList.add('pulse');
                    setTimeout(() => statProcessed.classList.remove('pulse'), 500);
                }
                
                // Calculate and update speed & ETA
                const currentTime = Date.now();
                const elapsed = (currentTime - startTime) / 1000; // seconds
                const speed = processedCount / elapsed;
                const remaining = total - processedCount;
                const eta = remaining / speed;
                
                if (statSpeed) {
                    statSpeed.textContent = `${speed.toFixed(1)}/s`;
                }
                
                if (statEta && eta > 0) {
                    if (eta < 60) {
                        statEta.textContent = `${Math.round(eta)}s`;
                    } else {
                        const mins = Math.floor(eta / 60);
                        const secs = Math.round(eta % 60);
                        statEta.textContent = `${mins}m ${secs}s`;
                    }
                }
                
            } catch (err) {
                console.error('Error:', err);
            }
            if (i % 3 === 0) await new Promise(r => requestAnimationFrame(r));
        }
        train2D(); 
    } catch (error) {
        statusDiv.textContent = 'ERR: ' + error.message;
        setLoading(false);
    }
}

// --- Training Logic ---

async function train2D() {
    const vectors = images.filter(i => i.features).map(i => i.features);
    if (vectors.length === 0) return;

    updateStatus('MAPPING_SEMANTIC_2D');
    setLoading(true);
    
    const gridSize = Math.ceil(Math.sqrt(vectors.length) * 1.5);
    const iterations = Math.max(1000, vectors.length * 2);
    
    // Train using Web Worker (non-blocking)
    const positions = await trainSOMAsync(vectors, gridSize, gridSize, 1, iterations);

    // Apply positions to images
    let posIndex = 0;
    images.forEach((img) => {
        if (img.features) {
            const pos = positions[posIndex++];
            img.x = pos.x;
            img.y = pos.y;
        }
    });
    
    resolveCollisions2D();
    saveData();
    statusDiv.textContent = 'SYSTEM_READY';
    setLoading(false);
    displayImages(images);
    
    // Update library image count
    updateLibraryImageCount();
}

function resolveCollisions2D() {
    const occupied = new Set();
    images.forEach(img => {
        if (img.x === undefined) return;
        let x = Math.round(img.x);
        let y = Math.round(img.y);
        let key = `${x},${y}`;
        if (occupied.has(key)) {
            let found = false, radius = 1;
            while (!found && radius < 50) {
                for (let dx = -radius; dx <= radius && !found; dx++) {
                    for (let dy = -radius; dy <= radius && !found; dy++) {
                        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                        let nx = x + dx, ny = y + dy, nKey = `${nx},${ny}`;
                        if (!occupied.has(nKey)) { img.x = nx; img.y = ny; occupied.add(nKey); found = true; }
                    }
                }
                radius++;
            }
        } else { occupied.add(key); img.x = x; img.y = y; }
    });
}

async function train3D() {
    const vectors = images.filter(i => i.features).map(i => i.features);
    if (vectors.length === 0) return;
    
    updateStatus('MAPPING_SEMANTIC_3D');
    setLoading(true);
    
    const gridSize = Math.ceil(Math.cbrt(vectors.length) * 2);
    const iterations = Math.max(1000, vectors.length * 2);
    
    // Train using Web Worker (non-blocking)
    const positions = await trainSOMAsync(vectors, gridSize, gridSize, gridSize, iterations);
    
    // Apply positions to images
    let posIndex = 0;
    images.forEach((img) => {
        if (img.features) {
            const pos = positions[posIndex++];
            img.x3 = pos.x;
            img.y3 = pos.y;
            img.z3 = pos.z;
        }
    });
    
    resolveCollisions3D();
    saveData();
    statusDiv.textContent = 'SYSTEM_READY';
    setLoading(false);
    displayImages(images);
}

function resolveCollisions3D() {
    const occupied = new Set();
    images.forEach(img => {
        if (img.x3 === undefined) return;
        let x = Math.round(img.x3); let y = Math.round(img.y3); let z = Math.round(img.z3);
        let key = `${x},${y},${z}`;
        if (occupied.has(key)) {
            let found = false, radius = 1;
            while (!found && radius < 20) {
                for (let dx = -radius; dx <= radius && !found; dx++) {
                    for (let dy = -radius; dy <= radius && !found; dy++) {
                        for (let dz = -radius; dz <= radius && !found; dz++) {
                            if (Math.abs(dx) !== radius && Math.abs(dy) !== radius && Math.abs(dz) !== radius) continue;
                            let nx = x + dx, ny = y + dy, nz = z + dz, nKey = `${nx},${ny},${nz}`;
                            if (!occupied.has(nKey)) { img.x3 = nx; img.y3 = ny; img.z3 = nz; occupied.add(nKey); found = true; }
                        }
                    }
                }
                radius++;
            }
        } else { occupied.add(key); img.x3 = x; img.y3 = y; img.z3 = z; }
    });
}

async function trainColor(is3DMode) {
    const valid = images.filter(i => i.colorVector);
    const vectors = valid.map(i => i.colorVector);
    if (vectors.length === 0) return;
    statusDiv.textContent = 'MAPPING_COLOR_SPACE';
    setLoading(true);
    let som;
    if (is3DMode) {
        const gridSize = Math.ceil(Math.cbrt(vectors.length) * 2);
        som = new SimpleSOM(gridSize, gridSize, gridSize, 3, Math.max(1000, vectors.length * 2));
    } else {
        const gridSize = Math.ceil(Math.sqrt(vectors.length) * 1.5);
        som = new SimpleSOM(gridSize, gridSize, 1, 3, Math.max(1000, vectors.length * 2));
    }
    await som.trainAsync(vectors, (c, t) => {
        statusDiv.textContent = `TRAINING: ${Math.round(c/t*100)}%`;
    });
    valid.forEach((img, i) => {
        const pos = som.getBMU(img.colorVector);
        if (is3DMode) { img.xC3 = pos.x; img.yC3 = pos.y; img.zC3 = pos.z; }
        else { img.xC = pos.x; img.yC = pos.y; }
    });
    if (is3DMode) resolveCollisionsColor3D();
    else resolveCollisionsColor2D();
    saveData();
    statusDiv.textContent = 'SYSTEM_READY';
    setLoading(false);
    displayImages(images);
}

function resolveCollisionsColor2D() {
    const occupied = new Set();
    images.forEach(img => {
        if (img.xC === undefined) return;
        let x = Math.round(img.xC); let y = Math.round(img.yC);
        let key = `${x},${y}`;
        if (occupied.has(key)) {
            let found = false, r = 1;
            while (!found && r < 50) {
                for (let dx = -r; dx <= r && !found; dx++) {
                    for (let dy = -r; dy <= r && !found; dy++) {
                        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                        let nx = x + dx, ny = y + dy, nKey = `${nx},${ny}`;
                        if (!occupied.has(nKey)) { img.xC = nx; img.yC = ny; occupied.add(nKey); found = true; }
                    }
                }
                r++;
            }
        } else { occupied.add(key); img.xC = x; img.yC = y; }
    });
}

function resolveCollisionsColor3D() {
    const occupied = new Set();
    images.forEach(img => {
        if (img.xC3 === undefined) return;
        let x = Math.round(img.xC3); let y = Math.round(img.yC3); let z = Math.round(img.zC3);
        let key = `${x},${y},${z}`;
        if (occupied.has(key)) {
            let found = false, r = 1;
            while (!found && r < 20) {
                for (let dx = -r; dx <= r && !found; dx++) {
                    for (let dy = -r; dy <= r && !found; dy++) {
                        for (let dz = -r; dz <= r && !found; dz++) {
                            if (Math.abs(dx) !== r && Math.abs(dy) !== r && Math.abs(dz) !== r) continue;
                            let nx = x + dx, ny = y + dy, nz = z + dz, nKey = `${nx},${ny},${nz}`;
                            if (!occupied.has(nKey)) { img.xC3 = nx; img.yC3 = ny; img.zC3 = nz; occupied.add(nKey); found = true; }
                        }
                    }
                }
                r++;
            }
        } else { occupied.add(key); img.xC3 = x; img.yC3 = y; img.zC3 = z; }
    });
}

function calculateLightness(is3DMode) {
    statusDiv.textContent = 'MAPPING_LIGHTNESS';
    const valid = images.filter(i => i.color);
    
    // Calculate luminance for all images
    valid.forEach(img => {
        const [r, g, b] = img.color;
        const lum = 0.2126*r + 0.7152*g + 0.0722*b;
        img.luminance = lum;
    });
    
    if (is3DMode) {
        // 3D mode: Z-axis represents lightness
        valid.forEach(img => {
            img.zLight = (img.luminance / 255) * 4000;
            if (img.x !== undefined) { img.xLight = img.x; img.yLight = img.y; }
            else { img.xLight = 0; img.yLight = 0; }
        });
    } else {
        // 2D mode: Arrange by lightness in a grid from dark to light
        const sorted = [...valid].sort((a, b) => a.luminance - b.luminance);
        const cols = Math.ceil(Math.sqrt(sorted.length));
        
        sorted.forEach((img, i) => {
            img.xLight = i % cols;
            img.yLight = Math.floor(i / cols);
            img.zLight = 0;
        });
    }
    
    saveData();
    displayImages(images);
}

async function saveData() {
    if (!isElectron) return;
    
    const dataToSave = {};
    images.forEach(img => {
        dataToSave[img.path] = {
            path: img.path, created: img.created,
            features: img.features, color: img.color, colorVector: img.colorVector, keywords: img.keywords,
            palette: img.palette, aestheticScore: img.aestheticScore,
            x: img.x, y: img.y, x3: img.x3, y3: img.y3, z3: img.z3,
            xC: img.xC, yC: img.yC, xC3: img.xC3, yC3: img.yC3, zC3: img.zC3,
            xLight: img.xLight, yLight: img.yLight, zLight: img.zLight
        };
    });
    
    try {
        const libraryId = currentLibrary ? currentLibrary.id : null;
        await window.electronAPI.saveDatabase(dataToSave, libraryId);
    } catch (error) {
        console.error('Error saving database:', error);
    }
}

// --- UI Logic ---

async function setViewMode(to3D) {
    if (is3D === to3D) return;
    is3D = to3D;
    document.getElementById('view-2d').classList.toggle('active', !is3D);
    document.getElementById('view-3d').classList.toggle('active', is3D);
    const sliderCtrl = document.getElementById('z-scale-control');
    const presetCtrl = document.getElementById('view-presets');
    if (sliderCtrl) sliderCtrl.style.display = is3D ? 'block' : 'none';
    if (presetCtrl) presetCtrl.style.display = is3D ? 'block' : 'none';
    // Re-apply current sorting mode (works in both 2D and 3D now)
    await setSorting(currentSort);
    if (is3D) reset3DView();
    else centerMap();
}

async function setSorting(mode) {
    currentSort = mode;
    document.querySelectorAll('[id^="sort-"]').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`sort-${mode}`);
    if (btn) btn.classList.add('active');
    
    // Show/hide similarity info panel
    const similarityInfo = document.getElementById('similarity-info');
    if (similarityInfo) {
        similarityInfo.style.display = (mode === 'similarity') ? 'block' : 'none';
    }
    
    // Update vibe info panel display
    updateVibeAnchorDisplay();
    
    if (images.length === 0) return;
    
    if (mode === 'grid') {
        statusDiv.textContent = "MODE_SEQUENTIAL";
    } else if (mode === 'vibe') {
        statusDiv.textContent = "MODE_VIBE_GRADIENT";
        if (!vibeAnchorStart || !vibeAnchorEnd) {
            statusDiv.textContent = 'SET_VIBE_ANCHORS';
            setLoading(false);
            displayImages(hasActiveFilters() ? currentVisibleImages : images);
            return;
        }
        await sortByVibeGradient();
        return; // sortByVibeGradient handles display
    } else if (mode === 'similarity') {
        // Check if reference image is set before attempting similarity sort
        if (!similarityReferenceImage || !similarityReferenceImage.features) {
            statusDiv.textContent = 'SELECT_REFERENCE_IMAGE';
            setLoading(false);
            // Show current images in semantic mode for now
            displayImages(hasActiveFilters() ? currentVisibleImages : images);
            return;
        }
        await sortBySimilarity();
        return; // sortBySimilarity handles display
    } else if (mode === 'color') {
        statusDiv.textContent = "MODE_CHROMATIC";
        const hasColorData = images.every(img => img.colorVector);
        if (!hasColorData) await ensureColorData();
        const trainedCount = images.filter(img => is3D ? img.xC3 !== undefined : img.xC !== undefined).length;
        if (trainedCount < images.length) await trainColor(is3D);
    } else if (mode === 'lightness') {
        statusDiv.textContent = "MODE_LIGHTNESS";
        const hasLightness = images.every(img => is3D ? img.zLight !== undefined : (img.xLight !== undefined && img.yLight !== undefined));
        if (!hasLightness) calculateLightness(is3D);
    } else {
        statusDiv.textContent = "MODE_SEMANTIC";
        const trainedCount = images.filter(img => is3D ? img.x3 !== undefined : img.x !== undefined).length;
        if (trainedCount < images.length) is3D ? await train3D() : await train2D();
    }
    
    // Check if we have active filters and apply them, otherwise show all images
    if (hasActiveFilters()) {
        await applyFilters();
    } else {
        displayImages(images);
        // Auto-center when switching modes to ensure grid is visible
        if (!is3D) {
            centerMap();
        }
    }
}

async function ensureColorData() {
    setLoading(true);
    const toProcess = images.filter(img => !img.colorVector);
    for (const img of toProcess) {
        try {
            const imgEl = await loadImage(img.thumbUrl);
            const color = getDominantColor(imgEl);
            img.color = color;
            img.colorVector = [color[0]/255, color[1]/255, color[2]/255];
        } catch(e){}
    }
}

const loadImage = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    img.onload = () => resolve(img);
    img.onerror = reject;
});

const getDominantColor = (imgEl) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 1;
    canvas.height = 1;
    ctx.drawImage(imgEl, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b];
};

async function toggleView() {
    await setViewMode(!is3D);
}

let imageNodeElements = [];

function displayImages(imageList) {
    if (!renderer) {
        console.error('Canvas renderer not initialized');
        return;
    }
    
    // Store for lightbox navigation
    currentVisibleImages = imageList;
    
    // Calculate coordinates for each image based on current sort mode
    const itemsWithCoords = imageList.map((img, i) => {
        const item = { ...img };
        
        if (currentSort === 'grid') {
            if (is3D) {
                const side = Math.ceil(Math.cbrt(imageList.length));
                item.x3 = i % side;
                item.y3 = Math.floor(i / side) % side;
                item.z3 = Math.floor(i / (side * side));
            } else {
                const cols = Math.ceil(Math.sqrt(imageList.length));
                item.x = i % cols;
                item.y = Math.floor(i / cols);
            }
        } else if (currentSort === 'color') {
            // Coordinates already set in trainColor
        } else if (currentSort === 'lightness') {
            // Coordinates already set in calculateLightness
        }
        // For semantic/similarity/vibe, coordinates are already in the data
        
        return item;
    });
    
    // Filter out items without coordinates
    const validItems = itemsWithCoords.filter(item => {
        if (is3D) {
            return item.x3 !== undefined && item.y3 !== undefined && item.z3 !== undefined;
        } else {
            return item.x !== undefined && item.y !== undefined;
        }
    });
    
    if (validItems.length === 0) {
        console.warn('No valid items with coordinates to display');
        return;
    }
    
    // Calculate scaling - find max coordinates to scale to 4000x4000 space
    const coords = validItems.map(item => ({
        x: is3D ? (item.x3 || 0) : (item.x || 0),
        y: is3D ? (item.y3 || 0) : (item.y || 0),
        z: is3D ? (item.z3 || 0) : 0
    }));
    
    const maxX = Math.max(...coords.map(c => c.x), 1);
    const maxY = Math.max(...coords.map(c => c.y), 1);
    const maxZ = Math.max(...coords.map(c => c.z), 1);
    
    const scaleX = 4000 / (maxX + 2);
    const scaleY = 4000 / (maxY + 2);
    const scaleZ = 4000 / (maxZ + 2);
    
    // Scale coordinates to fit in 4000x4000 space
    const scaledItems = validItems.map(item => {
        const scaled = { ...item };
        if (is3D) {
            scaled.x3 = (item.x3 || 0) * scaleX;
            scaled. y3 = (item.y3 || 0) * scaleY;
            scaled.z3 = (item.z3 || 0) * scaleZ;
        } else {
            scaled.x = (item.x || 0) * scaleX;
            scaled.y = (item.y || 0) * scaleY;
        }
        return scaled;
    });
    
    // Set 3D mode on renderer
    renderer.set3DMode(is3D);
    
    // Update camera to match current view state
    renderer.setCamera({
        x: is3D ? transX : pointX,
        y: is3D ? transY : pointY,
        z: is3D ? transZ : 0,
        scale: is3D ? 1 : scale,
        rotX: is3D ? rotX : 0,
        rotY: is3D ? rotY : 0
    });
    
    // Pass items to renderer
    console.log('Passing items to renderer:', scaledItems.length, 'items');
    console.log('Sample item:', scaledItems[0]);
    console.log('Renderer is3D:', is3D);
    console.log('Camera state:', renderer.camera);
    
    renderer.setItems(scaledItems);
    
    // Force an immediate render
    renderer.render();
    
    // Update word cloud after displaying images
    updateWordCloud();
    updateColorFilter();
}

let isHighlighting = false;

function highlightNeighbors(targetIndex) {
    // Toggle highlighting - if already highlighting, clear it
    if (isHighlighting) {
        clearHighlight();
        return;
    }
    
    const target = images[targetIndex]; 
    if (!target.features) return;
    
    isHighlighting = true;
    imageNodeElements.forEach(n => { n.style.opacity = '0.1'; });
    const dists = images.map((img, i) => {
        if (!img.features) return { idx: i, d: Infinity };
        let d = 0; for(let k=0; k<img.features.length; k++) d += (img.features[k] - target.features[k])**2;
        return { idx: i, d: d };
    });
    dists.sort((a,b) => a.d - b.d);
    dists.slice(0, 20).forEach(item => {
        const el = imageNodeElements.find(node => node.id === `node-${item.idx}`);
        if (el) { el.style.opacity = '1'; }
    });
}

function clearHighlight() {
    if (!isHighlighting) return;
    isHighlighting = false;
    imageNodeElements.forEach(n => { 
        n.style.opacity = '1'; 
    });
}

function filterByMediaType(type) {
    activeMediaFilter = type;
    
    // Update button states
    document.querySelectorAll('[id^="media-"]').forEach(btn => btn.classList.remove('active'));
    const btn = document.getElementById(`media-${type}`);
    if (btn) btn.classList.add('active');
    
    // Apply all filters together
    applyFilters();
}

function clearAll() {
    document.getElementById('search-input').value = '';
    activeColorFilter = null;
    activeMediaFilter = 'all';
    activeScoreFilter = 0;
    
    // Reset score slider
    const scoreSlider = document.getElementById('score-slider');
    const scoreValue = document.getElementById('score-value');
    if (scoreSlider) scoreSlider.value = 0;
    if (scoreValue) scoreValue.textContent = 'All';
    
    // Reset media type filter buttons
    document.querySelectorAll('[id^="media-"]').forEach(btn => btn.classList.remove('active'));
    const allBtn = document.getElementById('media-all');
    if (allBtn) allBtn.classList.add('active');
    
    // Clear active tag display
    const tagDisplay = document.getElementById('active-tag-display');
    if (tagDisplay) tagDisplay.classList.remove('visible');

    statusDiv.textContent = 'RESTORING_VIEW...';
    
    // Simply redisplay all images with their original layout
    currentVisibleImages = images;
    displayImages(images);
    
    statusDiv.textContent = 'SYSTEM_READY';
}

async function searchImages() {
    const keyword = document.getElementById('search-input').value.toLowerCase().trim();
    
    // Update active tag display
    updateActiveTagDisplay();
    
    // Apply all filters together
    await applyFilters();
}

function updateActiveTagDisplay() {
    const searchInput = document.getElementById('search-input');
    const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const tagDisplay = document.getElementById('active-tag-display');
    
    if (!tagDisplay) return;
    
    // Clear content
    tagDisplay.innerHTML = '';
    
    if (keyword) {
        const span = document.createElement('span');
        span.id = 'active-tag-text';
        
        // Break into two lines if more than one word
        const words = keyword.split(' ');
        if (words.length > 1) {
            span.innerHTML = words[0] + '<br>' + words.slice(1).join(' ');
        } else {
            span.textContent = keyword;
        }
        
        tagDisplay.appendChild(span);
        
        const closeBtn = document.createElement('div');
        closeBtn.id = 'active-tag-close';
        closeBtn.textContent = '✕';
        closeBtn.onclick = clearAll;
        tagDisplay.appendChild(closeBtn);
        
        tagDisplay.classList.add('visible');
    } else if (activeColorFilter) {
        const span = document.createElement('span');
        span.id = 'active-tag-text';
        span.textContent = 'COLOR ';
        
        const colorCircle = document.createElement('span');
        colorCircle.style.cssText = `display: inline-block; width: 1em; height: 1em; background-color: rgb(${activeColorFilter.join(',')}); vertical-align: middle; border: 2px solid #fff; margin-left: 8px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.5);`;
        span.appendChild(colorCircle);
        
        tagDisplay.appendChild(span);
        
        const closeBtn = document.createElement('div');
        closeBtn.id = 'active-tag-close';
        closeBtn.textContent = '✕';
        closeBtn.onclick = clearAll;
        tagDisplay.appendChild(closeBtn);
        
        tagDisplay.classList.add('visible');
    } else {
        tagDisplay.classList.remove('visible');
    }
}

function hasActiveFilters() {
    const searchInput = document.getElementById('search-input');
    const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    return keyword.length > 0 || 
           activeColorFilter !== null || 
           activeMediaFilter !== 'all' || 
           activeScoreFilter > 0;
}

async function searchImagesOld() {
    const keyword = document.getElementById('search-input').value.toLowerCase().trim();
    activeColorFilter = null; // Clear color filter when searching text
    
    if (!keyword) { clearAll(); return; }
    
    statusDiv.textContent = 'FILTERING...';
    setLoading(true);
    
    // Filter matching images using whole-word matching
    const matchedImages = [];
    // Create regex for whole word matching (with word boundaries)
    const searchRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    
    images.forEach((img, i) => {
        const match = img.keywords && img.keywords.some(p => searchRegex.test(p.className));
        if (match) {
            matchedImages.push({ ...img, originalIndex: i });
        }
    });
    
    if (matchedImages.length === 0) {
        statusDiv.textContent = 'NO_MATCHES';
        setLoading(false);
        // Still show all images but dimmed
        imageNodeElements.forEach(el => el.style.opacity = '0.2');
        return;
    }
    
    statusDiv.textContent = `CLUSTERING: ${matchedImages.length} MATCHES`;
    
    // Re-cluster the matched images
    const matchedVectors = matchedImages.filter(img => img.features).map(img => img.features);
    
    if (matchedVectors.length > 0 && matchedVectors.length > 1) {
        const gridSize = Math.ceil(Math.sqrt(matchedVectors.length) * 1.5);
        const tempSom = new SimpleSOM(gridSize, gridSize, 1, matchedVectors[0].length, Math.min(500, matchedVectors.length * 10));
        
        await tempSom.trainAsync(matchedVectors, (c, t) => {
            statusDiv.textContent = `CLUSTERING: ${Math.round(c/t*100)}%`;
        });
        
        matchedImages.forEach((img) => {
            if (img.features) {
                const pos = tempSom.getBMU(img.features);
                img.xSearch = pos.x;
                img.ySearch = pos.y;
            }
        });
    } else {
        // Single image or no features - just center it
        matchedImages.forEach((img) => {
            img.xSearch = 0;
            img.ySearch = 0;
        });
    }
    
    // Clear and rebuild with only matched images
    mapContainer.innerHTML = '';
    imageNodeElements = [];
    currentVisibleImages = matchedImages;
    
    const gridSize = Math.ceil(Math.sqrt(matchedImages.length) * 1.5);
    const cellW = 4000 / (gridSize + 2);
    const cellH = 4000 / (gridSize + 2);
    
    const fragment = document.createDocumentFragment();
    
    matchedImages.forEach((img, index) => {
        const el = document.createElement('div');
        el.className = 'image-node';
        el.id = `node-${img.originalIndex}`;
        el.style.width = `${cellW}px`;
        el.style.height = `${cellH}px`;
        
        const x = (img.xSearch || 0) * cellW;
        const y = (img.ySearch || 0) * cellH;
        
        el.style.setProperty('--tx', `${x}px`);
        el.style.setProperty('--ty', `${y}px`);
        el.style.setProperty('--tz', '0px');
        el._tz_val = 0;
        el._visible = true;
        
        el.onmouseenter = () => {
            hoveredIndex = index;
            let content = `ID: ${img.name.toUpperCase()}<br>`;
            if (img.keywords && img.keywords.length > 0) {
                const tags = img.keywords.map(k => k.className.toUpperCase()).join(', ');
                content += `TAGS: ${tags}<br>`;
            }
            if (img.palette && img.palette.length > 0) {
                content += `PALETTE:<br>`;
                content += `<div class="palette-container">`;
                img.palette.forEach(c => {
                    content += `<div class="palette-swatch" style="background: rgb(${c[0]},${c[1]},${c[2]})" title="RGB: ${c.join(',')}"></div>`;
                });
                content += `</div>`;
            } else {
                content += `PALETTE: Scanning...<br>`;
            }
            content += `POS: [${Math.round(x)},${Math.round(y)},0]`;
            semanticInfoDiv.innerHTML = content;
            el.classList.add('is-hovered');
            
            // Update preview image - only show after loaded
            const previewImg = document.getElementById('preview-img');
            const previewPlaceholder = document.getElementById('preview-placeholder');
            if (previewImg && previewPlaceholder) {
                const imageUrl = isElectron ? `file:///${img.path.replace(/\\/g, '/')}` : (img.url || img.thumbUrl);
                
                // Preload image before showing
                const tempImg = new Image();
                tempImg.onload = () => {
                    previewImg.src = imageUrl;
                    previewImg.style.display = 'block';
                    previewPlaceholder.style.display = 'none';
                };
                tempImg.onerror = () => {
                    // On error, just keep placeholder visible
                };
                tempImg.src = imageUrl;
            }
        };
        
        el.onmouseleave = () => {
            hoveredIndex = -1;
            el.classList.remove('is-hovered');
            
            // Clear info text
            if (semanticInfoDiv) {
                semanticInfoDiv.textContent = 'Hover over an image to see details...';
            }
            
            // Clear preview image
            const previewImg = document.getElementById('preview-img');
            const previewPlaceholder = document.getElementById('preview-placeholder');
            if (previewImg && previewPlaceholder) {
                previewImg.style.display = 'none';
                previewPlaceholder.style.display = 'block';
                previewImg.src = '';
            }
        };
        
        // Track mouse movement for click vs drag detection
        let searchImageMouseDown = false;
        let searchImageStartX = 0;
        let searchImageStartY = 0;
        let searchImageMouseButton = 0;
        
        el.onmousedown = (e) => {
            searchImageMouseDown = true;
            searchImageStartX = e.clientX;
            searchImageStartY = e.clientY;
            searchImageMouseButton = e.button;
        };
        
        el.onmouseup = (e) => {
            if (!searchImageMouseDown) return;
            
            // Calculate distance moved
            const distMoved = Math.sqrt(
                Math.pow(e.clientX - searchImageStartX, 2) + 
                Math.pow(e.clientY - searchImageStartY, 2)
            );
            
            // Only treat as click if moved less than 5 pixels AND it's left-click (button 0)
            if (distMoved < 5 && searchImageMouseButton === 0) {
                e.stopPropagation();
                // Zoom into the grid, focusing on this image
                // Pass image size to center properly
                zoomToImage(x, y, 0, cellW, cellH);
                // Reset global dragging state
                isDragging = false;
            }
            
            searchImageMouseDown = false;
        };
        
        // Double-click for lightbox
        el.ondblclick = (e) => {
            e.stopPropagation();
            showLightbox(index);
        };
        
        const imageElement = document.createElement('img');
        // In Electron mode, load thumbnail async (same as displayImages)
        if (isElectron && !img.thumbnailData) {
            // Show placeholder while loading
            imageElement.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="150" height="150"%3E%3Crect fill="%23222" width="150" height="150"/%3E%3C/svg%3E';
            // Load thumbnail data asynchronously
            window.electronAPI.getImageData(img.path).then(result => {
                img.thumbnailData = result.dataUrl;
                imageElement.src = result.dataUrl;
            }).catch(err => {
                console.error('Error loading thumbnail:', err);
            });
        } else if (isElectron && img.thumbnailData) {
            imageElement.src = img.thumbnailData;
        } else {
            imageElement.src = img.thumbUrl;
        }
        imageElement.loading = 'lazy';
        el.appendChild(imageElement);
        fragment.appendChild(el);
        imageNodeElements.push(el);
    });
    
    mapContainer.appendChild(fragment);
    mapContainer.className = '';
    
    statusDiv.textContent = `FILTERED: ${matchedImages.length}`;
    setLoading(false);
    centerMap();
}

// --- Navigation & Transforms ---
const main = document.getElementById('main');
let scale = 1, pointX = 0, pointY = 0;
let rotX = 0, rotY = 0, transX = 0, transY = 0, transZ = -2000;
let isDragging = false, dragButton = 0, startX = 0, startY = 0;
let isSpacePressed = false;
let isShiftPressed = false;
let isAutoMoveEnabled = true;
let driftSpeed = 0.5;
let driftInterval = 20;

function toggleAutoMove() {
    isAutoMoveEnabled = !isAutoMoveEnabled;
    const btn = document.getElementById('auto-move-toggle');
    if (btn) btn.textContent = `AUTODRIFT: ${isAutoMoveEnabled ? 'ON' : 'OFF'}`;
    localStorage.setItem('autoMove', isAutoMoveEnabled);
    if (isAutoMoveEnabled) randomizeTargetVelocity();
}

function updateDriftSpeed(val) { driftSpeed = parseFloat(val); }
function updateDriftInterval(val) { driftInterval = parseInt(val); }

let autoMoveTime = 0;
let driftVelX = 0, driftVelY = 0, driftVelZ = 0;
let targetVelX = 0, targetVelY = 0, targetVelZ = 0;
let lastFrameTime = performance.now();
let frameCount = 0;
let fpsUpdateTime = 0;

function randomizeTargetVelocity() {
    const axis = Math.floor(Math.random() * 3); 
    const dir = Math.random() > 0.5 ? 1 : -1;
    const mag = 1.0 + Math.random(); 
    targetVelX = (axis === 0) ? dir * mag : 0;
    targetVelY = (axis === 1) ? dir * mag : 0;
    targetVelZ = (axis === 2) ? dir * mag : 0;
}

function animate(now) {
    frameCount++;
    if (now - fpsUpdateTime > 500) {
        const fps = Math.round((frameCount * 1000) / (now - fpsUpdateTime));
        if (fpsCounterEl) fpsCounterEl.textContent = `FPS: ${fps}`;
        frameCount = 0; fpsUpdateTime = now;
    }
    lastFrameTime = now;
    if (is3D && !isDragging) {
        if (isAutoMoveEnabled) {
            autoMoveTime += 0.01;
            rotX += (0 - rotX) * 0.02; rotY += (0 - rotY) * 0.02;
            if (Math.floor(autoMoveTime / driftInterval) !== Math.floor((autoMoveTime - 0.01) / driftInterval)) {
                randomizeTargetVelocity();
            }
            driftVelX += (targetVelX - driftVelX) * 0.01;
            driftVelY += (targetVelY - driftVelY) * 0.01;
            driftVelZ += (targetVelZ - driftVelZ) * 0.01;
            transX += driftVelX * driftSpeed; transY += driftVelY * driftSpeed;
            transZ += driftVelZ * driftSpeed * 2; transZ = Math.min(0, Math.max(-8000, transZ));
        }
        updateTransform(); updateProximityFading();
    }
    requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

let staggeredIndex = 0;
const BATCH_SIZE = 200;

function updateProximityFading() {
    if (!is3D || imageNodeElements.length === 0) return;
    const start = staggeredIndex; const end = Math.min(start + BATCH_SIZE, imageNodeElements.length);
    for (let i = start; i < end; i++) {
        const node = imageNodeElements[i];
        const worldZ = node._tz_val + transZ;
        
        // Extended view distance
        if (worldZ > 300 || worldZ < -15000) {
            if (node._visible) { node.style.display = 'none'; node._visible = false; }
            continue;
        } else {
            if (!node._visible) { node.style.display = 'block'; node._visible = true; }
        }
        
        let opacity = 1; let brightness = 1;
        
        // Fade out only when very close to camera (near clip)
        if (worldZ > 100) opacity = Math.max(0, 1 - (worldZ - 100) / 200);
        
        // Distance fog/darkness
        if (worldZ < -3000) brightness = Math.max(0.1, 1 - (Math.abs(worldZ + 3000) / 8000));
        
        node.style.opacity = opacity; 
        node.style.filter = `brightness(${brightness})`;
    }
    staggeredIndex = (staggeredIndex + BATCH_SIZE) % imageNodeElements.length;
}

window.addEventListener('keydown', (e) => { 
    // Ignore key events if typing in input
    if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA') return;

    if (e.code === 'Space') {
        isSpacePressed = true;
        // Lightbox toggle
        if (lightbox.style.display !== 'none') {
            lightbox.style.display = 'none';
            lightboxImg.src = '';
        } else if (hoveredIndex !== -1) {
            e.preventDefault(); // Prevent scroll
            showLightbox(hoveredIndex);
        }
    }
    
    if (e.code === 'ArrowLeft') {
        if (lightbox.style.display !== 'none') {
            e.preventDefault();
            navigateLightbox(-1);
        }
    }
    if (e.code === 'ArrowRight') {
        if (lightbox.style.display !== 'none') {
            e.preventDefault();
            navigateLightbox(1);
        }
    }
    
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') isShiftPressed = true;
    if (e.code === 'Escape') {
        clearHighlight();
        if (lightbox.style.display !== 'none') {
            lightbox.style.display = 'none';
            lightboxImg.src = '';
        }
    }
});
window.addEventListener('keyup', (e) => { 
    if (e.code === 'Space') isSpacePressed = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        isShiftPressed = false;
        // Clear highlighting when Shift is released
        clearHighlight();
    }
});
function updateTransform() {
    if (is3D) {
        mapContainer.style.transformOrigin = 'center center';
        mapContainer.style.transform = `translateX(${transX}px) translateY(${transY}px) translateZ(${transZ}px) rotateX(${rotX}deg) rotateY(${rotY}deg)`;
    } else {
        mapContainer.style.transformOrigin = '0 0';
        mapContainer.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
    }
    
    // Sync camera with renderer
    if (renderer) {
        renderer.setCamera({
            x: is3D ? transX : pointX,
            y: is3D ? transY : pointY,
            z: is3D ? transZ : 0,
            scale: is3D ? 1 : scale,
            rotX: is3D ? rotX : 0,
            rotY: is3D ? rotY : 0
        });
    }
}
function reset3DView() { rotX = 0; rotY = 0; transX = 0; transY = 0; transZ = -2000; updateTransform(); }
function centerMap() {
    if (is3D) reset3DView();
    else {
        const rect = main.getBoundingClientRect();
        scale = 0.2;
        pointX = (rect.width - 4000 * scale) / 2;
        pointY = (rect.height - 4000 * scale) / 2;
        updateTransform();
    }
}
function zoomToImage(imgX, imgY, imgZ, imgWidth, imgHeight) {
    // Zoom into the grid, centering on the clicked image
    if (is3D) {
        // For 3D, move to center the image and zoom in closer
        const rect = main.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        // Calculate the center of the image (not top-left corner)
        const imageCenterX = imgX + (imgWidth || 0) / 2;
        const imageCenterY = imgY + (imgHeight || 0) / 2;
        
        // Move the camera so the image CENTER appears at viewport center
        transX = -imageCenterX + centerX;
        transY = -imageCenterY + centerY;
        transZ = -500;  // Zoom in closer
        
        updateTransform();
        updateZoomSlider();
    } else {
        // For 2D, pan and zoom to the clicked image
        const rect = main.getBoundingClientRect();
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        
        // Adaptive zoom level based on image size
        // Smaller cells (normal view) get more zoom, larger cells (filtered view) get less zoom
        const avgCellSize = ((imgWidth || 100) + (imgHeight || 100)) / 2;
        let targetScale;
        if (avgCellSize > 200) {
            // Very large cells (few filtered results) - barely zoom, just center
            targetScale = 0.4;
        } else if (avgCellSize > 120) {
            // Large cells (filtered view) - zoom very little
            targetScale = 0.7;
        } else if (avgCellSize > 70) {
            // Medium cells - moderate zoom
            targetScale = 1.2;
        } else {
            // Small cells (normal dense view) - zoom more
            targetScale = 1.8;
        }
        
        // Calculate the center of the image (not top-left corner)
        const imageCenterX = imgX + (imgWidth || 0) / 2;
        const imageCenterY = imgY + (imgHeight || 0) / 2;
        
        // Position so the image CENTER is at viewport center
        pointX = centerX - (imageCenterX * targetScale);
        pointY = centerY - (imageCenterY * targetScale);
        scale = targetScale;
        
        updateTransform();
        updateZoomSlider();
    }
}

function updateZScale(val) { mapContainer.style.setProperty('--z-scale', val); }
function nav(direction) {
    const step = 200; 
    if (is3D) {
        switch(direction) {
            case 'up': transY += step; break; case 'down': transY -= step; break;
            case 'left': transX += step; break; case 'right': transX -= step; break;
        }
    } else {
        switch(direction) {
            case 'up': pointY += step; break; case 'down': pointY -= step; break;
            case 'left': pointX += step; break; case 'right': pointX -= step; break;
        }
    }
    updateTransform();
}
function setZoom(value) {
    if (is3D) {
        // Map slider value (0.05-5) to transZ (-10000 to 0)
        transZ = -2000 * (6 - value);
        transZ = Math.min(0, Math.max(-10000, transZ));
    } else {
        scale = value;
    }
    updateTransform();
    updateZoomInfo();
}

function zoomIn() { 
    if (is3D) { 
        transZ += 500; 
        transZ = Math.min(0, transZ);
        updateTransform(); 
        updateZoomSlider();
    } else { 
        scale = Math.min(scale * 1.2, 5); 
        updateTransform(); 
        updateZoomSlider();
    } 
}

function zoomOut() { 
    if (is3D) { 
        transZ -= 500; 
        transZ = Math.max(-10000, transZ);
        updateTransform(); 
        updateZoomSlider();
    } else { 
        scale = Math.max(scale / 1.2, 0.05); 
        updateTransform(); 
        updateZoomSlider();
    } 
}

function updateZoomInfo() {
    const zoomInfo = document.getElementById('zoom-info');
    if (!zoomInfo) return;
    
    if (is3D) {
        // For 3D, show depth/distance
        const depth = Math.abs(transZ);
        zoomInfo.textContent = `Depth: ${depth}`;
    } else {
        // For 2D, show zoom percentage
        const percentage = Math.round(scale * 100);
        zoomInfo.textContent = `${percentage}%`;
    }
}

function updateZoomSlider() {
    updateZoomInfo();
    const slider = document.getElementById('zoom-slider');
    if (!slider) return;
    if (is3D) {
        // Map transZ (-10000 to 0) to slider value (0.05-5)
        const value = 6 - (transZ / -2000);
        slider.value = Math.max(0.05, Math.min(5, value));
    } else {
        slider.value = scale;
    }
}

const mapControls = document.getElementById('map-controls');
if (mapControls) mapControls.addEventListener('mousedown', (e) => e.stopPropagation());
main.addEventListener('contextmenu', (e) => e.preventDefault());
main.addEventListener('mousedown', (e) => {
    if (e.target === main || e.target === mapContainer) {
        clearHighlight();
    }
    if (isSpacePressed || e.button === 2) dragButton = 2; 
    else if (e.button === 0) dragButton = 0; else return;
    e.preventDefault(); startX = e.clientX; startY = e.clientY; isDragging = true;
});
window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    e.preventDefault(); const dx = e.clientX - startX; const dy = e.clientY - startY;
    if (is3D) { transX += dx; transY += dy; } else { pointX += dx; pointY += dy; }
    startX = e.clientX; startY = e.clientY; updateTransform();
});
window.addEventListener('mouseup', () => isDragging = false);
main.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (is3D) { 
        transZ -= e.deltaY * 2; 
        transZ = Math.min(0, Math.max(-10000, transZ)); 
        updateTransform();
        updateZoomSlider();
    }
    else {
        const rect = main.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const targetX = (mouseX - pointX) / scale;
        const targetY = (mouseY - pointY) / scale;
        const factor = -e.deltaY > 0 ? 1.1 : 0.9;
        let newScale = Math.min(Math.max(0.05, scale * factor), 5);
        pointX = mouseX - targetX * newScale;
        pointY = mouseY - targetY * newScale;
        scale = newScale;
        updateTransform();
        updateZoomSlider();
    }
});

const savedTheme = localStorage.getItem('theme');
const savedAutoMove = localStorage.getItem('autoMove');
if (savedAutoMove !== null) {
    isAutoMoveEnabled = savedAutoMove === 'true';
    const btn = document.getElementById('auto-move-toggle');
    if (btn) btn.textContent = `AUTODRIFT: ${isAutoMoveEnabled ? 'ON' : 'OFF'}`;
}
if (savedTheme === 'dark') document.body.classList.add('dark-mode');

// Add Enter key support for search input
const searchInput = document.getElementById('search-input');
if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            searchImages();
        }
    });
}

randomizeTargetVelocity(); centerMap();

// --- Library Management ---

async function loadLibraries() {
    if (!isElectron) return;
    try {
        const result = await window.electronAPI.getLibraries();
        libraries = result.libraries || [];
        renderLibrariesList();
    } catch (error) {
        console.error('Error loading libraries:', error);
    }
}

async function loadSelectedLibrary() {
    if (!selectedLibraryId) return;
    
    // Find the library
    const lib = libraries.find(l => l.id === selectedLibraryId);
    if (!lib) return;
    
    // Hide modal first to feel responsive
    document.getElementById('library-selection-modal').style.display = 'none';
    
    // Switch to it
    await switchLibrary(selectedLibraryId);
}

// Helper function to load library from modal button
async function loadLibraryFromModal(libraryId) {
    selectedLibraryId = libraryId;
    await loadSelectedLibrary();
}

function renderLibrariesList() {
    const currentLibDisplay = document.getElementById('current-library-display');
    const selectionListEl = document.getElementById('selection-libraries-list');
    
    // Render sidebar current library display
    if (currentLibDisplay) {
        if (!currentLibrary) {
            currentLibDisplay.innerHTML = `
                <div class="library-info" style="padding:12px; opacity:0.6;">
                    <div class="library-name">No Library Selected</div>
                    <div class="library-path" style="font-size:0.65rem;">Click "Open Library" to load</div>
                </div>
            `;
            currentLibDisplay.className = 'library-item';
        } else {
            // Calculate time ago
            let lastUpdatedText = 'Never';
            if (currentLibrary.lastUpdated) {
                const date = new Date(currentLibrary.lastUpdated);
                const now = new Date();
                const diffMs = now - date;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMs / 3600000);
                const diffDays = Math.floor(diffMs / 86400000);
                
                if (diffMins < 1) lastUpdatedText = 'Just now';
                else if (diffMins < 60) lastUpdatedText = `${diffMins}m ago`;
                else if (diffHours < 24) lastUpdatedText = `${diffHours}h ago`;
                else if (diffDays < 7) lastUpdatedText = `${diffDays}d ago`;
                else lastUpdatedText = date.toLocaleDateString();
            }
            
            const imageCount = currentLibrary.imageCount || 0;
            const imageCountText = imageCount === 1 ? '1 image' : `${imageCount} images`;
            
            // Calculate last scanned time
            let lastScannedText = 'Never';
            if (currentLibrary.lastScanned) {
                const date = new Date(currentLibrary.lastScanned);
                const now = new Date();
                const diffMs = now - date;
                const diffMins = Math.floor(diffMs / 60000);
                const diffHours = Math.floor(diffMs / 3600000);
                const diffDays = Math.floor(diffMs / 86400000);
                
                if (diffMins < 1) lastScannedText = 'Just now';
                else if (diffMins < 60) lastScannedText = `${diffMins}m ago`;
                else if (diffHours < 24) lastScannedText = `${diffHours}h ago`;
                else if (diffDays < 7) lastScannedText = `${diffDays}d ago`;
                else lastScannedText = date.toLocaleDateString();
            }

            currentLibDisplay.innerHTML = `
                <div class="library-info" style="padding:12px;">
                    <div class="library-name" style="font-weight:700;">${currentLibrary.name}</div>
                    <div class="library-path" style="font-size:0.65rem; opacity:0.6; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${currentLibrary.path}</div>
                    <div class="library-updated" style="font-size:0.6rem; opacity:0.4; margin-top:4px;">${imageCountText} • Updated: ${lastUpdatedText}</div>
                    <div class="library-updated" style="font-size:0.6rem; opacity:0.4; margin-top:2px;">Last scanned: ${lastScannedText}</div>
                </div>
                <div class="library-actions">
                    <button class="library-btn" onclick="rescanCurrentLibrary()">Rescan</button>
                </div>
            `;
            currentLibDisplay.className = 'library-item active';
        }
        currentLibDisplay.style.marginBottom = '8px';
        currentLibDisplay.style.cursor = 'default';
        currentLibDisplay.style.border = '1px solid var(--border)';
        currentLibDisplay.style.background = 'rgba(255, 255, 255, 0.02)';
    }

    // Render selection modal list
    if (selectionListEl) {
        if (libraries.length === 0) {
            selectionListEl.innerHTML = '<div style="padding: 30px; text-align: center; opacity: 0.5; font-size: 0.8rem;">No saved libraries found.<br>Create one to get started.</div>';
            const loadBtn = document.getElementById('load-library-btn');
            if (loadBtn) loadBtn.disabled = true;
        } else {
            selectionListEl.innerHTML = '';
            
            // Check if selectedLibraryId is valid
            if (selectedLibraryId && !libraries.find(l => l.id === selectedLibraryId)) {
                selectedLibraryId = null;
            }
            
            // Update load button state
            const loadBtn = document.getElementById('load-library-btn');
            if (loadBtn) loadBtn.disabled = !selectedLibraryId;

            libraries.forEach(lib => {
                const item = document.createElement('div');
                item.className = 'library-item'; // Changed to match sidebar style
                if (lib.id === selectedLibraryId) {
                    item.classList.add('active');
                }
                
                const imageCount = lib.imageCount || 0;
                let lastUpdatedText = 'Never';
                if (lib.lastUpdated) {
                    const date = new Date(lib.lastUpdated);
                    lastUpdatedText = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
                }
                
                item.innerHTML = `
                    <div class="library-info">
                        <div class="library-name">${lib.name}</div>
                        <div class="library-path">${lib.path}</div>
                        <div class="library-updated">${imageCount} images • Last opened: ${lastUpdatedText}</div>
                    </div>
                    <div class="library-actions">
                        <button class="library-btn" onclick="event.stopPropagation(); loadLibraryFromModal('${lib.id}')">Load</button>
                        <button class="library-btn" onclick="event.stopPropagation(); renameLibrary('${lib.id}')">Rename</button>
                        <button class="library-btn delete-btn" onclick="event.stopPropagation(); deleteLibrary('${lib.id}')">Delete</button>
                    </div>
                `;
                
                const infoDiv = item.querySelector('.library-info');
                infoDiv.onclick = () => {
                    selectedLibraryId = lib.id;
                    renderLibrariesList(); // Re-render to update selection UI
                };
                
                infoDiv.ondblclick = () => {
                    selectedLibraryId = lib.id;
                    loadSelectedLibrary();
                };
                
                selectionListEl.appendChild(item);
            });
        }
    }
}

async function createNewLibrary(isFromSelectionModal = false) {
    if (!isElectron) return;
    
    try {
        const result = await window.electronAPI.selectFolder();
        if (!result.path) {
            return;
        }
        
        pendingLibraryAction = { type: 'add', folderPath: result.path, fromSelection: isFromSelectionModal };
        const modal = document.getElementById('library-modal');
        const input = document.getElementById('library-name-input');
        const recursiveCheckbox = document.getElementById('library-recursive-checkbox');
        
        input.value = '';
        
        // Reset checkbox to unchecked for new libraries
        if (recursiveCheckbox) {
            recursiveCheckbox.checked = false;
        }
        
        modal.style.display = 'flex';
        input.focus();
    } catch (error) {
        console.error('Error creating library:', error);
        statusDiv.textContent = 'ERR: FOLDER_SELECT_FAILED';
    }
}

async function confirmLibraryName() {
    const input = document.getElementById('library-name-input');
    const name = input.value.trim();
    
    if (!name) return;
    
    const modal = document.getElementById('library-modal');
    modal.style.display = 'none';
    
    if (pendingLibraryAction.type === 'add') {
        // Capture the recursive checkbox state
        const recursiveCheckbox = document.getElementById('library-recursive-checkbox');
        const recursive = recursiveCheckbox ? recursiveCheckbox.checked : false;
        
        const id = 'lib_' + Date.now();
        const newLibrary = {
            id,
            name,
            path: pendingLibraryAction.folderPath,
            created: Date.now(),
            recursive: recursive
        };
        
        libraries.push(newLibrary);
        await window.electronAPI.saveLibraries(libraries);
        currentLibrary = newLibrary;
        renderLibrariesList();
        
        if (pendingLibraryAction.fromSelection) {
            document.getElementById('library-selection-modal').style.display = 'none';
        }
        
        // Auto-scan the new library
        statusDiv.textContent = 'SCANNING_NEW_LIBRARY';
        await scanFolder();
    } else if (pendingLibraryAction.type === 'rename') {
        const lib = libraries.find(l => l.id === pendingLibraryAction.libraryId);
        if (lib) {
            lib.name = name;
            await window.electronAPI.saveLibraries(libraries);
            renderLibrariesList();
        }
    }
    
    pendingLibraryAction = null;
}

function cancelLibraryName() {
    const modal = document.getElementById('library-modal');
    modal.style.display = 'none';
    pendingLibraryAction = null;
}

// Custom confirm dialog
function customConfirm(title, message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-title');
        const messageEl = document.getElementById('confirm-message');
        const okBtn = document.getElementById('confirm-ok-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.style.display = 'flex';
        
        const handleOk = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(true);
        };
        
        const handleCancel = () => {
            modal.style.display = 'none';
            cleanup();
            resolve(false);
        };
        
        const cleanup = () => {
            okBtn.removeEventListener('click', handleOk);
            cancelBtn.removeEventListener('click', handleCancel);
        };
        
        okBtn.addEventListener('click', handleOk);
        cancelBtn.addEventListener('click', handleCancel);
    });
}

function updateCurrentLibraryInfo() {
    const infoEl = document.getElementById('current-library-info');
    const scanBtn = document.getElementById('scan-btn');
    
    if (currentLibrary) {
        infoEl.textContent = `${currentLibrary.name}\n${currentLibrary.path}`;
        infoEl.style.opacity = '1';
        if (scanBtn) scanBtn.disabled = false;
    } else {
        infoEl.textContent = 'No library selected';
        infoEl.style.opacity = '0.6';
        if (scanBtn) scanBtn.disabled = true;
    }
}

async function rescanCurrentLibrary() {
    if (!currentLibrary) {
        statusDiv.textContent = 'ERR: NO_LIBRARY_SELECTED';
        return;
    }
    await rescanFolder();
}

async function scanCurrentLibrary() {
    if (!currentLibrary) {
        statusDiv.textContent = 'ERR: NO_LIBRARY_SELECTED';
        return;
    }
    await scanFolder();
}

async function switchLibrary(libraryId) {
    const lib = libraries.find(l => l.id === libraryId);
    if (!lib) return;
    
    currentLibrary = lib;
    renderLibrariesList();
    
    // Clear current view
    mapContainer.innerHTML = '';
    images = [];
    imageNodeElements = [];
    
    // Auto-scan the library
    statusDiv.textContent = 'LOADING_LIBRARY';
    await scanFolder();
}

// Generate word cloud from current library's tags
function updateColorFilter() {
    const colorSection = document.getElementById('color-filter-section');
    const colorPalette = document.getElementById('color-palette');
    
    if (!currentLibrary || images.length === 0) {
        if (colorSection) colorSection.style.display = 'none';
        return;
    }
    
    // Quantize and count colors
    const colorCounts = {};
    const colorValues = {}; // Store representative [r,g,b]
    
    images.forEach(img => {
        if (img.color) {
            // Quantize to 40-step buckets
            const step = 40; 
            const r = Math.floor(img.color[0] / step) * step + step/2;
            const g = Math.floor(img.color[1] / step) * step + step/2;
            const b = Math.floor(img.color[2] / step) * step + step/2;
            const key = `${r},${g},${b}`;
            
            colorCounts[key] = (colorCounts[key] || 0) + 1;
            colorValues[key] = [r, g, b];
        }
    });
    
    // Sort by frequency
    const sortedColors = Object.entries(colorCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15); // Top 15
        
    if (sortedColors.length === 0) {
        if (colorSection) colorSection.style.display = 'none';
        return;
    }
    
    if (colorSection) colorSection.style.display = 'block';
    
    if (colorPalette) {
        colorPalette.innerHTML = '';
        sortedColors.forEach(([key, count]) => {
            const rgb = colorValues[key];
            const swatch = document.createElement('div');
            swatch.className = 'palette-swatch';
            swatch.style.background = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
            swatch.style.width = '24px';
            swatch.style.height = '24px';
            swatch.style.margin = '2px';
            swatch.style.cursor = 'pointer';
            swatch.style.border = '1px solid rgba(255,255,255,0.2)';
            swatch.title = `${count} images`;
            
            if (activeColorFilter && 
                Math.abs(activeColorFilter[0] - rgb[0]) < 1 &&
                Math.abs(activeColorFilter[1] - rgb[1]) < 1 &&
                Math.abs(activeColorFilter[2] - rgb[2]) < 1) {
                swatch.style.border = '2px solid #fff';
                swatch.style.transform = 'scale(1.2)';
            }
            
            swatch.onclick = () => filterByColor(rgb);
            
            colorPalette.appendChild(swatch);
        });
    }
}

async function filterByColor(targetColor) {
    // Clear text search
    document.getElementById('search-input').value = '';
    
    // Toggle off
    if (activeColorFilter && 
        targetColor[0] === activeColorFilter[0] && 
        targetColor[1] === activeColorFilter[1] && 
        targetColor[2] === activeColorFilter[2]) {
        activeColorFilter = null;
        clearAll();
        return;
    }
    
    activeColorFilter = targetColor;
    updateColorFilter(); // Update selection UI
    
    // Update active tag display
    const tagDisplay = document.getElementById('active-tag-display');
    if (tagDisplay) {
        tagDisplay.innerHTML = '';
        const span = document.createElement('span');
        span.id = 'active-tag-text';
        span.textContent = 'COLOR ';
        
        const colorCircle = document.createElement('span');
        colorCircle.style.cssText = `display: inline-block; width: 1em; height: 1em; background-color: rgb(${targetColor.join(',')}); vertical-align: middle; border: 2px solid #fff; margin-left: 8px; border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,0.5);`;
        span.appendChild(colorCircle);
        
        tagDisplay.appendChild(span);
        
        const closeBtn = document.createElement('div');
        closeBtn.id = 'active-tag-close';
        closeBtn.textContent = '✕';
        closeBtn.onclick = clearAll;
        tagDisplay.appendChild(closeBtn);
        
        tagDisplay.classList.add('visible');
    }
    
    statusDiv.textContent = 'FILTERING BY COLOR...';
    setLoading(true);
    
    const matchedImages = [];
    const threshold = 30; // Distance threshold in RGB (very strict matching)
    
    images.forEach((img, i) => {
        if (!img.color) return;
        const dist = Math.sqrt(
            Math.pow(img.color[0] - targetColor[0], 2) +
            Math.pow(img.color[1] - targetColor[1], 2) +
            Math.pow(img.color[2] - targetColor[2], 2)
        );
        if (dist < threshold) {
            matchedImages.push({ ...img, originalIndex: i });
        }
    });
    
    if (matchedImages.length === 0) {
        statusDiv.textContent = 'NO_MATCHES';
        setLoading(false);
        return;
    }
    
    statusDiv.textContent = `CLUSTERING: ${matchedImages.length} MATCHES`;
    
    // Cluster the matches using SOM Worker
    const matchedVectors = matchedImages.filter(img => img.features).map(img => img.features);
    
    if (matchedVectors.length > 1) {
        const gridSize = Math.ceil(Math.sqrt(matchedVectors.length) * 1.5);
        const iterations = Math.min(500, matchedVectors.length * 10);
        
        const positions = await trainSOMAsync(matchedVectors, gridSize, gridSize, 1, iterations);
        
        let posIndex = 0;
        matchedImages.forEach((img) => {
            if (img.features) {
                const pos = positions[posIndex++];
                img.xSearch = pos.x;
                img.ySearch = pos.y;
            }
        });
    } else {
        matchedImages.forEach(img => { img.xSearch = 0; img.ySearch = 0; });
    }
    
    // Set coordinates for clustering and display with canvas renderer
    currentVisibleImages = matchedImages;
    displayImages(matchedImages);
    statusDiv.textContent = `FILTERED: ${matchedImages.length}`;
    setLoading(false);
    centerMap();
}

function updateWordCloud() {
    const wordcloudSection = document.getElementById('library-wordcloud-section');
    const wordcloudEl = document.getElementById('library-wordcloud');
    
    if (!currentLibrary || images.length === 0) {
        if (wordcloudSection) wordcloudSection.style.display = 'none';
        return;
    }
    
    // Count tag frequencies
    const tagCounts = {};
    images.forEach(img => {
        if (img.keywords && Array.isArray(img.keywords)) {
            img.keywords.forEach(kw => {
                const tag = kw.className || kw;
                tagCounts[tag] = (tagCounts[tag] || 0) + 1;
            });
        }
    });
    
    // Sort by frequency
    const sortedTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40); // Top 40 tags
    
    if (sortedTags.length === 0) {
        if (wordcloudSection) wordcloudSection.style.display = 'none';
        return;
    }
    
    // Show section
    if (wordcloudSection) wordcloudSection.style.display = 'block';
    
    // Clear and rebuild word cloud - all same size
    if (wordcloudEl) {
        wordcloudEl.innerHTML = '';
        
        sortedTags.forEach(([tag, count]) => {
            const tagEl = document.createElement('span');
            tagEl.className = 'wordcloud-tag';
            tagEl.textContent = tag;
            tagEl.title = `${count} images - Click to filter, click again to clear`;
            
            // Check if this tag is currently active
            const searchInput = document.getElementById('search-input');
            if (searchInput && searchInput.value.toLowerCase() === tag.toLowerCase()) {
                tagEl.classList.add('active');
            }
            
            // Click to filter or clear
            tagEl.onclick = () => {
                if (searchInput) {
                    // If clicking the same tag, clear the filter
                    if (searchInput.value.toLowerCase() === tag.toLowerCase()) {
                        searchInput.value = '';
                        clearAll();
                    } else {
                        // Otherwise, apply the filter
                        searchInput.value = tag;
                        searchImages();
                    }
                }
            };
            
            wordcloudEl.appendChild(tagEl);
        });
    }
}

function renameLibrary(libraryId) {
    const lib = libraries.find(l => l.id === libraryId);
    if (!lib) return;
    
    pendingLibraryAction = { type: 'rename', libraryId };
    const modal = document.getElementById('library-modal');
    const input = document.getElementById('library-name-input');
    const recursiveCheckbox = document.getElementById('library-recursive-checkbox');
    
    input.value = lib.name;
    
    // Set checkbox to current library's recursive state
    if (recursiveCheckbox) {
        recursiveCheckbox.checked = lib.recursive || false;
    }
    
    modal.style.display = 'flex';
    input.focus();
    input.select();
}

async function rescanLibrary(libraryId) {
    const lib = libraries.find(l => l.id === libraryId);
    if (!lib) return;
    
    const confirmed = await customConfirm(
        'FORCE RESCAN',
        `Force rescan library "${lib.name}"?\n\nThis will re-analyze all images. This may take several minutes.`
    );
    
    if (!confirmed) return;
    
    // Switch to this library if not already active
    if (!currentLibrary || currentLibrary.id !== libraryId) {
        await switchLibrary(libraryId);
    }
    
    // Force rescan (skip confirmation since we already confirmed)
    await rescanFolder(true);
    
    // Update last updated timestamp
    lib.lastUpdated = Date.now();
    await window.electronAPI.saveLibraries(libraries);
    renderLibrariesList();
}

async function deleteLibrary(libraryId) {
    const lib = libraries.find(l => l.id === libraryId);
    if (!lib) return;
    
    const confirmed = await customConfirm(
        'DELETE LIBRARY',
        `Delete library "${lib.name}"?\n\nThis will remove the library and its database.`
    );
    
    if (!confirmed) return;
    
    // Delete from list
    libraries = libraries.filter(l => l.id !== libraryId);
    await window.electronAPI.saveLibraries(libraries);
    
    // Delete database file
    await window.electronAPI.deleteLibraryDb(libraryId);
    
    // Clear if it was the active library
    if (currentLibrary && currentLibrary.id === libraryId) {
        currentLibrary = null;
        document.getElementById('folder-path').value = '';
        mapContainer.innerHTML = '';
        images = [];
        imageNodeElements = [];
    }
    
    renderLibrariesList();
    statusDiv.textContent = 'LIBRARY_DELETED';
}

// Update library image count
async function updateLibraryImageCount() {
    if (!isElectron || !currentLibrary) return;
    
    // Update the current library's image count
    currentLibrary.imageCount = images.length;
    
    // Find and update in the libraries array
    const lib = libraries.find(l => l.id === currentLibrary.id);
    if (lib) {
        lib.imageCount = images.length;
        lib.lastUpdated = Date.now();
        
        // Save to disk
        await window.electronAPI.saveLibraries(libraries);
        
        // Re-render the list to show updated count
        renderLibrariesList();
    }
}

// Start Popup Logic
function initStartPopup() {
    const popup = document.getElementById('start-popup');
    const dontShow = localStorage.getItem('hideStartPopup');
    
    if (!dontShow) {
        popup.style.display = 'flex';
    } else {
        showLibrarySelection();
    }
}

function openHelp() {
    const popup = document.getElementById('start-popup');
    popup.style.display = 'flex';
}

function closeStartPopup() {
    const popup = document.getElementById('start-popup');
    const checkbox = document.getElementById('dont-show-again');
    
    if (checkbox.checked) {
        localStorage.setItem('hideStartPopup', 'true');
    }
    
    popup.style.display = 'none';
    showLibrarySelection();
}

function showLibrarySelection() {
    const modal = document.getElementById('library-selection-modal');
    modal.style.display = 'flex';
    renderLibrariesList(); // Update list in case it wasn't rendered yet
}

// Manual drift direction change
function changeDriftDirection() {
    randomizeTargetVelocity();
    statusDiv.textContent = 'DRIFT_DIRECTION_CHANGED';
    setTimeout(() => {
        if (statusDiv.textContent === 'DRIFT_DIRECTION_CHANGED') {
            statusDiv.textContent = 'SYSTEM_READY';
        }
    }, 1500);
}

// Similarity sorting functions
function setReferenceImage(index) {
    similarityReferenceIndex = index;
    similarityReferenceImage = images[index];
    
    // Update UI to show reference
    const similarityInfo = document.getElementById('similarity-info');
    const refNameEl = document.getElementById('similarity-ref-name');
    
    if (similarityInfo && refNameEl && similarityReferenceImage) {
        refNameEl.textContent = `Reference: ${similarityReferenceImage.name}`;
        similarityInfo.style.display = 'block';
    }
    
    // If already in similarity mode, re-sort
    if (currentSort === 'similarity') {
        sortBySimilarity();
    }
}

function clearSimilarityReference() {
    similarityReferenceIndex = null;
    similarityReferenceImage = null;
    
    const similarityInfo = document.getElementById('similarity-info');
    if (similarityInfo) {
        similarityInfo.style.display = 'none';
    }
    
    // Switch back to semantic sort
    setSorting('semantic');
}

async function sortBySimilarity() {
    if (!similarityReferenceImage || !similarityReferenceImage.features) {
        statusDiv.textContent = 'ERR: NO_REFERENCE_IMAGE';
        setLoading(false);
        // Auto-clear after a delay
        setTimeout(() => {
            statusDiv.textContent = 'SELECT_REFERENCE_IMAGE';
        }, 2000);
        return;
    }
    
    statusDiv.textContent = 'SORTING_BY_SIMILARITY';
    setLoading(true);
    
    // Calculate similarities for all images in batches to avoid blocking UI
    const refFeatures = similarityReferenceImage.features;
    const imagesWithSimilarity = [];
    const batchSize = 50; // Process 50 images at a time
    
    for (let batchStart = 0; batchStart < images.length; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, images.length);
        
        // Process this batch
        for (let i = batchStart; i < batchEnd; i++) {
            const img = images[i];
            
            if (!img.features) {
                imagesWithSimilarity.push({ ...img, similarity: 0, originalIndex: i });
                continue;
            }
            
            // Cosine similarity
            let dotProduct = 0;
            let normA = 0;
            let normB = 0;
            
            for (let j = 0; j < refFeatures.length; j++) {
                dotProduct += refFeatures[j] * img.features[j];
                normA += refFeatures[j] * refFeatures[j];
                normB += img.features[j] * img.features[j];
            }
            
            const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
            
            imagesWithSimilarity.push({ ...img, similarity, originalIndex: i });
        }
        
        // Allow UI to update between batches
        await new Promise(resolve => setTimeout(resolve, 0));
        
        // Update progress
        const progress = Math.round((batchEnd / images.length) * 100);
        statusDiv.textContent = `CALCULATING_SIMILARITY: ${progress}%`;
    }
    
    // Sort by similarity (descending)
    imagesWithSimilarity.sort((a, b) => b.similarity - a.similarity);
    
    // Arrange in "Solar System" / Elliptical Orbit Layout
    const centerX = 50;
    const centerY = 50;
    
    imagesWithSimilarity.forEach((img, i) => {
        if (i === 0) {
            // Reference image at center ("Sun")
            img.xSim = centerX;
            img.ySim = centerY;
        } else {
            // Place on elliptical orbits - more similar = closer orbits
            // Determine which orbit this image is on
            const imagesPerOrbit = 8; // Start with 8 images on first orbit, increase for outer orbits
            let currentOrbit = 0;
            let imagesInPreviousOrbits = 0;
            let totalCapacity = 0;
            
            // Find which orbit this image belongs to
            while (totalCapacity < i) {
                currentOrbit++;
                const orbitCapacity = imagesPerOrbit * currentOrbit;
                totalCapacity += orbitCapacity;
            }
            
            // Position within the orbit
            const prevCapacity = currentOrbit === 1 ? 0 : (imagesPerOrbit * (currentOrbit - 1) * currentOrbit) / 2;
            const positionInOrbit = i - prevCapacity - 1;
            const itemsInThisOrbit = imagesPerOrbit * currentOrbit;
            const angle = (positionInOrbit / itemsInThisOrbit) * Math.PI * 2;
            
            // Orbital radius increases with distance (circular orbits)
            const radius = currentOrbit * 2.0; // Same radius for both X and Y = perfect circle
            
            img.xSim = centerX + Math.cos(angle) * radius;
            img.ySim = centerY + Math.sin(angle) * radius;
        }
    });
    
    currentVisibleImages = imagesWithSimilarity;
    displaySimilarityImages(imagesWithSimilarity);
    
    statusDiv.textContent = 'SORTED_BY_SIMILARITY';
    setLoading(false);
}

function displaySimilarityImages(imageList) {
    // Use the main displayImages function with canvas renderer
    displayImages(imageList);
}

function displayVibeGradientImages(imageList) {
    // Use the main displayImages function with canvas renderer
    displayImages(imageList);
}

function displayFilteredImages(matchedImages) {
    // Use the main displayImages function with canvas renderer  
    displayImages(matchedImages);
}

// Load libraries on startup
if (isElectron) {
    loadLibraries();
}

// Initialize popup
initStartPopup();

// Score filter setup with debouncing
const scoreSlider = document.getElementById('score-slider');
const scoreValue = document.getElementById('score-value');

// Debounce function to prevent lag
let filterDebounceTimer = null;
function debounceFilters(delay = 300) {
    if (filterDebounceTimer) {
        clearTimeout(filterDebounceTimer);
    }
    filterDebounceTimer = setTimeout(() => {
        applyFilters();
    }, delay);
}

if (scoreSlider && scoreValue) {
    scoreSlider.addEventListener('input', (e) => {
        const value = parseFloat(e.target.value);
        scoreValue.textContent = value > 0 ? `${value}+` : 'All';
        activeScoreFilter = value;
        
        // Update UI immediately but debounce the heavy filtering operation
        debounceFilters();
    });
}

// Apply all active filters (text search, score, color, media type)
async function applyFilters() {
    const searchInput = document.getElementById('search-input');
    const keyword = searchInput ? searchInput.value.toLowerCase().trim() : '';
    
    // Start with all images
    let filtered = [...images];
    
    // Apply score filter - only filter images that have scores
    if (activeScoreFilter > 0) {
        // Check if ANY images have scores
        const imagesWithScores = filtered.filter(img => img.aestheticScore !== undefined && img.aestheticScore !== null);
        
        if (imagesWithScores.length > 0) {
            // Only filter images that have scores and meet the threshold
            filtered = imagesWithScores.filter(img => img.aestheticScore >= activeScoreFilter);
        }
        // If no images have scores, don't apply the filter at all
    }
    
    // Apply media type filter
    if (activeMediaFilter !== 'all') {
        filtered = filtered.filter(img => {
            if (img.keywords && Array.isArray(img.keywords)) {
                return img.keywords.some(kw => {
                    const className = kw.className || kw;
                    return className.toLowerCase() === activeMediaFilter;
                });
            }
            return false;
        });
    }
    
    // Apply color filter
    if (activeColorFilter) {
        const threshold = 30;
        filtered = filtered.filter(img => {
            if (!img.color) return false;
            const dist = Math.sqrt(
                Math.pow(img.color[0] - activeColorFilter[0], 2) +
                Math.pow(img.color[1] - activeColorFilter[1], 2) +
                Math.pow(img.color[2] - activeColorFilter[2], 2)
            );
            return dist < threshold;
        });
    }
    
    // Apply text search filter
    if (keyword) {
        const searchRegex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        filtered = filtered.filter(img => {
            return img.keywords && img.keywords.some(p => searchRegex.test(p.className));
        });
    }
    
    // If no images match all filters
    if (filtered.length === 0) {
        statusDiv.textContent = 'NO_MATCHES';
        displayImages([]);
        return;
    }
    
    // If filtered, re-cluster
    if (filtered.length < images.length) {
        statusDiv.textContent = `CLUSTERING: ${filtered.length} MATCHES`;
        setLoading(true);
        
        const matchedImages = filtered.map((img, i) => ({ ...img, originalIndex: i }));
        const matchedVectors = matchedImages.filter(img => img.features).map(img => img.features);
        
        if (matchedVectors.length > 1) {
            const gridSize = Math.ceil(Math.sqrt(matchedVectors.length) * 1.5);
            const iterations = Math.min(500, matchedVectors.length * 10);
            
            const positions = await trainSOMAsync(matchedVectors, gridSize, gridSize, 1, iterations);
            
            let posIndex = 0;
            matchedImages.forEach((img) => {
                if (img.features) {
                    const pos = positions[posIndex++];
                    img.xSearch = pos.x;
                    img.ySearch = pos.y;
                }
            });
        } else {
            matchedImages.forEach(img => { img.xSearch = 0; img.ySearch = 0; });
        }
        
        currentVisibleImages = matchedImages;
        displayFilteredImages(matchedImages);
        statusDiv.textContent = `FILTERED: ${filtered.length}`;
        setLoading(false);
        centerMap();
    } else {
        // Show all images with original layout
        currentVisibleImages = images;
        displayImages(images);
        statusDiv.textContent = 'SYSTEM_READY';
    }
}

// Vibe Gradient Functions
function setVibeAnchor(index, img) {
    if (!vibeAnchorStart) {
        vibeAnchorStart = { index, img };
        statusDiv.textContent = 'VIBE_START_SET';
        updateVibeAnchorDisplay();
        setTimeout(() => {
            if (statusDiv.textContent === 'VIBE_START_SET') {
                statusDiv.textContent = 'SYSTEM_READY';
            }
        }, 1500);
    } else if (!vibeAnchorEnd) {
        vibeAnchorEnd = { index, img };
        statusDiv.textContent = 'VIBE_END_SET';
        updateVibeAnchorDisplay();
        setTimeout(() => {
            if (statusDiv.textContent === 'VIBE_END_SET') {
                statusDiv.textContent = 'SYSTEM_READY';
            }
        }, 1500);
        
        // Auto-switch to vibe gradient mode if both anchors are set
        if (currentSort !== 'vibe') {
            setSorting('vibe');
        }
    } else {
        // If both are set, replace the start with the current start, and set new end
        vibeAnchorStart = vibeAnchorEnd;
        vibeAnchorEnd = { index, img };
        updateVibeAnchorDisplay();
        
        // Re-sort if already in vibe mode
        if (currentSort === 'vibe') {
            sortByVibeGradient();
        }
    }
}

function clearVibeAnchors() {
    vibeAnchorStart = null;
    vibeAnchorEnd = null;
    updateVibeAnchorDisplay();
    statusDiv.textContent = 'VIBE_ANCHORS_CLEARED';
    setTimeout(() => {
        if (statusDiv.textContent === 'VIBE_ANCHORS_CLEARED') {
            statusDiv.textContent = 'SYSTEM_READY';
        }
    }, 1500);
    
    // Switch back to semantic sort
    setSorting('semantic');
}

function updateVibeAnchorDisplay() {
    const vibeInfo = document.getElementById('vibe-info');
    const startEl = document.getElementById('vibe-anchor-start');
    const endEl = document.getElementById('vibe-anchor-end');
    
    if (!vibeInfo || !startEl || !endEl) return;
    
    if (vibeAnchorStart) {
        startEl.textContent = `Start: ${vibeAnchorStart.img.name}`;
    } else {
        startEl.textContent = 'Start: None (Ctrl+Right-click)';
    }
    
    if (vibeAnchorEnd) {
        endEl.textContent = `End: ${vibeAnchorEnd.img.name}`;
    } else {
        endEl.textContent = 'End: None (Ctrl+Right-click)';
    }
    
    // Show info panel when in vibe mode
    vibeInfo.style.display = (currentSort === 'vibe') ? 'block' : 'none';
}

async function sortByVibeGradient() {
    if (!vibeAnchorStart || !vibeAnchorEnd) {
        statusDiv.textContent = 'ERR: NEED_TWO_ANCHORS';
        setLoading(false);
        setTimeout(() => {
            statusDiv.textContent = 'SET_VIBE_ANCHORS';
        }, 2000);
        return;
    }
    
    if (!vibeAnchorStart.img.features || !vibeAnchorEnd.img.features) {
        statusDiv.textContent = 'ERR: ANCHOR_MISSING_FEATURES';
        setLoading(false);
        return;
    }
    
    statusDiv.textContent = 'CALCULATING_VIBE_GRADIENT';
    setLoading(true);
    
    // Get the "Vibe Embedding" by combining SigLIP (semantic) + DINOv2 (visual)
    // For now, we'll use just SigLIP features (semantic), but this is where
    // you'd combine with DINO features for full "vibe space"
    const startFeatures = vibeAnchorStart.img.features;
    const endFeatures = vibeAnchorEnd.img.features;
    
    // Calculate projection along the "vibe vector" (start → end)
    const vibeVector = [];
    for (let i = 0; i < startFeatures.length; i++) {
        vibeVector.push(endFeatures[i] - startFeatures[i]);
    }
    
    // Normalize the vibe vector
    let vibeNorm = 0;
    for (let i = 0; i < vibeVector.length; i++) {
        vibeNorm += vibeVector[i] * vibeVector[i];
    }
    vibeNorm = Math.sqrt(vibeNorm);
    
    if (vibeNorm === 0) {
        statusDiv.textContent = 'ERR: IDENTICAL_ANCHORS';
        setLoading(false);
        return;
    }
    
    const normalizedVibeVector = vibeVector.map(v => v / vibeNorm);
    
    // Project each image onto the vibe gradient
    const imagesWithProjection = [];
    
    for (let i = 0; i < images.length; i++) {
        const img = images[i];
        
        if (!img.features) {
            imagesWithProjection.push({ ...img, vibePosition: 0, originalIndex: i });
            continue;
        }
        
        // Calculate projection: dot product with normalized vibe vector
        // First, translate to start anchor frame
        const relativeFeatures = [];
        for (let j = 0; j < img.features.length; j++) {
            relativeFeatures.push(img.features[j] - startFeatures[j]);
        }
        
        // Project onto vibe vector
        let projection = 0;
        for (let j = 0; j < relativeFeatures.length; j++) {
            projection += relativeFeatures[j] * normalizedVibeVector[j];
        }
        
        // Normalize to 0-1 range (0 = start anchor, 1 = end anchor)
        const normalizedPosition = projection / vibeNorm;
        
        imagesWithProjection.push({ 
            ...img, 
            vibePosition: normalizedPosition, 
            originalIndex: i 
        });
        
        // Allow UI to update periodically
        if (i % 50 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            const progress = Math.round((i / images.length) * 100);
            statusDiv.textContent = `CALCULATING_VIBE_GRADIENT: ${progress}%`;
        }
    }
    
    // Sort by vibe position
    imagesWithProjection.sort((a, b) => a.vibePosition - b.vibePosition);
    
    // Calculate optimal grid dimensions
    const cols = Math.min(Math.ceil(Math.sqrt(imagesWithProjection.length * 1.5)), 20);
    
    // Arrange in a smooth gradient line
    imagesWithProjection.forEach((img, i) => {
        img.xVibe = i % cols;
        img.yVibe = Math.floor(i / cols);
    });
    
    currentVisibleImages = imagesWithProjection;
    displayVibeGradientImages(imagesWithProjection);
    
    statusDiv.textContent = 'VIBE_GRADIENT_ACTIVE';
    setLoading(false);
}

