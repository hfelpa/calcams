'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

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
test('GPX: usa os 16 pontos da rota', () => {
    const route = core.extractRoute(gpxToGeojson(fixture('ROTA.gpx').toString('utf8')));
    assert.equal(route.waypoints.length, 16);
    assert.equal(route.source, 'rota');
});

test('KML: usa os 16 waypoints nomeados e não os 8995 vértices da linha', () => {
    const route = core.extractRoute(kmlToGeojson(fixture('ROTA.kml').toString('utf8')));
    assert.equal(route.waypoints.length, 16);
    assert.equal(route.source, 'waypoints');
    assert.equal(route.waypoints[0].name, 'PONTO ALFA');
    assert.equal(route.waypoints[15].name, 'PONTO DELTA');
    assert.ok(route.waypoints.every((w) => w.name !== '#' && w.name !== 'Referência'));
    assert.ok(route.path.length > 1000, 'a linha densa continua disponível para desenhar');
});

test('GPX: nomes dos pontos da rota vêm dos waypoints na mesma posição', () => {
    const route = core.extractRoute(gpxToGeojson(fixture('ROTA.gpx').toString('utf8'), true));
    assert.equal(route.waypoints[0].name, 'PONTO ALFA');
    assert.equal(route.waypoints[15].name, 'PONTO DELTA');
    assert.ok(route.waypoints.every((w) => w.name));
});

test('GPX: sem waypoints nomeados por perto, o nome fica vazio', () => {
    const route = core.extractRoute(gpxToGeojson(fixture('ROTA.gpx').toString('utf8')));
    assert.ok(route.waypoints.every((w) => w.name === ''));
});

test('KML e GPX descrevem os mesmos waypoints', () => {
    const kml = core.extractRoute(kmlToGeojson(fixture('ROTA.kml').toString('utf8')));
    const gpx = core.extractRoute(gpxToGeojson(fixture('ROTA.gpx').toString('utf8')));
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
const txtText = () => core.bytesToBinaryString(new Uint8Array(fixture('ROTA.txt')));

test('TXT: lê 16 waypoints e 15 pernas com o campo da AMS', () => {
    const parsed = core.parseTxtRoute(txtText());
    assert.equal(parsed.waypoints.length, 16);
    assert.equal(parsed.legs.length, 15);
    assert.ok(parsed.legs.every((leg) => leg.nivelLineIndex !== null));
    parsed.legs.forEach((leg, i) => {
        assert.equal(leg.fromIndex, i, `origem da perna ${i}`);
        assert.equal(leg.toIndex, i + 1, `destino da perna ${i}`);
    });
});

test('TXT: sem alterações, a gravação devolve exatamente os mesmos bytes', () => {
    const parsed = core.parseTxtRoute(txtText());
    const out = core.binaryStringToBytes(core.applyAmsToTxt(parsed, []));
    assert.deepEqual(Buffer.from(out), fixture('ROTA.txt'));
});

test('TXT: grava só as linhas da AMS e preserva CRLF e acentos', () => {
    const original = fixture('ROTA.txt');
    const parsed = core.parseTxtRoute(txtText());
    const ams = parsed.legs.map((_, i) => 1000 + i * 100);
    const out = Buffer.from(core.binaryStringToBytes(core.applyAmsToTxt(parsed, ams)));

    const before = original.toString('latin1').split('\n');
    const after = out.toString('latin1').split('\n');
    assert.equal(after.length, before.length);
    assert.ok(after.every((line, i) => line.endsWith('\r') === before[i].endsWith('\r')), 'CRLF preservado');
    const changed = after.flatMap((line, i) => (line !== before[i] ? [i] : []));
    assert.deepEqual(changed, parsed.legs.map((leg) => leg.nivelLineIndex));
    assert.match(after[parsed.legs[0].nivelLineIndex], /^\t+Castelo\.NivelMinimoIFR = 1000\r$/);
    assert.ok(out.includes(Buffer.from('Refer\xeancia', 'latin1')), 'byte 0xEA (ê em Windows-1252) preservado');
});

test('TXT: perna sem campo da AMS não é alterada', () => {
    const parsed = core.parseTxtRoute(txtText());
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
