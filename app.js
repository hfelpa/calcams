// UI Elements
const mapElement = document.getElementById('map');
const elevationValue = document.getElementById('elevationValue');
const coordinatesValue = document.getElementById('coordinatesValue');
const loadingSpinner = document.getElementById('loadingSpinner');
const infoPanel = document.getElementById('infoPanel');
const fileInput = document.getElementById('fileInput');
const resultsSection = document.getElementById('resultsSection');
const legsTableBody = document.getElementById('legsTableBody');
const exportBtn = document.getElementById('exportBtn');

// Upload Area UI Elements
const uploadFileName = document.getElementById('upload-file-name');
const dragZoneContainer = document.getElementById('dragZoneContainer');
const uploadIcon = document.getElementById('upload-icon');
const uploadBtnText = document.getElementById('upload-btn-text');
const helpPanel = document.getElementById('helpPanel');

// Initialize Map
const map = L.map('map', {
    zoomControl: false
}).setView([-14.2350, -51.9253], 4);

const darkTileUrl = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const lightTileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

// Add Dynamic Theme Base Layer
const baseTileLayer = L.tileLayer(darkTileUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
}).addTo(map);

// Add Zoom Control to Top Right
L.control.zoom({
    position: 'topright'
}).addTo(map);

// Layer Group to hold route drawings
const routeLayers = L.layerGroup().addTo(map);

// Theme Toggle Logic
const themeBtns = document.querySelectorAll('.theme-btn');
themeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        const selectedTheme = btn.getAttribute('data-theme');
        localStorage.setItem('app-theme', selectedTheme);
        applyTheme(selectedTheme);
    });
});

function applyTheme(theme) {
    let isDark = true;
    if (theme === 'light') {
        isDark = false;
    } else if (theme === 'dark') {
        isDark = true;
    } else { // System determination fallback
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    const html = document.documentElement;
    const body = document.body;

    // Highlight theme buttons matching hawgoff style
    themeBtns.forEach(b => {
        b.classList.remove('bg-white/20', 'bg-black/15');
        b.classList.add('hover:bg-white/10');
    });

    const activeMode = isDark ? 'dark' : 'light';
    const activeBtn = document.getElementById(`theme-btn-${activeMode}`);
    if (activeBtn) {
        activeBtn.classList.remove('hover:bg-white/10');
        activeBtn.classList.add(isDark ? 'bg-white/20' : 'bg-black/15');
    }

    if (isDark) {
        body.classList.remove('light-theme', 'light-mode');
        body.classList.add('dark-theme', 'dark-mode');
        html.classList.remove('light');
        html.classList.add('dark');
        baseTileLayer.setUrl(darkTileUrl);
    } else {
        body.classList.add('light-theme', 'light-mode');
        body.classList.remove('dark-theme', 'dark-mode');
        html.classList.add('light');
        html.classList.remove('dark');
        baseTileLayer.setUrl(lightTileUrl);
    }
}

// System theme listener
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    // Only adjust dynamically if the user hasn't explicitly set a preference
    if (!localStorage.getItem('app-theme')) {
        applyTheme('system');
    }
});

// Load saved theme preference or use system preference
const savedTheme = localStorage.getItem('app-theme') || 'system';
applyTheme(savedTheme);

// State for custom TXT route
let parsedTxtRoute = null;
const globalTileCache = new Map();

// File Upload Handler
fileInput.addEventListener('change', handleFileUpload);

function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Update upload zone UI to show selected file and visual feedback
    if (uploadFileName) {
        uploadFileName.textContent = file.name;
        uploadFileName.classList.remove('opacity-60');
        uploadFileName.classList.add('text-dtc-accent', 'font-semibold');
    }
    if (dragZoneContainer) {
        dragZoneContainer.classList.add('border-dtc-accent', 'bg-dtc-accent/5');
    }
    if (uploadIcon) {
        uploadIcon.textContent = 'check_circle';
        uploadIcon.classList.remove('opacity-40');
        uploadIcon.classList.add('text-dtc-accent');
    }
    if (uploadBtnText) {
        uploadBtnText.textContent = 'Alterar Arquivo';
    }
    if (helpPanel) {
        helpPanel.classList.add('hidden');
    }

    const reader = new FileReader();
    reader.onload = function (evt) {
        const text = evt.target.result;

        // Hide export button by default on new upload
        exportBtn.classList.add('hidden');
        parsedTxtRoute = null;

        if (file.name.endsWith('.txt')) {
            processTxtRoute(text, file.name);
        } else {
            const parser = new DOMParser();
            const doc = parser.parseFromString(text, 'text/xml');
            let geojson;
            if (file.name.endsWith('.gpx')) {
                geojson = toGeoJSON.gpx(doc);
            } else if (file.name.endsWith('.kml')) {
                geojson = toGeoJSON.kml(doc);
            }

            if (geojson) {
                const coordinates = extractCoordinates(geojson);
                processRouteCoordinates(coordinates, false);
            } else {
                alert('Failed to parse route file. Please make sure it is a valid GPX or KML.');
            }
        }
    };
    reader.readAsText(file);
}

// Convert Lat/Lng to Tile Coordinates
function lon2tile(lon, zoom) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}
function lat2tile(lat, zoom) {
    return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));
}
function tile2lon(x, z) {
    return (x / Math.pow(2, z) * 360 - 180);
}
function tile2lat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return (180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
}

// Load a single Terrain Tile image and read its pixels
function loadTileImage(z, x, y) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const imageData = ctx.getImageData(0, 0, 256, 256);
            resolve(imageData);
        };
        img.onerror = () => {
            resolve(null);
        };
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    });
}

// Extract coords from GeoJSON features
function extractCoordinates(geojson) {
    const coords = [];
    
    // Find all LineString/MultiLineString features and categorize them
    const routeFeatures = [];
    const trackFeatures = [];
    
    turf.featureEach(geojson, (feature) => {
        const type = feature.geometry ? feature.geometry.type : '';
        if (type === 'LineString' || type === 'MultiLineString') {
            const gpxType = feature.properties ? feature.properties._gpxType : '';
            if (gpxType === 'rte') {
                routeFeatures.push(feature);
            } else if (gpxType === 'trk') {
                trackFeatures.push(feature);
            } else {
                // Fallback for lines without explicit type
                routeFeatures.push(feature);
            }
        }
    });

    // Prioritize GPX Routes (rte) over Tracks (trk)
    let selectedFeatures = [];
    if (routeFeatures.length > 0) {
        selectedFeatures = routeFeatures;
    } else if (trackFeatures.length > 0) {
        selectedFeatures = trackFeatures;
    }

    if (selectedFeatures.length > 0) {
        // Use coordinates from the selected lines (preserves sequence)
        selectedFeatures.forEach(feature => {
            turf.coordEach(feature, (coord) => {
                if (coords.length === 0) {
                    coords.push(coord);
                } else {
                    const last = coords[coords.length - 1];
                    const dist = turf.distance(turf.point(last), turf.point(coord), { units: 'meters' });
                    // Avoid adjacent duplicates (closer than 10 meters)
                    if (dist > 10) {
                        coords.push(coord);
                    }
                }
            });
        });
    } else {
        // Fallback: collect coordinates from individual Point features (Waypoints)
        // Usually used if the GPX only contains <wpt> elements
        turf.featureEach(geojson, (feature) => {
            const type = feature.geometry ? feature.geometry.type : '';
            if (type === 'Point') {
                const coord = feature.geometry.coordinates;
                if (coords.length === 0) {
                    coords.push(coord);
                } else {
                    const last = coords[coords.length - 1];
                    const dist = turf.distance(turf.point(last), turf.point(coord), { units: 'meters' });
                    if (dist > 10) {
                        coords.push(coord);
                    }
                }
            }
        });
    }

    return coords;
}

// Custom route parser for Rota1.txt format
function parseRouteFile(text) {
    const lines = text.split(/\r?\n/);
    const waypoints = [];
    const legs = [];

    let currentObject = null;
    let contextStack = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        const tabMatch = line.match(/^(\t*)/);
        const tabCount = tabMatch ? tabMatch[1].length : 0;

        while (contextStack.length > tabCount) {
            contextStack.pop();
        }

        const trimmed = line.trim();
        const objMatch = trimmed.match(/^IObjeto\s*-\s*(.*)$/);

        if (objMatch) {
            if (currentObject) {
                saveObject(currentObject, waypoints, legs);
            }
            currentObject = {
                name: objMatch[1],
                type: null,
                lat: null,
                lon: null,
                nivelMinimoLineIndex: null
            };
            contextStack = [];
            continue;
        }

        if (currentObject) {
            const eqIndex = trimmed.indexOf('=');
            if (eqIndex !== -1) {
                const key = trimmed.substring(0, eqIndex).trim();
                const value = trimmed.substring(eqIndex + 1).trim();

                const fullKey = contextStack.filter(Boolean).concat(key).join('.');

                if (key === 'Tipo') {
                    currentObject.type = value;
                } else if (fullKey.endsWith('GateIn.Posicao.Lat') || fullKey.endsWith('GateOut.Posicao.Lat') || fullKey === 'Posicao.Lat' || fullKey.endsWith('Posicao.Lat')) {
                    if (currentObject.lat === null) currentObject.lat = parseFloat(value);
                } else if (fullKey.endsWith('GateIn.Posicao.Lon') || fullKey.endsWith('GateOut.Posicao.Lon') || fullKey === 'Posicao.Lon' || fullKey.endsWith('Posicao.Lon')) {
                    if (currentObject.lon === null) currentObject.lon = parseFloat(value);
                } else if (fullKey.endsWith('Castelo.NivelMinimoIFR')) {
                    currentObject.nivelMinimoLineIndex = i;
                }
            } else {
                contextStack[tabCount] = trimmed;
            }
        }
    }

    if (currentObject) {
        saveObject(currentObject, waypoints, legs);
    }

    return { lines, waypoints, legs };
}

function saveObject(obj, waypoints, legs) {
    if (obj.type === 'NavWaypoint') {
        waypoints.push({
            name: obj.name,
            lat: obj.lat,
            lon: obj.lon
        });
    } else if (obj.type === 'NavPerna') {
        legs.push({
            name: obj.name,
            nivelMinimoLineIndex: obj.nivelMinimoLineIndex,
            ams: null
        });
    }
}

// Process the Custom TXT file route
function processTxtRoute(text, filename) {
    const parsed = parseRouteFile(text);
    if (parsed.waypoints.length < 2) {
        alert('Route file must contain at least 2 waypoints.');
        return;
    }

    // Store state
    parsedTxtRoute = {
        lines: parsed.lines,
        legs: parsed.legs,
        filename: filename
    };

    // Convert waypoints format to coordinates array [[lon, lat], ...]
    const coordinates = parsed.waypoints.map(wp => [wp.lon, wp.lat]);

    // Process calculations and show export button
    exportBtn.classList.remove('hidden');
    processRouteCoordinates(coordinates, true);
}

// Core processing coordinates flow
async function processRouteCoordinates(coordinates, isTxt) {
    routeLayers.clearLayers();
    legsTableBody.innerHTML = '';
    resultsSection.classList.remove('hidden');

    // Show overall loader
    loadingSpinner.classList.remove('hidden');
    infoPanel.classList.add('loading');
    elevationValue.textContent = 'Processing...';

    // Draw full route line on the map
    const routeLine = turf.lineString(coordinates);
    const routeLayer = L.geoJSON(routeLine, {
        style: { color: '#60a5fa', weight: 4, opacity: 0.8 }
    }).addTo(routeLayers);

    // Zoom map to the route
    map.fitBounds(routeLayer.getBounds(), { padding: [50, 50] });

    // Loop through each leg
    for (let i = 0; i < coordinates.length - 1; i++) {
        const ptA = coordinates[i];
        const ptB = coordinates[i + 1];

        const legLine = turf.lineString([ptA, ptB]);
        const corridor = turf.buffer(legLine, 18.52, { units: 'kilometers' });

        L.geoJSON(corridor, {
            style: { color: '#3b82f6', weight: 1, fillOpacity: 0.1, dashArray: '5, 5' }
        }).addTo(routeLayers);

        const bounds = turf.bbox(corridor);
        const zoom = 10;

        const minX = lon2tile(bounds[0], zoom);
        const maxX = lon2tile(bounds[2], zoom);
        const minY = lat2tile(bounds[3], zoom);
        const maxY = lat2tile(bounds[1], zoom);

        let maxElevFt = -99999;
        let minElevFt = 99999;
        let maxElevLat = null;
        let maxElevLng = null;

        const tilePromises = [];
        for (let tx = minX; tx <= maxX; tx++) {
            for (let ty = minY; ty <= maxY; ty++) {
                tilePromises.push({ tx, ty, promise: loadTileImage(zoom, tx, ty) });
            }
        }

        const tileResults = await Promise.all(tilePromises.map(t => t.promise));

        for (let k = 0; k < tilePromises.length; k++) {
            const imageData = tileResults[k];
            if (!imageData) continue;

            const tx = tilePromises[k].tx;
            const ty = tilePromises[k].ty;

            // Cache tile image data
            globalTileCache.set(`${zoom},${tx},${ty}`, imageData);

            const step = 4;

            for (let px = 0; px < 256; px += step) {
                for (let py = 0; py < 256; py += step) {
                    const lat = tile2lat(ty + py / 256, zoom);
                    const lng = tile2lon(tx + px / 256, zoom);

                    const point = turf.point([lng, lat]);

                    if (turf.booleanPointInPolygon(point, corridor)) {
                        const idx = (py * 256 + px) * 4;
                        const r = imageData.data[idx];
                        const g = imageData.data[idx + 1];
                        const b = imageData.data[idx + 2];

                        const elevM = (r * 256 + g + b / 256) - 32768;
                        const elevFt = elevM * 3.28084;

                        if (elevFt > maxElevFt) {
                            maxElevFt = elevFt;
                            maxElevLat = lat;
                            maxElevLng = lng;
                        }
                        if (elevFt < minElevFt) minElevFt = elevFt;
                    }
                }
            }
        }

        let ams = 0;
        const elevDiff = maxElevFt - minElevFt;

        if (maxElevFt === -99999) {
            maxElevFt = 0;
            minElevFt = 0;
            ams = 1000;
        } else {
            if (elevDiff > 1000) {
                ams = maxElevFt + 2000;
            } else {
                ams = maxElevFt + 1000;
            }
            ams = Math.ceil(ams / 100) * 100;
        }

        maxElevFt = Math.max(0, Math.round(maxElevFt));
        minElevFt = Math.max(0, Math.round(minElevFt));
        const finalVar = Math.max(0, Math.round(elevDiff));

        // Save calculate AMS value to state if it's a TXT route
        if (isTxt && parsedTxtRoute && parsedTxtRoute.legs[i]) {
            parsedTxtRoute.legs[i].ams = ams;
        }

        // Draw Peak Elevation Marker for Visual Verification
        if (maxElevLat !== null && maxElevLng !== null && maxElevFt !== -99999) {
            const peakIcon = L.divIcon({
                className: 'peak-marker',
                html: `<div style="background-color: #ef4444; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 8px #ef4444; cursor: pointer;"></div>`,
                iconSize: [10, 10],
                iconAnchor: [5, 5]
            });
            L.marker([maxElevLat, maxElevLng], { icon: peakIcon })
                .bindTooltip(`Leg ${i + 1} Peak: ${Math.round(maxElevFt)} ft`, {
                    direction: 'top',
                    className: 'peak-tooltip'
                })
                .addTo(routeLayers);
        }

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>WP ${i + 1} ➔ WP ${i + 2}</td>
            <td class="ams-highlight">${ams}</td>
            <td class="height-range-cell">
                <div class="height-max">${maxElevFt}</div>
                <div class="height-min">${minElevFt}</div>
            </td>
            <td>${finalVar}</td>
        `;
        legsTableBody.appendChild(row);
    }

    // We define a function to draw waypoints dynamically based on the current map zoom level
    const updateWaypointLabels = () => {
        // Find existing custom waypoint markers and remove them from routeLayers
        routeLayers.eachLayer((layer) => {
            if (layer instanceof L.Marker && (layer.options.icon.options.className === 'wp-custom-icon' || layer.options.icon.options.className === 'wp-label')) {
                routeLayers.removeLayer(layer);
            }
        });

        const zoom = map.getZoom();

        // Dynamic distance threshold (in meters) based on zoom level.
        // At zoom >= 15, we want to separate points unless they are extremely close (e.g. within 3m).
        // At low zoom levels, we group them if they are closer.
        let groupThreshold = 150; // default for mid zooms
        if (zoom >= 15) {
            groupThreshold = 3; // virtually ungrouped
        } else if (zoom >= 13) {
            groupThreshold = 30; // separate closer points
        } else if (zoom >= 11) {
            groupThreshold = 100;
        } else {
            groupThreshold = 400; // cluster heavily on high altitudes
        }

        const groups = [];
        coordinates.forEach((coord, index) => {
            const lat = coord[1];
            const lng = coord[0];

            let foundGroup = null;
            for (const g of groups) {
                const dist = turf.distance(
                    turf.point([lng, lat]),
                    turf.point([g.coords[1], g.coords[0]]),
                    { units: 'meters' }
                );
                if (dist < groupThreshold) {
                    foundGroup = g;
                    break;
                }
            }

            if (foundGroup) {
                foundGroup.indices.push(index + 1);
            } else {
                groups.push({
                    coords: [lat, lng],
                    indices: [index + 1]
                });
            }
        });

        groups.forEach((wp) => {
            const isMultiple = wp.indices.length > 1;
            let htmlContent = '';

            if (isMultiple) {
                const total = wp.indices.length;
                const labelsHtml = wp.indices.map((idx, offsetIdx) => {
                    const angle = (2 * Math.PI * offsetIdx) / total;
                    const radius = 35;
                    const dx = Math.round(Math.cos(angle) * radius);
                    const dy = Math.round(Math.sin(angle) * radius);

                    return `<div class="wp-child-label" style="--dx: ${dx}px; --dy: ${dy}px;">WP ${idx}</div>`;
                }).join('');

                htmlContent = `
                    <div class="wp-cluster-container">
                        <div class="wp-cluster-badge">WP ${wp.indices[0]}*</div>
                        ${labelsHtml}
                    </div>
                `;
            } else {
                htmlContent = `<div class="wp-label-single">WP ${wp.indices[0]}</div>`;
            }

            const labelWidth = 65;
            const marker = L.marker(wp.coords, {
                icon: L.divIcon({
                    className: 'wp-custom-icon',
                    html: htmlContent,
                    iconSize: [labelWidth, 24],
                    iconAnchor: [labelWidth / 2, 12]
                }),
                interactive: true
            }).addTo(routeLayers);

            // Add click interaction fallback for touch screens and leaflet maps
            marker.on('click', (ev) => {
                L.DomEvent.stopPropagation(ev); // Prevent map clicks
                const container = ev.target.getElement().querySelector('.wp-cluster-container');
                if (container) {
                    container.classList.toggle('expanded');
                }
            });
        });
    };

    // Initial render of waypoints
    updateWaypointLabels();

    // Listen to zoom changes to re-calculate grouping threshold and redraw labels
    map.on('zoomend', updateWaypointLabels);

    // Hide loader
    loadingSpinner.classList.add('hidden');
    infoPanel.classList.remove('loading');
    elevationValue.textContent = '-- ft';
}

// Export Calculated Route TXT
exportBtn.addEventListener('click', () => {
    if (!parsedTxtRoute) return;

    const { lines, legs, filename } = parsedTxtRoute;

    // Mutate the lines array with calculated AMS values
    legs.forEach((leg) => {
        if (leg.nivelMinimoLineIndex !== null && leg.ams !== null) {
            const originalLine = lines[leg.nivelMinimoLineIndex];
            const indentMatch = originalLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '\t\t\t\t';
            lines[leg.nivelMinimoLineIndex] = `${indent}Castelo.NivelMinimoIFR = ${leg.ams}`;
        }
    });

    const outputText = lines.join('\n');
    const blob = new Blob([outputText], { type: 'text/plain;charset=utf-8' });

    // Create download link
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Calculated_${filename}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// Single-click map query coordinates fallback
map.on('click', async (e) => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;
    coordinatesValue.textContent = formatGGMM(lat, lng);
});

// Formatting Lat/Lng into Degrees and Minutes with decimals (GG MM.MM)
function formatGGMM(lat, lng) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const absLat = Math.abs(lat);
    const latDeg = Math.floor(absLat);
    const latMin = ((absLat - latDeg) * 60).toFixed(2).padStart(5, '0');

    const lngDir = lng >= 0 ? 'E' : 'W';
    const absLng = Math.abs(lng);
    const lngDeg = Math.floor(absLng);
    const lngMin = ((absLng - lngDeg) * 60).toFixed(2).padStart(5, '0');

    const paddedLngDeg = lngDeg.toString().padStart(3, '0');

    return `Lat: ${latDir} ${latDeg}° ${latMin}' / Lng: ${lngDir} ${paddedLngDeg}° ${lngMin}'`;
}

// Throttle utility to limit mousemove event density
function throttle(func, limit) {
    let inThrottle;
    return function () {
        const args = arguments;
        const context = this;
        if (!inThrottle) {
            func.apply(context, args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    }
}

// Mousemove event for continuous elevation and coordinate tracking
map.on('mousemove', throttle(async (e) => {
    const lat = e.latlng.lat;
    const lng = e.latlng.lng;

    // Update coordinates formatted as GG MM.MM
    coordinatesValue.textContent = formatGGMM(lat, lng);

    const zoom = 10;
    const tx = lon2tile(lng, zoom);
    const ty = lat2tile(lat, zoom);
    const cacheKey = `${zoom},${tx},${ty}`;

    let imageData = globalTileCache.get(cacheKey);
    if (!imageData) {
        // Fetch tile on the fly if not cached
        elevationValue.textContent = '... ft';
        imageData = await loadTileImage(zoom, tx, ty);
        if (imageData) {
            globalTileCache.set(cacheKey, imageData);
        } else {
            elevationValue.textContent = '-- ft';
            return;
        }
    }

    // Decode elevation from cached tile
    const fx = (lng + 180) / 360 * Math.pow(2, zoom);
    const fy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom);
    const px = Math.floor((fx - tx) * 256);
    const py = Math.floor((fy - ty) * 256);

    const clampedPx = Math.max(0, Math.min(255, px));
    const clampedPy = Math.max(0, Math.min(255, py));

    const idx = (clampedPy * 256 + clampedPx) * 4;
    const r = imageData.data[idx];
    const g = imageData.data[idx + 1];
    const b = imageData.data[idx + 2];

    const elevM = (r * 256 + g + b / 256) - 32768;
    const elevFt = Math.round(elevM * 3.28084);

    elevationValue.textContent = `${elevFt} ft`;
}, 50));
