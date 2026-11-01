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

// Base layers: Esri street map (light) and Esri dark gray canvas with labels (dark). No API key needed.
// tile.openstreetmap.org is not used because it blocks apps that do not follow its tile usage policy (HTTP 403).
const esriTiles = (service, options) => L.tileLayer(
    `https://services.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`,
    { attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors', maxZoom: 19, ...options });
const baseLayers = {
    light: esriTiles('World_Street_Map'),
    dark: L.layerGroup([
        esriTiles('Canvas/World_Dark_Gray_Base', { maxNativeZoom: 16 }),
        esriTiles('Canvas/World_Dark_Gray_Reference', { maxNativeZoom: 16 })
    ])
};
let activeBaseLayer = null;

function setBaseLayer(isDark) {
    const next = isDark ? baseLayers.dark : baseLayers.light;
    if (next === activeBaseLayer) return;
    if (activeBaseLayer) map.removeLayer(activeBaseLayer);
    next.addTo(map);
    activeBaseLayer = next;
}

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

    setBaseLayer(isDark);

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
    } else {
        body.classList.add('light-theme', 'light-mode');
        body.classList.remove('dark-theme', 'dark-mode');
        html.classList.add('light');
        html.classList.remove('dark');
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

// State for the loaded route
let currentTxt = null;      // { parsed, filename, amsByLeg } when the loaded route is a TXT
let currentRun = 0;         // incremented on each upload so a stale calculation can stop itself
let waypointLabelHandler = null;
let legViews = [];          // per leg: { row, corridor } used by the clickable table rows
let selectedLeg = null;
const routeSummary = document.getElementById('routeSummary');
const globalTileCache = new Map();   // tile key -> RGBA pixel data (Uint8ClampedArray)
const pendingTiles = new Map();      // tile key -> Promise of a tile being fetched

const messagePanel = document.getElementById('messagePanel');
const MESSAGE_CLASSES = {
    error: ['border-red-500/50', 'bg-red-500/10'],
    warning: ['border-dtc-orange/50', 'bg-dtc-orange/10']
};

function showMessage(text, kind) {
    hideMessage();
    messagePanel.textContent = text;
    messagePanel.classList.add(...MESSAGE_CLASSES[kind]);
    messagePanel.classList.remove('hidden');
}

function hideMessage() {
    messagePanel.classList.add('hidden');
    Object.values(MESSAGE_CLASSES).forEach((classes) => messagePanel.classList.remove(...classes));
}

// File Upload Handler
fileInput.addEventListener('change', handleFileUpload);

async function handleFileUpload(e) {
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

    // A new upload invalidates whatever was loaded or still being calculated
    const run = ++currentRun;
    currentTxt = null;
    exportBtn.classList.add('hidden');
    hideMessage();

    try {
        const route = await readRouteFile(file);
        if (run !== currentRun) return;
        if (route.txt) currentTxt = { ...route.txt, amsByLeg: [] };
        await processRoute(route);
    } catch (err) {
        if (run !== currentRun) return;
        if (!(err instanceof CalcAms.RouteError)) console.error(err);
        showMessage(err instanceof CalcAms.RouteError
            ? err.message
            : 'Não foi possível processar o arquivo. Tente novamente ou verifique o formato.', 'error');
        loadingSpinner.classList.add('hidden');
        infoPanel.classList.remove('loading');
        elevationValue.textContent = '-- ft';
    }
}

// Reads a GPX/KML/TXT file into { waypoints, path, legs } (see CalcAms.extractRoute / parseTxtRoute)
async function readRouteFile(file) {
    const extension = (file.name.match(/\.([^.]+)$/) || [])[1];
    const buffer = await file.arrayBuffer();

    if (extension && extension.toLowerCase() === 'txt') {
        const parsed = CalcAms.parseTxtRoute(CalcAms.bytesToBinaryString(new Uint8Array(buffer)));
        return {
            waypoints: parsed.waypoints,
            path: parsed.waypoints.map((w) => w.coord),
            legs: parsed.legs,
            txt: { parsed, filename: file.name }
        };
    }

    const kind = extension ? extension.toLowerCase() : '';
    if (kind !== 'gpx' && kind !== 'kml') {
        throw new CalcAms.RouteError('Formato não suportado. Use um arquivo GPX, KML ou TXT.');
    }
    const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(buffer), 'text/xml');
    if (doc.querySelector('parsererror')) {
        throw new CalcAms.RouteError(`O arquivo ${kind.toUpperCase()} não é um XML válido.`);
    }
    const route = CalcAms.extractRoute(kind === 'gpx' ? toGeoJSON.gpx(doc) : toGeoJSON.kml(doc));
    return {
        waypoints: route.waypoints,
        path: route.path,
        legs: route.waypoints.slice(0, -1).map((w, i) => ({
            a: w.coord, b: route.waypoints[i + 1].coord, fromIndex: i, toIndex: i + 1, nivelLineIndex: null
        }))
    };
}

// Load a single Terrain Tile image and read its pixels (null when it fails to load)
function loadTileImage(z, x, y) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            resolve(ctx.getImageData(0, 0, 256, 256).data);
        };
        img.onerror = () => resolve(null);
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
    });
}

// Cached tile pixels; a failed download is retried once and never cached
function loadTileData(z, x, y) {
    const key = CalcAms.tileKey(z, x, y);
    if (globalTileCache.has(key)) return Promise.resolve(globalTileCache.get(key));
    if (pendingTiles.has(key)) return pendingTiles.get(key);

    const request = (async () => {
        let data = await loadTileImage(z, x, y);
        if (!data) data = await loadTileImage(z, x, y);
        if (data) globalTileCache.set(key, data);
        return data;
    })().finally(() => pendingTiles.delete(key));
    pendingTiles.set(key, request);
    return request;
}

const CORRIDOR_STYLE = { color: '#3b82f6', weight: 1, fillOpacity: 0.1, dashArray: '5, 5' };
const CORRIDOR_SELECTED_STYLE = { color: '#22c55e', weight: 2, fillOpacity: 0.25, dashArray: null };

function legNames(route, leg) {
    const from = route.waypoints[leg.fromIndex].name;
    const to = route.waypoints[leg.toIndex].name;
    return from || to ? `${from || '?'} ➔ ${to || '?'}` : '';
}

function addLegRow(route, leg, summary) {
    const row = document.createElement('tr');
    const label = `WP ${leg.fromIndex + 1} ➔ WP ${leg.toIndex + 1}`;
    const names = legNames(route, leg);
    const nameLine = names ? `<div class="leg-names"></div>` : '';
    const range = summary
        ? `<td class="ams-highlight">${summary.ams}</td>
            <td class="height-range-cell">
                <div class="height-max">${summary.maxFt}</div>
                <div class="height-min">${summary.minFt}</div>
            </td>
            <td>${summary.deltaFt}</td>`
        : `<td class="ams-highlight">--</td>
            <td class="height-range-cell" colspan="2">sem dados de terreno</td>`;
    row.innerHTML = `<td><div>${label}</div>${nameLine}</td>${range}`;
    if (names) {
        const nameEl = row.querySelector('.leg-names');
        nameEl.textContent = names;
        nameEl.title = names;
    }
    if (!summary) row.classList.add('leg-error');
    row.tabIndex = 0;
    row.classList.add('leg-row');
    legsTableBody.appendChild(row);
    return row;
}

// Highlights a leg (table row + corridor) and zooms the map to it; selecting it again returns to the whole route
function selectLeg(index, routeBounds) {
    const previous = selectedLeg;
    if (previous !== null && legViews[previous]) {
        legViews[previous].row.classList.remove('leg-selected');
        legViews[previous].corridor.setStyle(CORRIDOR_STYLE);
    }
    if (index === previous || !legViews[index]) {
        selectedLeg = null;
        map.fitBounds(routeBounds, { padding: [50, 50] });
        return;
    }
    selectedLeg = index;
    const view = legViews[index];
    view.row.classList.add('leg-selected');
    view.corridor.setStyle(CORRIDOR_SELECTED_STYLE);
    view.corridor.bringToFront();
    map.fitBounds(view.corridor.getBounds(), { padding: [40, 40] });
}

function renderRouteSummary(route, amsByLeg) {
    const range = CalcAms.routeAmsRange(amsByLeg);
    routeSummary.replaceChildren();
    if (!range) {
        routeSummary.classList.add('hidden');
        return;
    }
    [['Maior AMS da rota', range.max], ['Menor AMS da rota', range.min]].forEach(([title, item]) => {
        const leg = route.legs[item.index];
        const block = document.createElement('div');
        block.className = 'summary-item';
        const caption = document.createElement('span');
        caption.className = 'summary-caption';
        caption.textContent = title;
        const value = document.createElement('span');
        value.className = 'summary-value';
        value.textContent = `${item.ams} ft`;
        const where = document.createElement('span');
        where.className = 'summary-where';
        where.textContent = `WP ${leg.fromIndex + 1} ➔ WP ${leg.toIndex + 1}`;
        block.append(caption, value, where);
        routeSummary.appendChild(block);
    });
    routeSummary.classList.remove('hidden');
}

function addPeakMarker(legNumber, summary) {
    if (!summary.peak) return;
    const peakIcon = L.divIcon({
        className: 'peak-marker',
        html: `<div style="background-color: #ef4444; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #ffffff; box-shadow: 0 0 8px #ef4444; cursor: pointer;"></div>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5]
    });
    L.marker([summary.peak.lat, summary.peak.lng], { icon: peakIcon })
        .bindTooltip(`Trecho ${legNumber} - pico: ${summary.maxFt} ft`, {
            direction: 'top',
            className: 'peak-tooltip'
        })
        .addTo(routeLayers);
}

// Core processing flow: draws the route and computes the AMS of each leg
async function processRoute(route) {
    const run = currentRun;
    const isStale = () => run !== currentRun;
    const coordinates = route.waypoints.map((w) => w.coord);

    routeLayers.clearLayers();
    legsTableBody.innerHTML = '';
    legViews = [];
    selectedLeg = null;
    routeSummary.classList.add('hidden');
    resultsSection.classList.remove('hidden');

    // Show overall loader
    loadingSpinner.classList.remove('hidden');
    infoPanel.classList.add('loading');
    elevationValue.textContent = 'Calculando...';

    // Draw full route line on the map (dense path when the file has one)
    const routeLayer = L.geoJSON(turf.lineString(route.path.map((c) => [c[0], c[1]])), {
        style: { color: '#60a5fa', weight: 4, opacity: 0.8 }
    }).addTo(routeLayers);

    // Zoom map to the route
    const routeBounds = routeLayer.getBounds();
    map.fitBounds(routeBounds, { padding: [50, 50] });

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

            // Hover tooltip with the waypoint names (built with textContent: names come from the file)
            const named = wp.indices.filter((idx) => route.waypoints[idx - 1].name);
            if (named.length > 0) {
                const tip = document.createElement('div');
                named.forEach((idx) => {
                    const line = document.createElement('div');
                    line.textContent = `${idx}. ${route.waypoints[idx - 1].name}`;
                    tip.appendChild(line);
                });
                marker.bindTooltip(tip, { direction: 'top', offset: [0, -10], className: 'wp-tooltip' });
            }

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

    // Re-group labels on zoom changes (replacing the handler of any previous route)
    if (waypointLabelHandler) map.off('zoomend', waypointLabelHandler);
    waypointLabelHandler = updateWaypointLabels;
    map.on('zoomend', waypointLabelHandler);

    const amsByLeg = [];
    let failedLegs = 0;

    for (let i = 0; i < route.legs.length; i++) {
        const leg = route.legs[i];
        elevationValue.textContent = `Calculando ${i + 1}/${route.legs.length}`;

        const corridor = turf.buffer(turf.lineString([leg.a, leg.b]), CalcAms.CRITERIA.corridorMeters / 1000, { units: 'kilometers' });
        const corridorLayer = L.geoJSON(corridor, { style: CORRIDOR_STYLE }).addTo(routeLayers);

        const tiles = new Map();
        await Promise.all(CalcAms.legCorridorTiles(leg.a, leg.b).map(async ({ z, x, y, key }) => {
            tiles.set(key, await loadTileData(z, x, y));
        }));
        if (isStale()) return;

        const analysis = CalcAms.analyzeLeg(leg.a, leg.b, tiles);
        let summary = null;
        try {
            summary = CalcAms.summarizeLeg(analysis);
        } catch (err) {
            if (!(err instanceof CalcAms.RouteError)) throw err;
            failedLegs++;
        }

        amsByLeg[i] = summary ? summary.ams : null;
        if (summary) addPeakMarker(i + 1, summary);
        const row = addLegRow(route, leg, summary);
        legViews[i] = { row, corridor: corridorLayer };
        const select = () => selectLeg(i, routeBounds);
        row.addEventListener('click', select);
        row.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                select();
            }
        });
    }

    loadingSpinner.classList.add('hidden');
    infoPanel.classList.remove('loading');
    elevationValue.textContent = '-- ft';

    renderRouteSummary(route, amsByLeg);

    if (failedLegs > 0) {
        showMessage(
            `${failedLegs} trecho(s) ficaram sem AMS porque os dados de terreno não carregaram. ` +
            'Verifique a conexão e carregue o arquivo novamente. A exportação foi bloqueada.', 'error');
        return;
    }

    if (currentTxt) {
        currentTxt.amsByLeg = amsByLeg;
        const withoutField = route.legs.filter((leg) => leg.nivelLineIndex === null).length;
        if (withoutField > 0) {
            showMessage(`${withoutField} perna(s) do TXT não têm o campo Castelo.NivelMinimoIFR e não serão atualizadas na exportação.`, 'warning');
        }
        exportBtn.classList.remove('hidden');
    }
}

// Export Calculated Route TXT (same bytes as the original, with the AMS lines updated)
exportBtn.addEventListener('click', () => {
    if (!currentTxt) return;

    const { parsed, filename, amsByLeg } = currentTxt;
    const bytes = CalcAms.binaryStringToBytes(CalcAms.applyAmsToTxt(parsed, amsByLeg));
    const blob = new Blob([bytes], { type: 'text/plain' });

    // Create download link
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Calculated_${filename}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
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

    // Keep the progress text visible while a route is being calculated
    if (!loadingSpinner.classList.contains('hidden')) return;

    const zoom = CalcAms.CRITERIA.terrainZoom;
    const tx = CalcAms.lonToTileX(lng, zoom);
    const ty = CalcAms.latToTileY(lat, zoom);

    let tileData = globalTileCache.get(CalcAms.tileKey(zoom, tx, ty));
    if (!tileData) {
        // Fetch tile on the fly if not cached
        elevationValue.textContent = '... ft';
        tileData = await loadTileData(zoom, tx, ty);
        if (!tileData) {
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
    const r = tileData[idx];
    const g = tileData[idx + 1];
    const b = tileData[idx + 2];

    const elevM = (r * 256 + g + b / 256) - 32768;
    const elevFt = Math.round(elevM * 3.28084);

    elevationValue.textContent = `${elevFt} ft`;
}, 50));
