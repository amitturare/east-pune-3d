// Turns raw Overpass/DEM downloads (data/raw) into compact, pre-projected files
// the browser can load quickly (public/data). Coordinates are local metres
// (x east, z south) quantised to decimetres.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BBOX, ORIGIN, project } from './config.mjs';
import { LANDMARKS } from '../src/landmarks-data.js';

const RAW = path.resolve('data/raw');
const OUT = path.resolve('public/data');
const read = async (n) => JSON.parse(await fs.readFile(path.join(RAW, n + '.json'), 'utf8'));

const [minX, maxZ] = project(BBOX.south, BBOX.west);
const [maxX, minZ] = project(BBOX.north, BBOX.east);
const EXT = { minX, maxX, minZ, maxZ };
const MARGIN = 150;

const dm = (v) => Math.round(v * 10);
const ptsOf = (geom) => geom.map((g) => project(g.lat, g.lon));

// ---------- geometry helpers ----------
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}
function centroid(r) {
  let x = 0, z = 0;
  for (const p of r) { x += p[0]; z += p[1]; }
  return [x / r.length, z / r.length];
}
function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i], [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function cleanRing(r) {
  const out = [];
  for (const p of r) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.15) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.15) out.pop();
  }
  // Drop nearly collinear points.
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const p = out[(i - 1 + out.length) % out.length], c = out[i], n = out[(i + 1) % out.length];
    const cross = (c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]);
    const len = Math.hypot(c[0] - p[0], c[1] - p[1]) * Math.hypot(n[0] - c[0], n[1] - c[1]);
    if (len === 0 || Math.abs(cross) / len > 0.02) res.push(c);
  }
  return res.length >= 3 ? res : null;
}
// Sutherland–Hodgman clip of a ring against the (margin-expanded) extent.
function clipRing(r, m = MARGIN) {
  const edges = [
    (p) => p[0] >= EXT.minX - m, (p) => p[0] <= EXT.maxX + m,
    (p) => p[1] >= EXT.minZ - m, (p) => p[1] <= EXT.maxZ + m,
  ];
  const vals = [EXT.minX - m, EXT.maxX + m, EXT.minZ - m, EXT.maxZ + m];
  let out = r;
  edges.forEach((inside, k) => {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      const inter = () => {
        const axis = k < 2 ? 0 : 1, v = vals[k];
        const t = (v - prev[axis]) / (cur[axis] - prev[axis]);
        return axis === 0 ? [v, prev[1] + t * (cur[1] - prev[1])] : [prev[0] + t * (cur[0] - prev[0]), v];
      };
      if (inside(cur)) {
        if (!inside(prev)) out.push(inter());
        out.push(cur);
      } else if (inside(prev)) out.push(inter());
    }
  });
  return out.length >= 3 ? out : null;
}
// Split a polyline into runs inside the extent.
function clipLine(pts, m = MARGIN) {
  const inside = (p) => p[0] >= EXT.minX - m && p[0] <= EXT.maxX + m && p[1] >= EXT.minZ - m && p[1] <= EXT.maxZ + m;
  const runs = [];
  let cur = [];
  pts.forEach((p, i) => {
    if (inside(p) || (i > 0 && inside(pts[i - 1])) || (i < pts.length - 1 && inside(pts[i + 1]))) cur.push(p);
    else if (cur.length) { if (cur.length > 1) runs.push(cur); cur = []; }
  });
  if (cur.length > 1) runs.push(cur);
  return runs;
}
const flat = (r) => r.flatMap((p) => [dm(p[0]), dm(p[1])]);

// Assemble multipolygon relation members into closed rings.
function assembleRings(members, role) {
  const segs = members.filter((m) => m.type === 'way' && m.geometry && (m.role || 'outer') === role).map((m) => ptsOf(m.geometry));
  const rings = [];
  const key = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (key(ring[0]) !== key(ring[ring.length - 1]) && guard++ < 2000) {
      const end = key(ring[ring.length - 1]);
      const idx = segs.findIndex((s) => key(s[0]) === end || key(s[s.length - 1]) === end);
      if (idx < 0) break;
      let s = segs.splice(idx, 1)[0];
      if (key(s[0]) !== end) s = s.slice().reverse();
      ring = ring.concat(s.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}
function polygonsOf(el) {
  // -> [[outer, ...holes], ...]
  if (el.type === 'way') {
    if (!el.geometry || el.geometry.length < 4) return [];
    const g = el.geometry;
    if (g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) return [];
    return [[ptsOf(g)]];
  }
  if (el.type === 'relation' && el.members) {
    const outers = assembleRings(el.members, 'outer');
    const inners = assembleRings(el.members, 'inner');
    return outers.map((o) => [o, ...inners.filter((i) => pointInRing(i[0][0], i[0][1], o))]);
  }
  return [];
}
function preparePoly(rings) {
  const out = [];
  for (let k = 0; k < rings.length; k++) {
    let r = clipRing(rings[k]);
    if (!r) { if (k === 0) return null; continue; }
    r = cleanRing(r);
    if (!r) { if (k === 0) return null; continue; }
    // Outer CCW-in-xz? Normalise: outer positive area, holes negative.
    const a = ringArea(r);
    if ((k === 0 && a < 0) || (k > 0 && a > 0)) r.reverse();
    out.push(r);
  }
  return out;
}

// ---------- tag parsing ----------
function parseLen(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase().replace(',', '.');
  const ft = s.match(/^([\d.]+)\s*(ft|feet|')$/);
  if (ft) return parseFloat(ft[1]) * 0.3048;
  const m = s.match(/^([\d.]+)\s*(m|meter|metre|meters|metres)?$/);
  if (m) return parseFloat(m[1]);
  return null;
}
const FLOOR = 3.2;

const BTYPES = ['yes', 'residential', 'house', 'apartments', 'commercial', 'office', 'retail', 'industrial', 'warehouse', 'school', 'university', 'college', 'hospital', 'religious', 'temple', 'church', 'mosque', 'train_station', 'transportation', 'hangar', 'garage', 'shed', 'roof', 'hotel', 'public', 'government', 'civic', 'palace', 'construction', 'hut', 'service', 'stadium', 'sports_hall', 'terminal', 'part', 'other'];

// Deliberately coarse fallback. Values snap to whole storeys and only depend on
// building type and footprint size — never presented as measured data.
function estimateHeight(type, area) {
  const floors = (n) => n * FLOOR;
  switch (type) {
    case 'garage': case 'shed': case 'hut': case 'roof': case 'service': case 'kiosk': case 'carport': case 'toilets':
      return 3.5;
    case 'house': case 'detached': case 'semidetached_house': case 'terrace': case 'bungalow':
      return floors(2);
    case 'apartments':
      return area < 250 ? floors(4) : floors(7);
    case 'commercial': case 'office': case 'retail': case 'hotel':
      return area < 400 ? floors(3) : floors(5);
    case 'industrial': case 'warehouse': case 'hangar':
      return 9;
    case 'school': case 'college': case 'university': case 'hospital': case 'public': case 'government': case 'civic':
      return floors(3);
    case 'religious': case 'temple': case 'church': case 'mosque':
      return 10;
    case 'train_station': case 'transportation': case 'terminal':
      return 12;
    case 'construction':
      return floors(2);
    default:
      if (area < 60) return floors(1);
      if (area < 200) return floors(2);
      if (area < 700) return floors(3);
      return floors(4);
  }
}

function buildingHeight(tags, area) {
  const h = parseLen(tags.height) ?? parseLen(tags['building:height']);
  const minH = parseLen(tags.min_height) ?? (tags['building:min_level'] ? parseFloat(tags['building:min_level']) * FLOOR : 0);
  const levels = parseFloat(tags['building:levels']);
  const roofLevels = parseFloat(tags['roof:levels']) || 0;
  if (h && h > 1 && h < 400) return { h, minH: minH || 0, src: 0, levels: Number.isFinite(levels) ? levels : 0 };
  if (Number.isFinite(levels) && levels > 0 && levels < 100)
    return { h: (levels + roofLevels) * FLOOR + 0.6, minH: minH || 0, src: 1, levels };
  const type = tags.building || (tags['building:part'] ? 'part' : 'yes');
  return { h: estimateHeight(type, area), minH: minH || 0, src: 2, levels: 0 };
}

const COLOR_RE = /^#?[0-9a-f]{3,6}$|^[a-z]+$/i;

// ---------- buildings ----------
async function buildBuildings() {
  const raw = (await read('buildings')).elements;
  const parts = [], shells = [];
  for (const el of raw) {
    const tags = el.tags || {};
    const polys = polygonsOf(el);
    for (const p of polys) {
      const rings = preparePoly(p);
      if (!rings) continue;
      const area = Math.abs(ringArea(rings[0]));
      if (area < 6) continue;
      const rec = { el, tags, rings, area, c: centroid(rings[0]) };
      if (tags['building:part'] && !tags.building) parts.push(rec);
      else shells.push(rec);
    }
  }
  // Simple-3D-buildings: an outline with height-tagged parts inside is replaced by its parts.
  const grid = new Map();
  const cell = (x, z) => Math.floor(x / 200) + ':' + Math.floor(z / 200);
  shells.forEach((s, i) => { const k = cell(...s.c); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
  const replaced = new Set();
  for (const p of parts) {
    const [x, z] = p.c;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const k = (Math.floor(x / 200) + dx) + ':' + (Math.floor(z / 200) + dz);
      for (const i of grid.get(k) || []) if (!replaced.has(i) && pointInRing(x, z, shells[i].rings[0])) replaced.add(i);
    }
  }
  const all = shells.filter((_, i) => !replaced.has(i)).concat(parts);
  const out = [];
  const stats = { total: 0, height: 0, levels: 0, estimated: 0, tallest: null };
  for (const b of all) {
    if (b.c[0] < EXT.minX || b.c[0] > EXT.maxX || b.c[1] < EXT.minZ || b.c[1] > EXT.maxZ) continue;
    const { h, minH, src, levels } = buildingHeight(b.tags, b.area);
    let type = b.tags.building || 'part';
    if (!BTYPES.includes(type)) type = ['detached', 'semidetached_house', 'terrace', 'bungalow'].includes(type) ? 'house' : 'other';
    const colour = COLOR_RE.test(b.tags['building:colour'] || '') ? b.tags['building:colour'] : 0;
    const roofColour = COLOR_RE.test(b.tags['roof:colour'] || '') ? b.tags['roof:colour'] : 0;
    out.push([
      b.el.type[0] + b.el.id, BTYPES.indexOf(type), dm(h), dm(minH), src, levels || 0,
      b.tags.name || 0, colour, roofColour, b.rings.map(flat),
    ]);
    stats.total++;
    stats[['height', 'levels', 'estimated'][src]]++;
    if (src < 2 && (!stats.tallest || h > stats.tallest.h)) stats.tallest = { h: +h.toFixed(1), name: b.tags.name || null, c: b.c.map((v) => +v.toFixed(1)) };
  }
  return { list: out, stats, types: BTYPES };
}

// ---------- roads ----------
const ROAD_CLASSES = {
  motorway: 20, trunk: 18, primary: 15, secondary: 12, tertiary: 9.5,
  motorway_link: 9, trunk_link: 9, primary_link: 8, secondary_link: 7, tertiary_link: 6.5,
  unclassified: 6.5, residential: 6, living_street: 5, service: 4, pedestrian: 5, track: 3,
  footway: 2, path: 1.8, cycleway: 2, steps: 2,
};
async function buildRoads() {
  const raw = (await read('highways')).elements;
  const out = [];
  for (const el of raw) {
    const t = el.tags || {};
    const cls = t.highway;
    if (!(cls in ROAD_CLASSES) || !el.geometry) continue;
    if (t.area === 'yes') continue;
    if (['footway', 'path', 'steps'].includes(cls) && t.footway === 'sidewalk') continue;
    const width = parseLen(t.width) && parseLen(t.width) < 40 ? parseLen(t.width) : ROAD_CLASSES[cls] * (t.lanes && +t.lanes > 4 ? 1.25 : 1);
    for (const run of clipLine(ptsOf(el.geometry))) {
      out.push([
        el.id, cls, +width.toFixed(1), t.name || t['name:en'] || 0,
        t.bridge && t.bridge !== 'no' ? 1 : 0, parseInt(t.layer) || 0, t.tunnel && t.tunnel !== 'no' ? 1 : 0,
        t.oneway === 'yes' ? 1 : 0, flat(run),
      ]);
    }
  }
  return out;
}

// ---------- railways ----------
async function buildRail() {
  const raw = (await read('railways')).elements;
  const lines = [], stations = [];
  for (const el of raw) {
    const t = el.tags || {};
    if (el.type === 'node') {
      if (t.name) {
        const [x, z] = project(el.lat, el.lon);
        stations.push({ id: 'n' + el.id, name: t['name:en'] || t.name, kind: t.station || t.railway || t.public_transport, subway: t.subway === 'yes' || t.station === 'subway' || /metro/i.test(t.network || t.operator || ''), x: +x.toFixed(1), z: +z.toFixed(1), wikidata: t.wikidata || null });
      }
      continue;
    }
    if (!el.geometry) continue;
    const r = t.railway;
    if (!['rail', 'subway', 'light_rail', 'narrow_gauge', 'construction', 'platform'].includes(r)) continue;
    if (r === 'construction' && !['subway', 'light_rail', 'rail'].includes(t.construction)) continue;
    for (const run of clipLine(ptsOf(el.geometry))) {
      lines.push([el.id, r === 'construction' ? 'construction_' + t.construction : r, t.bridge && t.bridge !== 'no' ? 1 : 0, parseInt(t.layer) || 0, t.name || 0, t.service || 0, t.usage || 0, flat(run)]);
    }
  }
  return { lines, stations };
}

// ---------- water ----------
async function buildWater() {
  const raw = (await read('water')).elements;
  const polys = [], lines = [];
  for (const el of raw) {
    const t = el.tags || {};
    const isArea = t.natural === 'water' || t.waterway === 'riverbank' || (el.type === 'relation' && t.type === 'multipolygon');
    if (isArea) {
      for (const p of polygonsOf(el)) {
        const rings = preparePoly(p);
        if (rings) polys.push([el.id, t.water || t.waterway || 'water', t.name || 0, rings.map(flat)]);
      }
    } else if (t.waterway && el.geometry) {
      const w = { river: 60, canal: 12, stream: 5, drain: 3, ditch: 2 }[t.waterway];
      if (!w) continue;
      for (const run of clipLine(ptsOf(el.geometry))) lines.push([el.id, t.waterway, parseLen(t.width) || w, t.name || 0, t.tunnel ? 1 : 0, flat(run)]);
    }
  }
  return { polys, lines };
}

// ---------- land use / areas ----------
function areaClass(t) {
  if (t.aeroway) return { runway: 'runway', taxiway: 'taxiway', apron: 'apron', aerodrome: 'aerodrome', helipad: 'apron', terminal: null }[t.aeroway] ?? null;
  if (t.leisure) return { park: 'park', garden: 'garden', pitch: 'pitch', golf_course: 'golf', stadium: 'pitch', playground: 'garden', sports_centre: 'pitch', nature_reserve: 'wood', track: 'pitch', common: 'grass' }[t.leisure] ?? null;
  if (t.natural) return { wood: 'wood', scrub: 'scrub', grassland: 'grass', heath: 'scrub', wetland: 'wetland', sand: 'sand', bare_rock: 'sand' }[t.natural] ?? null;
  if (t.landuse) return { residential: 'residential', commercial: 'commercial', retail: 'commercial', industrial: 'industrial', military: 'military', grass: 'grass', forest: 'wood', meadow: 'grass', farmland: 'farmland', orchard: 'farmland', cemetery: 'cemetery', railway: 'railway', construction: 'construction', recreation_ground: 'grass', village_green: 'grass', brownfield: 'construction', education: 'education', institutional: 'education', religious: 'residential', plant_nursery: 'farmland', greenfield: 'grass', flowerbed: 'garden', basin: null, reservoir: null }[t.landuse] ?? null;
  if (t.amenity) return { school: 'education', college: 'education', university: 'education', hospital: 'hospital', parking: 'parking', place_of_worship: null }[t.amenity] ?? null;
  return null;
}
async function buildAreas() {
  const raw = (await read('areas')).elements;
  const polys = [], aeroLines = [];
  for (const el of raw) {
    const t = el.tags || {};
    if (t.aeroway && ['runway', 'taxiway'].includes(t.aeroway) && el.type === 'way' && el.geometry) {
      const g = el.geometry;
      const closed = g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon && g.length > 4;
      if (!closed) {
        const w = parseLen(t.width) || (t.aeroway === 'runway' ? 45 : 18);
        aeroLines.push([el.id, t.aeroway, w, t.ref || 0, flat(ptsOf(g))]);
        continue;
      }
    }
    const cls = areaClass(t);
    if (!cls) continue;
    for (const p of polygonsOf(el)) {
      const rings = preparePoly(p);
      if (rings) polys.push([el.id, cls, t.name || 0, +Math.abs(ringArea(rings[0])).toFixed(0), rings.map(flat)]);
    }
  }
  // Paint big areas first so small ones sit on top.
  polys.sort((a, b) => b[3] - a[3]);
  return { polys, aeroLines };
}

async function buildTrees() {
  const raw = (await read('trees')).elements;
  const pts = [], rows = [];
  for (const el of raw) {
    if (el.type === 'node') {
      const [x, z] = project(el.lat, el.lon);
      pts.push(dm(x), dm(z));
    } else if (el.geometry) rows.push(flat(ptsOf(el.geometry)));
  }
  return { pts, rows };
}

// ---------- POIs / places ----------
async function buildPois() {
  const raw = (await read('pois')).elements;
  const out = [];
  const seen = new Set();
  for (const el of raw) {
    const t = el.tags || {};
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
    if (lat == null || !t.name) continue;
    const [x, z] = project(lat, lon);
    if (x < EXT.minX || x > EXT.maxX || z < EXT.minZ || z > EXT.maxZ) continue;
    const k = el.type + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const cat = t.place ? 'place:' + t.place : t.aeroway ? 'aeroway' : t.shop === 'mall' ? 'mall' : t.historic ? 'historic' : t.tourism ? 'tourism:' + t.tourism : t.leisure ? 'leisure:' + t.leisure : t.railway || t.public_transport ? 'transit' : t.amenity ? 'amenity:' + t.amenity : t.building ? 'building' : t.highway ? 'road' : t.waterway ? 'waterway' : t.natural ? 'natural' : 'other';
    out.push({ id: k, name: t['name:en'] || t.name, cat, x: +x.toFixed(1), z: +z.toFixed(1), wikidata: t.wikidata || null, wikipedia: t.wikipedia || null });
  }
  return out;
}

// ---------- elevation ----------
async function buildElevation() {
  const e = await read('elevation');
  const vals = e.elevation;
  const min = Math.min(...vals);
  return { n: e.n, ext: EXT, base: min, data: vals.map((v) => +(v - min).toFixed(1)), source: e.source };
}

// ---------- landmarks ----------
function resolveLandmarks(pois, buildings, rail, areas) {
  const nameMatch = (name, re) => name && re.test(name);
  return LANDMARKS.map((lm) => {
    let pos = null, footprint = null;
    if (lm.match) {
      const re = new RegExp(lm.match, 'i');
      // Non-transit landmarks should not snap to a same-named metro station.
      const poi = pois.find((p) => nameMatch(p.name, re) && (lm.preferStation || p.cat !== 'transit'));
      const st = rail.stations.find((s) => s.subway && nameMatch(s.name, re)) || rail.stations.find((s) => nameMatch(s.name, re));
      const src = lm.preferStation ? st || poi : poi || st;
      if (src) pos = [src.x, src.z];
    }
    if (!pos && lm.lat) pos = project(lm.lat, lm.lon).map((v) => +v.toFixed(1));
    // Snap to (and remember) the named building footprint, when mapped.
    if (lm.building) {
      const re = new RegExp(lm.building, 'i');
      let best = null;
      for (const b of buildings) {
        if (!nameMatch(b[6], re)) continue;
        const r = b[9][0];
        const c = [0, 0];
        for (let i = 0; i < r.length; i += 2) { c[0] += r[i] / 10; c[1] += r[i + 1] / 10; }
        c[0] /= r.length / 2; c[1] /= r.length / 2;
        // Favour the closest footprint whose name is closest to the pattern (shorter = fewer extra words).
        const d = (pos ? Math.hypot(c[0] - pos[0], c[1] - pos[1]) : 0) + String(b[6]).length * 15;
        if (d < 1500 && (!best || d < best.d)) best = { d, c, id: b[0] };
      }
      if (best) { footprint = best.id; if (!pos) pos = best.c.map((v) => +v.toFixed(1)); }
    }
    if (!pos) console.warn('  ! landmark unresolved:', lm.id);
    const { match, building, lat, lon, preferStation, ...rest } = lm;
    return { ...rest, x: pos ? +pos[0].toFixed(1) : 0, z: pos ? +pos[1].toFixed(1) : 0, footprint, resolved: !!pos };
  });
}

// ---------- main ----------
await fs.mkdir(OUT, { recursive: true });
const t0 = Date.now();
const [buildings, roads, rail, water, areas, trees, pois, elevation] = await Promise.all([
  buildBuildings(), buildRoads(), buildRail(), buildWater(), buildAreas(), buildTrees(), buildPois(), buildElevation(),
]);
const landmarks = resolveLandmarks(pois, buildings.list, rail, areas);
const meta = {
  generated: new Date().toISOString(), bbox: BBOX, origin: ORIGIN, ext: EXT,
  counts: { buildings: buildings.list.length, roads: roads.length, rail: rail.lines.length, water: water.polys.length + water.lines.length, areas: areas.polys.length, trees: trees.pts.length / 2, pois: pois.length },
  heights: buildings.stats, buildingTypes: buildings.types,
  attribution: '© OpenStreetMap contributors (ODbL). Elevation: ' + elevation.source,
};
await fs.writeFile(path.join(OUT, 'buildings.json'), JSON.stringify(buildings.list));
await fs.writeFile(path.join(OUT, 'world.json'), JSON.stringify({ meta, roads, rail, water, areas, trees, elevation }));
await fs.writeFile(path.join(OUT, 'places.json'), JSON.stringify({ pois, landmarks, stations: rail.stations }));
console.log(meta.counts, meta.heights, `in ${Date.now() - t0} ms`);
for (const f of ['buildings.json', 'world.json', 'places.json']) console.log(f, ((await fs.stat(path.join(OUT, f))).size / 1e6).toFixed(2), 'MB');
