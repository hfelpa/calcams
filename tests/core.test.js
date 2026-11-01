'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

// ---- Rota fictícia usada nos testes (nenhum arquivo de rota real no repositório) ----
const WAYPOINTS = [
    { name: 'PONTO ALFA', lat: -15.0, lon: -47.0 },
    { name: 'PONTO BRAVO', lat: -15.5, lon: -47.6 },
    { name: 'CAMPO CHARLIE', lat: -16.1, lon: -48.0 },
    { name: 'PONTO DELTA', lat: -16.4, lon: -48.7 }
];
const LEG_LEVELS = [3600, 3400, 3300];

function gpxXml() {
    const wpt = WAYPOINTS.map((w) => `<wpt lat="${w.lat}" lon="${w.lon}"><name>${w.name}</name></wpt>`).join('\n');
    const rtept = WAYPOINTS.map((w) => `<rtept lat="${w.lat}" lon="${w.lon}"><name>${w.name}</name></rtept>`).join('\n');
    return `<gpx version="1.1">\n${wpt}\n<rte><name>ROTA TESTE</name>\n${rtept}\n</rte></gpx>`;
}

// KML no estilo do software de origem: linha densificada + pontos nomeados + pontos auxiliares.
function kmlXml() {
    const dense = [];
    for (let i = 0; i < WAYPOINTS.length - 1; i++) {
        for (let s = 0; s < 500; s++) {
            const f = s / 500;
            dense.push(`${WAYPOINTS[i].lon + (WAYPOINTS[i + 1].lon - WAYPOINTS[i].lon) * f},${WAYPOINTS[i].lat + (WAYPOINTS[i + 1].lat - WAYPOINTS[i].lat) * f},1000`);
        }
    }
    const point = (name, style, lon, lat) =>
        `<Placemark><name>${name}</name><styleUrl>${style}</styleUrl><Point><coordinates>${lon},${lat},1000</coordinates></Point></Placemark>`;
    return `<kml><Document>
<Placemark><name>ROTA TESTE</name><styleUrl>#EstiloRota</styleUrl><LineString><coordinates>
${dense.join('\n')}
</coordinates></LineString></Placemark>
${point(WAYPOINTS[0].name, '#EstiloWpt', WAYPOINTS[0].lon, WAYPOINTS[0].lat)}
${point('#', '#EstiloPSPNPD', -47.3, -15.25)}
${WAYPOINTS.slice(1).map((w) => point(w.name, '#EstiloWpt', w.lon, w.lat)).join('\n')}
${point('Referência', '#EstiloPtRef', -47.1, -15.1)}
</Document></kml>`;
}

// Texto do formato TXT como "texto binário" (1 caractere = 1 byte, CRLF, acento em Windows-1252).
function txtBinary() {
    const t = (depth, text) => `${'\t'.repeat(depth)}${text}`;
    const gate = (depth, name, lat, lon) => [t(depth, name), t(depth + 1, `Posicao.Lat = ${lat}`), t(depth + 1, `Posicao.Lon = ${lon}`)];
    const lines = [
        'IObjeto - ROTA TESTE',
        t(1, 'DadosComuns'), t(2, 'Tipo = NavRota'),
        t(1, 'DadosEspecificos'), t(2, 'IObjetoNav'), ...gate(3, 'GateIn', 0, 0)
    ];
    const legNames = ['Perna 8', 'Perna 2', 'Perna 5']; // fora de ordem de propósito
    WAYPOINTS.forEach((w, i) => {
        lines.push(
            t(2, `IObjeto - ${w.name}`),
            t(3, 'DadosComuns'), t(4, 'Tipo = NavWaypoint'),
            t(3, 'DadosEspecificos'), t(4, 'IObjetoNav'), ...gate(5, 'GateIn', w.lat, w.lon));
        if (i < WAYPOINTS.length - 1) {
            const next = WAYPOINTS[i + 1];
            lines.push(
                t(2, `IObjeto - ${legNames[i]}`),
                t(3, 'DadosComuns'), t(4, 'Tipo = NavPerna'),
                t(3, 'DadosEspecificos'), t(4, 'IObjetoNav'),
                ...gate(5, 'GateIn', w.lat, w.lon), ...gate(5, 'GateOut', next.lat, next.lon),
                t(4, 'Castelo.Tipo = G'),
                t(4, `Castelo.NivelMinimoIFR = ${LEG_LEVELS[i]}`),
                t(4, 'NomeReferencia = Refer\xeancia'));
        }
    });
    return lines.join('\r\n') + '\r\n';
}

// Converte KML/GPX em GeoJSON no mesmo formato que o togeojson entrega ao app
// (só o necessário para estes testes; o parser real roda no navegador).
function kmlToGeojson(xml) {
    const features = [];
    for (const m of xml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
        const body = m[1];
        const name = (body.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '';
        const styleUrl = (body.match(/<styleUrl>([\s\S]*?)<\/styleUrl>/) || [])[1] || '';
        const coords = (body.match(/<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1] || '';
        const list = coords.trim().split(/\s+/).map((c) => c.split(',').map(Number));
        const geometry = body.includes('<LineString')
            ? { type: 'LineString', coordinates: list }
            : { type: 'Point', coordinates: list[0] };
        features.push({ type: 'Feature', properties: { name, styleUrl }, geometry });
    }
    return { type: 'FeatureCollection', features };
}

function gpxToGeojson(xml, withNames = false) {
    const pts = (block, tag) => [...block.matchAll(new RegExp(`<${tag} lat="([^"]+)" lon="([^"]+)"`, 'g'))]
        .map((m) => [Number(m[2]), Number(m[1])]);
    const names = (block) => [...block.matchAll(/<wpt [^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((m) => m[1].trim());
    const wptNames = names(xml.replace(/<rte>[\s\S]*?<\/rte>/, ''));
    const features = [];
    const rte = xml.match(/<rte>([\s\S]*?)<\/rte>/);
    if (rte) {
        features.push({ type: 'Feature', properties: { _gpxType: 'rte' }, geometry: { type: 'LineString', coordinates: pts(rte[1], 'rtept') } });
    }
    pts(xml.replace(/<rte>[\s\S]*?<\/rte>/, ''), 'wpt').forEach((c, i) => {
        features.push({ type: 'Feature', properties: { name: withNames ? wptNames[i] : '' }, geometry: { type: 'Point', coordinates: c } });
    });
    return { type: 'FeatureCollection', features };
}

// ---- GPX / KML ----
test('GPX: usa os pontos da rota', () => {
    const route = core.extractRoute(gpxToGeojson(gpxXml()));
    assert.equal(route.waypoints.length, WAYPOINTS.length);
    assert.equal(route.source, 'rota');
});

test('KML: usa os waypoints nomeados e não os vértices da linha', () => {
    const route = core.extractRoute(kmlToGeojson(kmlXml()));
    assert.equal(route.waypoints.length, WAYPOINTS.length);
    assert.equal(route.source, 'waypoints');
    assert.equal(route.waypoints[0].name, 'PONTO ALFA');
    assert.equal(route.waypoints[3].name, 'PONTO DELTA');
    assert.ok(route.waypoints.every((w) => w.name !== '#' && w.name !== 'Referência'));
    assert.ok(route.path.length > 1000, 'a linha densa continua disponível para desenhar');
});

test('GPX: nomes dos pontos da rota vêm dos waypoints na mesma posição', () => {
    const route = core.extractRoute(gpxToGeojson(gpxXml(), true));
    assert.deepEqual(route.waypoints.map((w) => w.name), WAYPOINTS.map((w) => w.name));
});

test('GPX: sem waypoints nomeados por perto, o nome fica vazio', () => {
    const route = core.extractRoute(gpxToGeojson(gpxXml()));
    assert.ok(route.waypoints.every((w) => w.name === ''));
});

test('KML e GPX descrevem os mesmos waypoints', () => {
    const kml = core.extractRoute(kmlToGeojson(kmlXml()));
    const gpx = core.extractRoute(gpxToGeojson(gpxXml()));
    kml.waypoints.forEach((w, i) => assert.ok(core.distanceMeters(w.coord, gpx.waypoints[i].coord) < 5, `waypoint ${i}`));
});

test('linha sem waypoints e com milhares de pontos é recusada com mensagem clara', () => {
    const coordinates = Array.from({ length: 2000 }, (_, i) => [-50 + i * 0.01, -17]);
    const geojson = { features: [{ properties: {}, geometry: { type: 'LineString', coordinates } }] };
    assert.throws(() => core.extractRoute(geojson), core.RouteError);
});

test('arquivo sem rota lança RouteError', () => {
    assert.throws(() => core.extractRoute({ features: [] }), core.RouteError);
});

// ---- TXT ----
test('TXT: lê waypoints e pernas com o campo da AMS', () => {
    const parsed = core.parseTxtRoute(txtBinary());
    assert.equal(parsed.waypoints.length, WAYPOINTS.length);
    assert.equal(parsed.legs.length, WAYPOINTS.length - 1);
    assert.ok(parsed.legs.every((leg) => leg.nivelLineIndex !== null));
    parsed.legs.forEach((leg, i) => {
        assert.equal(leg.fromIndex, i, `origem da perna ${i}`);
        assert.equal(leg.toIndex, i + 1, `destino da perna ${i}`);
    });
});

test('TXT: sem alterações, a gravação devolve exatamente os mesmos bytes', () => {
    const text = txtBinary();
    const out = core.binaryStringToBytes(core.applyAmsToTxt(core.parseTxtRoute(text), []));
    assert.deepEqual(Buffer.from(out), Buffer.from(text, 'latin1'));
});

test('TXT: grava só as linhas da AMS e preserva CRLF e acentos', () => {
    const text = txtBinary();
    const parsed = core.parseTxtRoute(text);
    const ams = parsed.legs.map((_, i) => 1000 + i * 100);
    const out = Buffer.from(core.binaryStringToBytes(core.applyAmsToTxt(parsed, ams)));

    const before = text.split('\n');
    const after = out.toString('latin1').split('\n');
    assert.equal(after.length, before.length);
    assert.ok(after.every((line, i) => line.endsWith('\r') === before[i].endsWith('\r')), 'CRLF preservado');
    const changed = after.flatMap((line, i) => (line !== before[i] ? [i] : []));
    assert.deepEqual(changed, parsed.legs.map((leg) => leg.nivelLineIndex));
    assert.match(after[parsed.legs[0].nivelLineIndex], /^\t+Castelo\.NivelMinimoIFR = 1000\r$/);
    assert.ok(out.includes(Buffer.from('Refer\xeancia', 'latin1')), 'byte 0xEA (ê em Windows-1252) preservado');
});

test('TXT: perna sem campo da AMS não é alterada', () => {
    const parsed = core.parseTxtRoute(txtBinary());
    const copy = { ...parsed, legs: parsed.legs.map((l, i) => (i === 0 ? { ...l, nivelLineIndex: null } : l)) };
    const out = core.applyAmsToTxt(copy, copy.legs.map(() => 9999)).split('\n');
    assert.ok(out[parsed.legs[0].nivelLineIndex].includes('= 3600'));
    assert.ok(out[parsed.legs[1].nivelLineIndex].includes('= 9999'));
});

test('TXT com menos de 2 waypoints lança RouteError', () => {
    assert.throws(() => core.parseTxtRoute('Objeto\r\n'), core.RouteError);
});

// ---- Cálculo da AMS ----
test('computeAms: margem de 1000 ft, 2000 ft com relevo alto, arredondada para cima', () => {
    assert.equal(core.computeAms(3000, 2500), 4000);
    assert.equal(core.computeAms(2050, 2000), 3100);
    assert.equal(core.computeAms(2000, 900), 4000);   // relevo 1100 > 1000
    assert.equal(core.computeAms(2000, 1000), 3000);  // relevo 1000 não passa do limite
});

// Tile Terrarium sintético: elevação plana em metros, com picos opcionais.
function encodeTerrarium(data, pixel, meters) {
    const v = meters + 32768;
    data[pixel * 4] = Math.floor(v / 256);
    data[pixel * 4 + 1] = Math.floor(v) % 256;
    data[pixel * 4 + 2] = Math.round((v - Math.floor(v)) * 256) % 256;
}

function flatTiles(a, b, meters) {
    const tiles = new Map();
    core.legCorridorTiles(a, b).forEach(({ key }) => {
        const data = new Uint8ClampedArray(256 * 256 * 4);
        for (let p = 0; p < 256 * 256; p++) encodeTerrarium(data, p, meters);
        tiles.set(key, data);
    });
    return tiles;
}

function setElevationAt(tiles, lon, lat, meters) {
    const z = core.CRITERIA.terrainZoom;
    const fx = (lon + 180) / 360 * 2 ** z;
    const fy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
    const data = tiles.get(core.tileKey(z, Math.floor(fx), Math.floor(fy)));
    encodeTerrarium(data, Math.floor((fy % 1) * 256) * 256 + Math.floor((fx % 1) * 256), meters);
}

const A = [-50.0, -17.0];
const B = [-50.6, -17.4];

test('analyzeLeg: terreno plano', () => {
    const r = core.analyzeLeg(A, B, flatTiles(A, B, 500));
    assert.ok(r.samples > 10000);
    assert.equal(r.missingTiles.length, 0);
    assert.ok(Math.abs(r.maxFt - 500 * 3.28084) < 0.01);
    assert.ok(Math.abs(r.minFt - 500 * 3.28084) < 0.01);
});

test('analyzeLeg: pico isolado de 1 pixel dentro do corredor é encontrado', () => {
    const tiles = flatTiles(A, B, 500);
    const mid = [(A[0] + B[0]) / 2 + 0.05, (A[1] + B[1]) / 2 + 0.05]; // ~7 km do eixo
    setElevationAt(tiles, mid[0], mid[1], 1800);
    const r = core.analyzeLeg(A, B, tiles);
    assert.ok(Math.abs(r.maxFt - 1800 * 3.28084) < 0.01);
    assert.ok(Math.abs(r.peak.lng - mid[0]) < 0.005 && Math.abs(r.peak.lat - mid[1]) < 0.005);
});

test('analyzeLeg: pico além de 10 NM do eixo é ignorado', () => {
    const tiles = flatTiles(A, B, 500);
    const corner = [A[0], B[1]]; // canto do retângulo dos tiles, ~36 km do eixo
    const covered = core.legCorridorTiles(A, B).some(({ x, y }) => (
        core.lonToTileX(corner[0], 10) === x && core.latToTileY(corner[1], 10) === y));
    assert.ok(covered, 'o ponto precisa estar num tile carregado para o teste valer');
    setElevationAt(tiles, corner[0], corner[1], 4000);
    const r = core.analyzeLeg(A, B, tiles);
    assert.ok(Math.abs(r.maxFt - 500 * 3.28084) < 0.01);
});

test('analyzeLeg: tile ausente é reportado e summarizeLeg recusa o resultado', () => {
    const tiles = flatTiles(A, B, 500);
    const [first] = core.legCorridorTiles(A, B);
    tiles.set(first.key, null);
    const r = core.analyzeLeg(A, B, tiles);
    assert.deepEqual(r.missingTiles, [first.key]);
    assert.throws(() => core.summarizeLeg(r), core.RouteError);
});

test('summarizeLeg: sem nenhuma amostra não inventa AMS', () => {
    assert.throws(() => core.summarizeLeg({ maxFt: -Infinity, minFt: Infinity, peak: null, samples: 0, missingTiles: [] }), core.RouteError);
});

test('summarizeLeg: valores de exibição', () => {
    const tiles = flatTiles(A, B, 500);
    setElevationAt(tiles, -50.3, -17.2, 1500);
    const s = core.summarizeLeg(core.analyzeLeg(A, B, tiles));
    assert.equal(s.maxFt, Math.round(1500 * 3.28084));
    assert.equal(s.minFt, Math.round(500 * 3.28084));
    assert.equal(s.deltaFt, s.maxFt - s.minFt);
    assert.equal(s.ams, core.computeAms(1500 * 3.28084, 500 * 3.28084));
});

test('routeAmsRange: maior e menor AMS com o trecho de cada uma, ignorando trechos sem valor', () => {
    const range = core.routeAmsRange([4000, null, 2700, 5800, 2700]);
    assert.deepEqual(range, { max: { ams: 5800, index: 3 }, min: { ams: 2700, index: 2 } });
    assert.equal(core.routeAmsRange([null, null]), null);
    assert.equal(core.routeAmsRange([]), null);
});
