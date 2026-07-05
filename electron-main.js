const { app, BrowserWindow, ipcMain, dialog, Menu, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const analyzer = require('./server/analyzer');

const LIBRARIES_FILE = path.join(__dirname, 'server', 'libraries.json');
let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1800,
        height: 1000,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        backgroundColor: '#0a0a0a',
        title: 'ImageVector - Desktop'
    });

    mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

    // Open DevTools by default for debugging
    mainWindow.webContents.openDevTools();
    
    // Add keyboard shortcut to toggle DevTools (F12)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12') {
            mainWindow.webContents.toggleDevTools();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // Remove the default menu bar for a cleaner look
    Menu.setApplicationMenu(null);
    
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// IPC Handlers

// Helper function to recursively scan directories
function scanDirectory(dirPath, recursive = false) {
    const images = [];
    const supportedExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm'];
    
    function scan(currentPath) {
        try {
            const items = fs.readdirSync(currentPath);
            
            for (const item of items) {
                const itemPath = path.join(currentPath, item);
                
                try {
                    const stats = fs.statSync(itemPath);
                    
                    if (stats.isDirectory() && recursive) {
                        // Recursively scan subdirectory
                        scan(itemPath);
                    } else if (stats.isFile()) {
                        const ext = path.extname(item).toLowerCase();
                        if (supportedExts.includes(ext)) {
                            const mediaType = ['.mp4', '.webm', '.gif'].includes(ext) ? 'video' : 'static';
                            
                            images.push({
                                name: item,
                                path: itemPath,
                                created: stats.birthtimeMs || stats.mtimeMs,
                                mediaType: mediaType
                            });
                        }
                    }
                } catch (statErr) {
                    console.warn(`Could not stat ${itemPath}:`, statErr.message);
                }
            }
        } catch (readErr) {
            console.warn(`Could not read directory ${currentPath}:`, readErr.message);
        }
    }
    
    scan(dirPath);
    return images;
}

// Scan folder for images
ipcMain.handle('scan-folder', async (event, folderPath, recursive = false) => {
    if (!folderPath || !fs.existsSync(folderPath)) {
        throw new Error('Invalid folder path');
    }

    try {
        const images = scanDirectory(folderPath, recursive);
        return { images };
    } catch (error) {
        throw new Error(error.message);
    }
});

// Load database for a specific library
ipcMain.handle('load-database', async (event, libraryId) => {
    const dbFile = libraryId 
        ? path.join(__dirname, 'server', `db_${libraryId}.json`)
        : path.join(__dirname, 'server', 'database.json');
    
    if (fs.existsSync(dbFile)) {
        try {
            const data = fs.readFileSync(dbFile, 'utf8');
            return { data: JSON.parse(data) };
        } catch (e) {
            return { data: null };
        }
    }
    return { data: null };
});

// Save database for a specific library
ipcMain.handle('save-database', async (event, data, libraryId) => {
    try {
        const dbFile = libraryId 
            ? path.join(__dirname, 'server', `db_${libraryId}.json`)
            : path.join(__dirname, 'server', 'database.json');
        
        fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
        return { success: true };
    } catch (err) {
        throw new Error('Failed to save database');
    }
});

// Get libraries list
ipcMain.handle('get-libraries', async () => {
    if (fs.existsSync(LIBRARIES_FILE)) {
        try {
            const data = fs.readFileSync(LIBRARIES_FILE, 'utf8');
            return { libraries: JSON.parse(data) };
        } catch (e) {
            return { libraries: [] };
        }
    }
    return { libraries: [] };
});

// Save libraries list
ipcMain.handle('save-libraries', async (event, libraries) => {
    try {
        fs.writeFileSync(LIBRARIES_FILE, JSON.stringify(libraries, null, 2));
        return { success: true };
    } catch (err) {
        throw new Error('Failed to save libraries');
    }
});

// Delete library database
ipcMain.handle('delete-library-db', async (event, libraryId) => {
    try {
        const dbFile = path.join(__dirname, 'server', `db_${libraryId}.json`);
        if (fs.existsSync(dbFile)) {
            fs.unlinkSync(dbFile);
        }
        return { success: true };
    } catch (err) {
        throw new Error('Failed to delete library database');
    }
});

// Analyze images with native CLIP
ipcMain.handle('analyze-images', async (event, imagePaths, forceReloadLabels = false) => {
    try {
        // Pass event.sender to loadModel for download progress
        const modelInfo = await analyzer.loadModel(event.sender);
        
        // Send model system info to frontend
        event.sender.send('model-system-info', {
            modelSystem: modelInfo.modelSystem,
            hasAestheticModel: modelInfo.hasAestheticModel,
            hardwareProvider: modelInfo.hardwareProvider
        });
        
        // Reload labels if requested (for Force Rescan after editing labels.js)
        if (forceReloadLabels) {
            await analyzer.reloadLabels();
        }
        
        const results = [];
        const total = imagePaths.length;
        
        for (let i = 0; i < total; i++) {
            const imgPath = imagePaths[i];
            
            try {
                const result = await analyzer.extractFeatures(imgPath);
                if (result) {
                    results.push({
                        path: imgPath,
                        features: result.features,
                        keywords: result.keywords,
                        color: result.color,
                        colorVector: result.colorVector,
                        palette: result.palette,
                        aestheticScore: result.aestheticScore
                    });
                    
                    // Send progress update WITH keywords
                    event.sender.send('analysis-progress', {
                        current: i + 1,
                        total: total,
                        fileName: path.basename(imgPath),
                        keywords: result.keywords
                    });
                }
            } catch (err) {
                console.error(`Error analyzing ${imgPath}:`, err);
                results.push({
                    path: imgPath,
                    error: err.message
                });
                
                // Send progress even on error
                event.sender.send('analysis-progress', {
                    current: i + 1,
                    total: total,
                    fileName: path.basename(imgPath)
                });
            }
        }
        
        return { results };
    } catch (error) {
        throw new Error(error.message);
    }
});

// Helper function to check if file is a video
function isVideo(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return ['.mp4', '.webm'].includes(ext);
}

// Helper function to extract video frame
function extractVideoFrame(videoPath) {
    return new Promise((resolve, reject) => {
        const ffmpeg = require('fluent-ffmpeg');
        const TEMP_DIR = path.join(__dirname, 'temp_frames');
        
        // Ensure temp directory exists
        if (!fs.existsSync(TEMP_DIR)) {
            fs.mkdirSync(TEMP_DIR, { recursive: true });
        }
        
        const tempImagePath = path.join(TEMP_DIR, `frame_${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`);
        
        ffmpeg()
            .input(videoPath)
            .inputOptions(['-ss', '0'])
            .outputOptions([
                '-vframes', '1',
                '-vf', 'scale=224:224:force_original_aspect_ratio=decrease,pad=224:224:(ow-iw)/2:(oh-ih)/2'
            ])
            .output(tempImagePath)
            .on('end', () => resolve(tempImagePath))
            .on('error', (err) => reject(err))
            .run();
    });
}

// Get image as data URL for thumbnails
ipcMain.handle('get-image-data', async (event, imagePath) => {
    let tempFrame = null;
    try {
        const sharp = require('sharp');
        let sourceImage = imagePath;
        
        // If it's a video, extract first frame
        if (isVideo(imagePath)) {
            try {
                tempFrame = await extractVideoFrame(imagePath);
                sourceImage = tempFrame;
            } catch (videoErr) {
                console.error('Video frame extraction error:', videoErr);
                throw new Error('Failed to extract video frame');
            }
        }
        
        const buffer = await sharp(sourceImage)
            .resize(150, 150, { fit: 'cover' })
            .jpeg({ quality: 70 })
            .toBuffer();
        
        // Clean up temp frame if created
        if (tempFrame && fs.existsSync(tempFrame)) {
            fs.unlinkSync(tempFrame);
        }
        
        return { 
            dataUrl: `data:image/jpeg;base64,${buffer.toString('base64')}`
        };
    } catch (error) {
        // Clean up temp frame on error
        if (tempFrame && fs.existsSync(tempFrame)) {
            fs.unlinkSync(tempFrame);
        }
        throw new Error(error.message);
    }
});

// Select folder dialog
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        return { path: result.filePaths[0] };
    }
    
    return { path: null };
});

// Copy image to clipboard
ipcMain.handle('copy-to-clipboard', async (event, imagePath) => {
    try {
        const nativeImage = require('electron').nativeImage;
        const image = nativeImage.createFromPath(imagePath);
        clipboard.writeImage(image);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Save image to location
ipcMain.handle('save-image', async (event, sourcePath) => {
    try {
        const ext = path.extname(sourcePath);
        const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: 'saved_image' + ext,
            filters: [{ name: 'Image', extensions: [ext.replace('.', '')] }]
        });
        
        if (canceled || !filePath) return { canceled: true };
        
        fs.copyFileSync(sourcePath, filePath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Open file in folder
ipcMain.handle('open-in-folder', async (event, filePath) => {
    try {
        shell.showItemInFolder(filePath);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Open external URL
ipcMain.handle('open-external', async (event, url) => {
    try {
        await shell.openExternal(url);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

console.log('ImageVector Electron App Started');
console.log('Hardware acceleration enabled via ONNX Runtime');
