// Lógica pura do CALCAMS (sem DOM, mapa ou rede): leitura de rotas, critérios da AMS
// e cálculo sobre tiles de elevação. Carregado no navegador (window.CalcAms) e nos testes (Node).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CalcAms = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---- Critérios da AMS (Altitude Mínima de Segurança) ----
    const CRITERIA = Object.freeze({
        corridorMeters: 18520,        // 10 NM para cada lado do eixo do trecho
        terrainZoom: 10,              // zoom dos tiles Terrarium
        sampleStep: 1,                // 1 = lê todos os pixels do tile dentro do corredor
        marginFt: 1000,               // folga sobre o ponto mais alto
        marginHighReliefFt: 2000,     // folga quando o relevo do corredor é alto
        highReliefThresholdFt: 1000,  // relevo (máx - mín) acima do qual vale a folga maior
        roundUpToFt: 100              // AMS arredondada para cima em múltiplos de 100 ft
    });

    const M_TO_FT = 3.28084;
    const METERS_PER_DEG_LAT = 111320;
    const EARTH_RADIUS_M = 6371008.8;
    const TILE_SIZE = 256;
    const MIN_WAYPOINT_SPACING_M = 10; // pontos mais próximos que isso são considerados duplicados
    const MAX_LEGS = 300;              // limite de trechos quando a rota vem só de uma linha

    class RouteError extends Error {
        constructor(message) {
            super(message);
            this.name = 'RouteError';
        }
    }

    // ---- Geometria básica ----
    const toRad = (deg) => deg * Math.PI / 180;

    // a e b em [lon, lat]
    function distanceMeters(a, b) {
        const dLat = toRad(b[1] - a[1]);
        const dLon = toRad(b[0] - a[0]);
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
        return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    // Remove pontos consecutivos a menos de MIN_WAYPOINT_SPACING_M do último mantido.
    function dedupeAdjacent(items, getCoord) {
        const kept = [];
        items.forEach((item) => {
            const last = kept[kept.length - 1];
            if (!last || distanceMeters(getCoord(last), getCoord(item)) > MIN_WAYPOINT_SPACING_M) {
                kept.push(item);
            }
        });
        return kept;
    }

    const lonLat = (coord) => [coord[0], coord[1]];

    // ---- Rotas GPX / KML (a partir do GeoJSON do togeojson) ----
    function collectGeometries(geometry, out) {
        if (!geometry) return;
        switch (geometry.type) {
            case 'Point':
                out.points.push(geometry.coordinates);
                break;
            case 'LineString':
                out.lines.push(geometry.coordinates);
                break;
            case 'MultiLineString':
                geometry.coordinates.forEach((line) => out.lines.push(line));
                break;
            case 'GeometryCollection':
                geometry.geometries.forEach((g) => collectGeometries(g, out));
                break;
            default:
                break;
        }
    }

    function describeFeatures(geojson) {
        const points = [];
        const lines = [];
        const features = geojson && Array.isArray(geojson.features) ? geojson.features : [];
        features.forEach((feature) => {
            const props = feature.properties || {};
            const found = { points: [], lines: [] };
            collectGeometries(feature.geometry, found);
            found.points.forEach((coord) => {
                points.push({ name: String(props.name || '').trim(), style: String(props.styleUrl || ''), coord: lonLat(coord) });
            });
            found.lines.forEach((coords) => {
                lines.push({ type: props._gpxType || '', coords: coords.map(lonLat) });
            });
        });
        return { points, lines };
    }

    // Waypoints de um KML/GPX: prefere o estilo "EstiloWpt"; senão qualquer ponto nomeado
    // (ignorando "#", usado para marcar mudanças de perna); senão todos os pontos.
    function pickWaypointPoints(points) {
        const byStyle = points.filter((p) => /EstiloWpt$/.test(p.style));
        if (byStyle.length >= 2) return byStyle;
        const named = points.filter((p) => p.name && p.name !== '#');
        if (named.length >= 2) return named;
        return points;
    }

    // Devolve { waypoints: [{name, coord}], path: [[lon, lat], ...], source }.
    // `waypoints` define os trechos; `path` é só o traçado a desenhar no mapa.
    function extractRoute(geojson) {
        const { points, lines } = describeFeatures(geojson);

        const gpxRoutes = lines.filter((l) => l.type === 'rte');
        if (gpxRoutes.length > 0) {
            const coords = [].concat(...gpxRoutes.map((l) => l.coords));
            const waypoints = dedupeAdjacent(coords.map((coord) => ({ name: '', coord })), (w) => w.coord);
            return finishRoute(waypoints, waypoints.map((w) => w.coord), 'rota');
        }

        const pointWaypoints = dedupeAdjacent(pickWaypointPoints(points), (p) => p.coord)
            .map((p) => ({ name: p.name, coord: p.coord }));
        if (pointWaypoints.length >= 2) {
            const drawn = lines.length > 0
                ? lines.reduce((longest, l) => (l.coords.length > longest.coords.length ? l : longest)).coords
                : pointWaypoints.map((w) => w.coord);
            return finishRoute(pointWaypoints, drawn, 'waypoints');
        }

        if (lines.length > 0) {
            const tracks = lines.filter((l) => l.type === 'trk');
            const chosen = tracks.length > 0 ? tracks : lines;
            const coords = [].concat(...chosen.map((l) => l.coords));
            const waypoints = dedupeAdjacent(coords.map((coord) => ({ name: '', coord })), (w) => w.coord);
            if (waypoints.length > MAX_LEGS) {
                throw new RouteError(
                    `O arquivo tem uma linha com ${waypoints.length} pontos e nenhum waypoint nomeado. ` +
                    'Exporte a rota com os waypoints (um ponto por fim de trecho).');
            }
            return finishRoute(waypoints, waypoints.map((w) => w.coord), 'linha');
        }

        throw new RouteError('Nenhuma rota encontrada no arquivo. Verifique se é um GPX ou KML válido.');
    }

    function finishRoute(waypoints, path, source) {
        if (waypoints.length < 2) {
            throw new RouteError('A rota precisa de pelo menos 2 waypoints.');
        }
        return { waypoints, path, source };
    }

    // ---- Rota TXT (formato do software de navegação) ----
    // O arquivo é tratado como "texto binário": 1 caractere = 1 byte. Assim a leitura e a
    // gravação preservam byte a byte a codificação original (Windows-1252, UTF-8 etc.),
    // incluindo os finais de linha CRLF.
    function bytesToBinaryString(bytes) {
        let out = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return out;
    }

    function binaryStringToBytes(text) {
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
        return bytes;
    }

    const NIVEL_MINIMO_KEY = 'Castelo.NivelMinimoIFR';

    function parseTxtRoute(text) {
        const lines = text.split('\n'); // mantém o '\r' no fim de cada linha CRLF
        const waypoints = [];
        const legs = [];
        const headers = [];
        let current = null;

        const flush = () => {
            if (!current) return;
            const { first, gateIn, gateOut } = current;
            if (current.type === 'NavWaypoint') {
                if (!Number.isFinite(first.lat) || !Number.isFinite(first.lon)) {
                    throw new RouteError(`O waypoint "${current.name}" não tem posição válida no arquivo TXT.`);
                }
                waypoints.push({ name: current.name, coord: [first.lon, first.lat] });
            } else if (current.type === 'NavPerna') {
                if (![gateIn.lat, gateIn.lon, gateOut.lat, gateOut.lon].every(Number.isFinite)) {
                    throw new RouteError(`A perna "${current.name}" não tem GateIn/GateOut válidos no arquivo TXT.`);
                }
                legs.push({
                    name: current.name,
                    a: [gateIn.lon, gateIn.lat],
                    b: [gateOut.lon, gateOut.lat],
                    nivelLineIndex: current.nivelLineIndex
                });
            }
        };

        lines.forEach((line, index) => {
            const trimmed = line.trim();
            if (!trimmed) return;

            const objMatch = trimmed.match(/^IObjeto\s*-\s*(.*)$/);
            if (objMatch) {
                flush();
                current = {
                    name: objMatch[1], type: null, nivelLineIndex: null,
                    first: {}, gateIn: {}, gateOut: {}
                };
                headers.length = 0;
                return;
            }
            if (!current) return;

            const depth = line.match(/^\t*/)[0].length;
            const eq = trimmed.indexOf('=');
            if (eq === -1) {
                headers.length = depth;
                headers[depth] = trimmed;
                return;
            }

            const key = trimmed.slice(0, eq).trim();
            const value = trimmed.slice(eq + 1).trim();
            const path = headers.slice(0, depth).filter(Boolean).join('.');
            const fullKey = path ? `${path}.${key}` : key;

            if (key === 'Tipo' && current.type === null) {
                current.type = value;
                return;
            }
            const axis = fullKey.endsWith('Posicao.Lat') ? 'lat' : fullKey.endsWith('Posicao.Lon') ? 'lon' : null;
            if (axis) {
                const number = parseFloat(value.replace(',', '.'));
                if (current.first[axis] === undefined) current.first[axis] = number;
                const gate = fullKey.includes('GateOut.') ? current.gateOut
                    : fullKey.includes('GateIn.') ? current.gateIn : null;
                if (gate && gate[axis] === undefined) gate[axis] = number;
            } else if (fullKey.endsWith(NIVEL_MINIMO_KEY)) {
                current.nivelLineIndex = index;
            }
        });
        flush();

        if (waypoints.length < 2) {
            throw new RouteError('O arquivo TXT precisa conter pelo menos 2 waypoints (NavWaypoint).');
        }
        if (legs.length === 0) {
            // Sem pernas no arquivo: usa pares consecutivos de waypoints (não há onde gravar a AMS).
            for (let i = 0; i < waypoints.length - 1; i++) {
                legs.push({ name: `Trecho ${i + 1}`, a: waypoints[i].coord, b: waypoints[i + 1].coord, nivelLineIndex: null });
            }
        }

        // Associa cada perna aos waypoints de origem/destino pela posição (não pela ordem no arquivo).
        const nearest = (coord) => waypoints.reduce((best, w, i) => {
            const d = distanceMeters(coord, w.coord);
            return d < best.d ? { i, d } : best;
        }, { i: 0, d: Infinity }).i;
        legs.forEach((leg) => {
            leg.fromIndex = nearest(leg.a);
            leg.toIndex = nearest(leg.b);
        });

        return { lines, waypoints, legs };
    }

    // Grava a AMS calculada em cada perna. `amsByLeg[i]` null/undefined mantém o valor original.
    function applyAmsToTxt(parsed, amsByLeg) {
        const lines = parsed.lines.slice();
        parsed.legs.forEach((leg, i) => {
            const ams = amsByLeg[i];
            if (leg.nivelLineIndex === null || ams === null || ams === undefined) return;
            lines[leg.nivelLineIndex] = lines[leg.nivelLineIndex].replace(/(=\s*)[^\r]*(\r?)$/, `$1${ams}$2`);
        });
        return lines.join('\n');
    }

    // ---- Tiles de elevação (Terrarium) ----
    const lonToTileX = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
    const latToTileY = (lat, z) => Math.floor(
        (1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) / 2 * 2 ** z);
    const tileXToLon = (x, z) => x / 2 ** z * 360 - 180;
    const tileYToLat = (y, z) => {
        const n = Math.PI - 2 * Math.PI * y / 2 ** z;
        return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
    };
    const tileKey = (z, x, y) => `${z},${x},${y}`;

    // Tiles que cobrem o corredor do trecho a→b.
    function legCorridorTiles(a, b) {
        const z = CRITERIA.terrainZoom;
        const maxTile = 2 ** z - 1;
        const latPad = CRITERIA.corridorMeters / METERS_PER_DEG_LAT;
        const widestLat = Math.max(Math.abs(a[1]), Math.abs(b[1])) + latPad;
        const lonPad = CRITERIA.corridorMeters / (METERS_PER_DEG_LAT * Math.cos(toRad(Math.min(widestLat, 85))));
        const clamp = (v) => Math.max(0, Math.min(maxTile, v));
        const minX = clamp(lonToTileX(Math.min(a[0], b[0]) - lonPad, z));
        const maxX = clamp(lonToTileX(Math.max(a[0], b[0]) + lonPad, z));
        const minY = clamp(latToTileY(Math.min(85, Math.max(a[1], b[1]) + latPad), z));
        const maxY = clamp(latToTileY(Math.max(-85, Math.min(a[1], b[1]) - latPad), z));
        const tiles = [];
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) tiles.push({ z, x, y, key: tileKey(z, x, y) });
        }
        return tiles;
    }

    // Lê todos os pixels do corredor (distância ao eixo <= corridorMeters) e devolve os extremos
    // de elevação em pés. `tiles`: Map(chave do tile -> dados RGBA 256x256 | null).
    function analyzeLeg(a, b, tiles) {
        const z = CRITERIA.terrainZoom;
        const step = Math.max(1, CRITERIA.sampleStep);
        const kx = METERS_PER_DEG_LAT * Math.cos(toRad((a[1] + b[1]) / 2));
        const bx = (b[0] - a[0]) * kx;
        const by = (b[1] - a[1]) * METERS_PER_DEG_LAT;
        const len2 = bx * bx + by * by;
        const radius2 = CRITERIA.corridorMeters ** 2;

        let maxFt = -Infinity;
        let minFt = Infinity;
        let peak = null;
        let samples = 0;
        const missingTiles = [];

        legCorridorTiles(a, b).forEach(({ x: tx, y: ty, key }) => {
            const data = tiles.get(key);
            if (!data) {
                missingTiles.push(key);
                return;
            }
            const xs = [];
            const lons = [];
            for (let px = 0; px < TILE_SIZE; px += step) {
                const lon = tileXToLon(tx + (px + 0.5) / TILE_SIZE, z);
                lons.push(lon);
                xs.push((lon - a[0]) * kx);
            }
            for (let py = 0; py < TILE_SIZE; py += step) {
                const lat = tileYToLat(ty + (py + 0.5) / TILE_SIZE, z);
                const y = (lat - a[1]) * METERS_PER_DEG_LAT;
                for (let i = 0; i < xs.length; i++) {
                    const x = xs[i];
                    const t = len2 > 0 ? Math.max(0, Math.min(1, (x * bx + y * by) / len2)) : 0;
                    const dx = x - t * bx;
                    const dy = y - t * by;
                    if (dx * dx + dy * dy > radius2) continue;

                    const idx = (py * TILE_SIZE + i * step) * 4;
                    const elevM = data[idx] * 256 + data[idx + 1] + data[idx + 2] / 256 - 32768;
                    const elevFt = elevM * M_TO_FT;
                    samples++;
                    if (elevFt > maxFt) {
                        maxFt = elevFt;
                        peak = { lat, lng: lons[i] };
                    }
                    if (elevFt < minFt) minFt = elevFt;
                }
            }
        });

        return { maxFt, minFt, peak, samples, missingTiles };
    }

    // AMS (ft) a partir do ponto mais alto e do relevo do corredor.
    function computeAms(maxFt, minFt) {
        const relief = maxFt - minFt;
        const margin = relief > CRITERIA.highReliefThresholdFt ? CRITERIA.marginHighReliefFt : CRITERIA.marginFt;
        return Math.ceil((maxFt + margin) / CRITERIA.roundUpToFt) * CRITERIA.roundUpToFt;
    }

    // Resultado de um trecho pronto para exibir. Lança RouteError se faltarem dados de terreno.
    function summarizeLeg(analysis) {
        if (analysis.missingTiles.length > 0) {
            throw new RouteError(`Faltam ${analysis.missingTiles.length} tile(s) de terreno deste trecho.`);
        }
        if (analysis.samples === 0) {
            throw new RouteError('Nenhum dado de terreno dentro do corredor deste trecho.');
        }
        return {
            ams: computeAms(analysis.maxFt, analysis.minFt),
            maxFt: Math.max(0, Math.round(analysis.maxFt)),
            minFt: Math.max(0, Math.round(analysis.minFt)),
            deltaFt: Math.max(0, Math.round(analysis.maxFt - analysis.minFt)),
            peak: analysis.peak
        };
    }

    return {
        CRITERIA, RouteError,
        distanceMeters, extractRoute,
        bytesToBinaryString, binaryStringToBytes, parseTxtRoute, applyAmsToTxt,
        lonToTileX, latToTileY, tileXToLon, tileYToLat, tileKey,
        legCorridorTiles, analyzeLeg, computeAms, summarizeLeg
    };
});
