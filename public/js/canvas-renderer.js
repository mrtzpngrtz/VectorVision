// canvas-renderer.js - High-performance canvas-based image renderer with viewport culling
// Replaces DOM-based image nodes for 10,000+ image performance

class CanvasRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { 
            alpha: false,
            desynchronized: true // Hint for better performance
        });
        
        // Configuration
        this.worldSize = options.worldSize || 4000;
        this.gridDotSize = options.gridDotSize || 40;
        this.imageSize2D = options.imageSize2D || 80;
        this.imageSize3D = options.imageSize3D || 80;
        
        // Camera/viewport state
        this.camera = {
            x: 0,
            y: 0,
            z: -2000,
            scale: 1,
            rotX: -20,
            rotY: 45
        };
        
        // Rendering state
        this.is3D = false;
        this.items = [];
        this.textureCache = new Map();
        this.maxCacheSize = 1000; // Maximum number of textures to keep in memory
        this.pendingTextures = new Set();
        this.pendingPromises = new Map(); // key -> in-flight load Promise (dedup)
        
        // Interaction
        this.hoveredItem = null;
        this.onHover = null;
        this.onClick = null;
        this.onDoubleClick = null;
        this.onRightClick = null;
        
        // Performance
        this.cullingMargin = 200; // Extra margin for culling to prevent pop-in
        this.lastFrameTime = 0;
        this.isAnimating = false;
        this.needsRender = false; // Flag for batched rendering
        this.renderScheduled = false; // Prevent multiple render requests
        
        // High DPI support
        this.setupHighDPI();
        
        // Resize handling. A ResizeObserver on the canvas catches every size
        // change — initial layout, window resize, and sidebar toggles — not just
        // window 'resize' events. Without this the canvas keeps whatever size it
        // had at construction (often before layout settled), so displayHeight is
        // too small and items below it get culled (blank bottom / "16:9 cutoff").
        this.resizeTimeout = null;
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => this.handleResize(), 100);
            });
            this.resizeObserver.observe(this.canvas);
        } else {
            window.addEventListener('resize', () => {
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => this.handleResize(), 150);
            });
        }
    }
    
    setupHighDPI() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();

        // Only size the drawing BUFFER here. Do NOT write canvas.style.width/height:
        // the element's display size is driven by CSS (width/height: 100%), and
        // pinning it to fixed pixels from the first measurement would lock the
        // canvas to its construction-time size forever (the "16:9 cutoff" bug —
        // the canvas never grew with the window and the ResizeObserver, watching
        // a now-pinned box, never fired again).
        this.canvas.width = Math.round(rect.width * dpr);
        this.canvas.height = Math.round(rect.height * dpr);

        // Setting canvas.width/height resets the context transform, so re-apply
        // the DPR scale from a known-identity state.
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.scale(dpr, dpr);
        this.displayWidth = rect.width;
        this.displayHeight = rect.height;
    }
    
    handleResize() {
        this.setupHighDPI();
        this.render();
    }
    
    // Set items to render
    setItems(items) {
        this.items = items;
        // Size the texture cache to the library (capped) so visible thumbnails
        // aren't evicted and re-decoded every frame — the main source of lag on
        // large libraries. Combined with LRU-by-access eviction in drawItem, a
        // capped cache still holds all on-screen textures.
        this.maxCacheSize = Math.min(Math.max(1000, items.length + 200), 8000);
        this.requestRender();
    }

    // Set camera position
    setCamera(camera) {
        Object.assign(this.camera, camera);
        this.requestRender();
    }

    // Set 3D mode
    set3DMode(is3D) {
        this.is3D = is3D;
        this.requestRender();
    }
    
    // Load texture (image) into cache
    loadTexture(url, key) {
        if (this.textureCache.has(key)) {
            return Promise.resolve(this.textureCache.get(key));
        }

        // Reuse the single in-flight load for this key. The old code spawned a
        // fresh setInterval(10ms) poller on every call for a pending key — during
        // thumbnail streaming that piled up hundreds of timers (and leaked forever
        // on a failed load, since the cache never got set). One shared Promise per
        // key fixes both.
        if (this.pendingPromises.has(key)) {
            return this.pendingPromises.get(key);
        }

        this.pendingTextures.add(key);

        const promise = new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';

            img.onload = () => {
                // LRU cache management
                if (this.textureCache.size >= this.maxCacheSize) {
                    const firstKey = this.textureCache.keys().next().value;
                    this.textureCache.delete(firstKey);
                }

                this.textureCache.set(key, img);
                this.pendingTextures.delete(key);
                this.pendingPromises.delete(key);
                resolve(img);
            };

            img.onerror = () => {
                this.pendingTextures.delete(key);
                this.pendingPromises.delete(key);
                reject(new Error(`Failed to load texture: ${url}`));
            };

            img.src = url;
        });

        this.pendingPromises.set(key, promise);
        return promise;
    }
    
    // Project 3D coordinates to 2D screen space
    project3D(x, y, z) {
        // Apply camera rotation
        const cosX = Math.cos(this.camera.rotX * Math.PI / 180);
        const sinX = Math.sin(this.camera.rotX * Math.PI / 180);
        const cosY = Math.cos(this.camera.rotY * Math.PI / 180);
        const sinY = Math.sin(this.camera.rotY * Math.PI / 180);
        
        // Rotate around Y axis
        let x1 = x * cosY - z * sinY;
        let z1 = x * sinY + z * cosY;
        
        // Rotate around X axis
        let y1 = y * cosX - z1 * sinX;
        let z2 = y * sinX + z1 * cosX;
        
        // Apply camera translation
        z2 += this.camera.z;
        
        // Perspective projection
        const fov = 1000;
        const scale = fov / (fov + z2);
        
        const screenX = x1 * scale + this.displayWidth / 2 + this.camera.x;
        const screenY = y1 * scale + this.displayHeight / 2 + this.camera.y;
        
        return { x: screenX, y: screenY, z: z2, scale };
    }
    
    // Check if item is in viewport
    isInViewport(item, margin = this.cullingMargin) {
        let x, y, z = 0;
        
        if (this.is3D) {
            x = item.x3 !== undefined ? item.x3 : (item.x || 0);
            y = item.y3 !== undefined ? item.y3 : (item.y || 0);
            z = item.z3 !== undefined ? item.z3 : (item.z || 0);
            
            const projected = this.project3D(x, y, z);
            
            // Cull by depth
            if (projected.z > 200 || projected.z < -6000) return false;
            
            // Cull by screen position
            const size = this.imageSize3D * projected.scale;
            return projected.x + size > -margin && 
                   projected.x - size < this.displayWidth + margin &&
                   projected.y + size > -margin && 
                   projected.y - size < this.displayHeight + margin;
        } else {
            x = item.x !== undefined ? item.x : 0;
            y = item.y !== undefined ? item.y : 0;
            
            // Apply camera transformation (same as drawItem)
            const screenX = x * this.camera.scale + this.camera.x;
            const screenY = y * this.camera.scale + this.camera.y;
            const size = this.imageSize2D * this.camera.scale;
            
            return screenX + size > -margin && 
                   screenX - size < this.displayWidth + margin &&
                   screenY + size > -margin && 
                   screenY - size < this.displayHeight + margin;
        }
    }
    
    // Request a render (batched via requestAnimationFrame)
    requestRender() {
        if (this.renderScheduled) return;
        this.renderScheduled = true;
        
        requestAnimationFrame(() => {
            this.renderScheduled = false;
            this.render();
        });
    }
    
    // Main render loop
    render() {
        // Clear canvas
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.displayWidth, this.displayHeight);
        
        // Draw grid background
        this.drawGrid();
        
        // Collect visible items
        const visibleItems = [];
        
        for (let i = 0; i < this.items.length; i++) {
            const item = this.items[i];
            if (this.isInViewport(item)) {
                visibleItems.push({ item, index: i });
            }
        }
        
        // Sort by depth (far to near for 3D)
        if (this.is3D) {
            visibleItems.sort((a, b) => {
                const zA = a.item.z3 !== undefined ? a.item.z3 : 0;
                const zB = b.item.z3 !== undefined ? b.item.z3 : 0;
                return zA - zB; // Far to near
            });
        }
        
        // Draw visible items
        for (const { item, index } of visibleItems) {
            this.drawItem(item, index);
        }
        
        // Update performance stats
        const now = performance.now();
        if (this.onFrameRender) {
            this.onFrameRender(visibleItems.length, now - this.lastFrameTime);
        }
        this.lastFrameTime = now;
    }
    
    // Draw grid background
    drawGrid() {
        if (this.is3D) return; // No grid in 3D mode

        const gridSize = this.gridDotSize * this.camera.scale;
        if (gridSize < 10) return; // Don't draw if too small

        // Draw the dot grid with a cached repeating pattern (one fillRect) instead
        // of a nested loop issuing ~thousands of fillRect(1,1) calls every frame.
        // The tile is rebuilt only when the zoom (and thus spacing) changes.
        const tileSize = Math.max(2, Math.round(gridSize));
        if (!this._gridPattern || this._gridTileSize !== tileSize) {
            const tile = document.createElement('canvas');
            tile.width = tileSize;
            tile.height = tileSize;
            const tctx = tile.getContext('2d');
            tctx.fillStyle = '#333333';
            tctx.fillRect(0, 0, 1, 1);
            this._gridTileSize = tileSize;
            this._gridPattern = this.ctx.createPattern(tile, 'repeat');
        }

        if (!this._gridPattern) {
            // Fallback: pattern unavailable — draw dots directly.
            this.ctx.fillStyle = '#333333';
            const startX = Math.floor(-this.camera.x / gridSize) * gridSize + this.camera.x;
            const startY = Math.floor(-this.camera.y / gridSize) * gridSize + this.camera.y;
            for (let x = startX; x < this.displayWidth; x += gridSize) {
                for (let y = startY; y < this.displayHeight; y += gridSize) {
                    this.ctx.fillRect(x, y, 1, 1);
                }
            }
            return;
        }

        // Offset the pattern so the dots track the camera pan.
        const offX = ((this.camera.x % tileSize) + tileSize) % tileSize;
        const offY = ((this.camera.y % tileSize) + tileSize) % tileSize;
        this.ctx.save();
        this.ctx.translate(offX, offY);
        this.ctx.fillStyle = this._gridPattern;
        this.ctx.fillRect(-offX, -offY, this.displayWidth + tileSize, this.displayHeight + tileSize);
        this.ctx.restore();
    }
    
    // Draw individual item
    drawItem(item, index) {
        let x, y, z = 0;
        let screenX, screenY, size, opacity = 1, brightness = 1;
        
        // Apply item-specific opacity if set (for search/filter highlighting)
        if (item._renderOpacity !== undefined) {
            opacity = Math.min(opacity, item._renderOpacity);
        }
        
        if (this.is3D) {
            x = item.x3 !== undefined ? item.x3 : 0;
            y = item.y3 !== undefined ? item.y3 : 0;
            z = item.z3 !== undefined ? item.z3 : 0;
            
            const projected = this.project3D(x, y, z);
            screenX = projected.x;
            screenY = projected.y;
            size = this.imageSize3D * projected.scale;
            
            // Apply depth-based fading
            const worldZ = projected.z;
            if (worldZ > -500) {
                opacity = Math.max(0, Math.min(1, (worldZ + 1000) / 500 - 1));
            }
            if (worldZ < -2000) {
                brightness = Math.max(0.1, 1 - (Math.abs(worldZ + 2000) / 4000));
            }
        } else {
            x = item.x !== undefined ? item.x : 0;
            y = item.y !== undefined ? item.y : 0;
            
            screenX = x * this.camera.scale + this.camera.x;
            screenY = y * this.camera.scale + this.camera.y;
            size = this.imageSize2D * this.camera.scale;
        }
        
        // Check if hovered
        const isHovered = this.hoveredItem === index;
        if (isHovered && !this.is3D) {
            size *= 1.8;
        } else if (isHovered && this.is3D) {
            size *= 2.0;
        }
        
        // Draw image if texture is loaded
        const textureKey = item.path || item.thumbUrl || `item-${index}`;
        const texture = this.textureCache.get(textureKey);

        if (texture) {
            // LRU touch: re-insert so this (visible) texture becomes most-recent.
            // Map preserves insertion order, so the evicted key (keys().next())
            // is always the least-recently-drawn — i.e. off-screen — texture.
            this.textureCache.delete(textureKey);
            this.textureCache.set(textureKey, texture);

            // Only apply filter if brightness is not 1 (expensive GPU operation)
            const needsFilter = brightness !== 1;
            
            if (opacity !== 1) this.ctx.globalAlpha = opacity;
            if (needsFilter) this.ctx.filter = `brightness(${brightness})`;

            // Preserve aspect ratio: fit the image inside the size×size cell
            // ("contain") instead of stretching non-square images into a square.
            const iw = texture.naturalWidth || texture.width || 1;
            const ih = texture.naturalHeight || texture.height || 1;
            let dw = size, dh = size;
            if (iw > ih) dh = size * (ih / iw);
            else if (ih > iw) dw = size * (iw / ih);

            this.ctx.drawImage(
                texture,
                screenX - dw / 2,
                screenY - dh / 2,
                dw,
                dh
            );

            // Reset state
            if (needsFilter) this.ctx.filter = 'none';
            if (opacity !== 1) this.ctx.globalAlpha = 1;
        } else {
            // Draw placeholder while loading
            this.ctx.fillStyle = '#222222';
            this.ctx.fillRect(
                screenX - size / 2,
                screenY - size / 2,
                size,
                size
            );
            
            // Trigger texture load
            // Check if this is a video file (can't be loaded as image texture)
            const isVideo = item.path && /\.(mp4|webm|gif)$/i.test(item.path);
            
            if (isVideo) {
                // Draw video indicator (play button icon)
                this.ctx.fillStyle = '#444444';
                this.ctx.fillRect(
                    screenX - size / 2,
                    screenY - size / 2,
                    size,
                    size
                );
                
                // Draw play button triangle
                this.ctx.fillStyle = '#ffffff';
                this.ctx.globalAlpha = 0.8;
                this.ctx.beginPath();
                const playSize = size * 0.3;
                this.ctx.moveTo(screenX - playSize * 0.3, screenY - playSize * 0.5);
                this.ctx.lineTo(screenX - playSize * 0.3, screenY + playSize * 0.5);
                this.ctx.lineTo(screenX + playSize * 0.5, screenY);
                this.ctx.closePath();
                this.ctx.fill();
                this.ctx.globalAlpha = 1;
            } else {
                // In Electron mode, use file:// URL or load thumbnail data
                let url = item.thumbnailData || item.thumbUrl || item.url;
                
                // If in Electron and no thumbnailData yet, construct file:// URL
                if (!url && item.path && window.electronAPI) {
                    url = `file:///${item.path.replace(/\\/g, '/')}`;
                }
                
                // Kick off the load only once per key. render() re-runs every
                // frame while thumbnails stream in; without this guard each frame
                // would attach another .then(requestRender) to the same load.
                if (url && !this.pendingTextures.has(textureKey)) {
                    this.loadTexture(url, textureKey).then(() => {
                        this.requestRender(); // Request batched render
                    }).catch(err => {
                        console.error('Error loading texture:', err);
                    });
                }
            }
        }
        
        this.ctx.globalAlpha = 1;
    }
    
    // Get item at screen coordinates
    getItemAtPosition(screenX, screenY) {
        // Check in reverse order (top to bottom)
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];
            
            if (!this.isInViewport(item)) continue;
            
            let x, y, z = 0;
            let itemScreenX, itemScreenY, size;
            
            if (this.is3D) {
                x = item.x3 !== undefined ? item.x3 : 0;
                y = item.y3 !== undefined ? item.y3 : 0;
                z = item.z3 !== undefined ? item.z3 : 0;
                
                const projected = this.project3D(x, y, z);
                itemScreenX = projected.x;
                itemScreenY = projected.y;
                size = this.imageSize3D * projected.scale;
            } else {
                x = item.x !== undefined ? item.x : 0;
                y = item.y !== undefined ? item.y : 0;
                
                itemScreenX = x * this.camera.scale + this.camera.x;
                itemScreenY = y * this.camera.scale + this.camera.y;
                size = this.imageSize2D * this.camera.scale;
            }
            
            const halfSize = size / 2;
            if (screenX >= itemScreenX - halfSize && screenX <= itemScreenX + halfSize &&
                screenY >= itemScreenY - halfSize && screenY <= itemScreenY + halfSize) {
                return { item, index: i };
            }
        }
        
        return null;
    }
    
    // Handle mouse move for hover.
    // mousemove fires far faster than the frame rate, and each hit-test is an
    // O(n) scan of every item (getItemAtPosition), so running it per event pegged
    // the main thread on large libraries. Instead we stash the latest cursor
    // position and run at most one hit-test per animation frame. Hover is also
    // meaningless mid-drag, so we skip it entirely while the user is panning.
    handleMouseMove(event) {
        if (this.isDragging) return;
        const rect = this.canvas.getBoundingClientRect();
        this._pendingHover = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        if (this._hoverScheduled) return;
        this._hoverScheduled = true;
        requestAnimationFrame(() => {
            this._hoverScheduled = false;
            if (this.isDragging || !this._pendingHover) return;
            const { x, y } = this._pendingHover;
            const result = this.getItemAtPosition(x, y);
            const newHoveredIndex = result ? result.index : null;

            if (newHoveredIndex !== this.hoveredItem) {
                this.hoveredItem = newHoveredIndex;
                if (this.onHover) {
                    this.onHover(result ? result.item : null, result ? result.index : null);
                }
                this.requestRender();
            }
        });
    }
    
    // Handle mouse click
    handleClick(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const result = this.getItemAtPosition(x, y);
        
        if (this.onClick && result) {
            this.onClick(result.item, result.index);
        }
    }
    
    // Handle double-click
    handleDoubleClick(event) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const result = this.getItemAtPosition(x, y);
        
        if (this.onDoubleClick && result) {
            event.stopPropagation();
            this.onDoubleClick(result.item, result.index);
        }
    }
    
    // Handle right-click
    handleRightClick(event) {
        event.preventDefault();
        
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        const result = this.getItemAtPosition(x, y);
        
        if (this.onRightClick && result) {
            event.stopPropagation();
            this.onRightClick(result.item, result.index);
        }
    }
    
    // Clear hover state
    clearHover() {
        if (this.hoveredItem !== null) {
            this.hoveredItem = null;
            this.requestRender();
        }
    }
    
    // Start animation loop
    startAnimationLoop(callback) {
        this.isAnimating = true;
        
        const animate = () => {
            if (!this.isAnimating) return;
            
            if (callback) {
                callback();
            }
            
            this.render();
            requestAnimationFrame(animate);
        };
        
        animate();
    }
    
    // Stop animation loop
    stopAnimationLoop() {
        this.isAnimating = false;
    }
    
    // Cleanup
    destroy() {
        this.stopAnimationLoop();
        this.textureCache.clear();
        this.items = [];
    }
}
