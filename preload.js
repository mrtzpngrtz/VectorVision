const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Scan folder for images
    scanFolder: (folderPath, recursive) => ipcRenderer.invoke('scan-folder', folderPath, recursive),
    
    // Load database (with optional libraryId)
    loadDatabase: (libraryId) => ipcRenderer.invoke('load-database', libraryId),
    
    // Save database (with optional libraryId)
    saveDatabase: (data, libraryId) => ipcRenderer.invoke('save-database', data, libraryId),
    
    // Library management
    getLibraries: () => ipcRenderer.invoke('get-libraries'),
    saveLibraries: (libraries) => ipcRenderer.invoke('save-libraries', libraries),
    deleteLibraryDb: (libraryId) => ipcRenderer.invoke('delete-library-db', libraryId),
    
    // Analyze images (returns promise). Forward forceReloadLabels so Force Rescan
    // actually reloads labels.js (the main handler honors the 2nd arg).
    analyzeImages: (imagePaths, forceReloadLabels = false) => ipcRenderer.invoke('analyze-images', imagePaths, forceReloadLabels),
    
    // Get image data as base64
    getImageData: (imagePath) => ipcRenderer.invoke('get-image-data', imagePath),
    
    // Select folder dialog
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    
    // Listen for analysis progress updates
    onAnalysisProgress: (callback) => {
        ipcRenderer.on('analysis-progress', (event, data) => callback(data));
    },
    
    // Remove analysis progress listener
    removeAnalysisProgressListener: () => {
        ipcRenderer.removeAllListeners('analysis-progress');
    },
    
    // Listen for model system info
    onModelSystemInfo: (callback) => {
        ipcRenderer.on('model-system-info', (event, data) => callback(data));
    },
    
    // Listen for model download progress
    onModelDownloadProgress: (callback) => {
        ipcRenderer.on('model-download-progress', (event, data) => callback(data));
    },
    
    // Listen for model download complete
    onModelDownloadComplete: (callback) => {
        ipcRenderer.on('model-download-complete', (event, data) => callback(data));
    },

    // Clipboard operations
    copyToClipboard: (imagePath) => ipcRenderer.invoke('copy-to-clipboard', imagePath),
    
    // File operations
    saveImage: (sourcePath) => ipcRenderer.invoke('save-image', sourcePath),
    openInFolder: (filePath) => ipcRenderer.invoke('open-in-folder', filePath),
    openExternal: (url) => ipcRenderer.invoke('open-external', url)
});

console.log('Preload script loaded - Electron API bridge ready');
