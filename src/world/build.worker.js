// Geometry worker: turns the pre-projected OSM data into GPU-ready typed arrays
// (merged per tile), paints the ground texture and carves the river into the
// terrain. Everything heavy happens here so the main thread stays responsive.
import earcut from 'earcut';
import { Heightfield } from './heightfield.js';
import { GROUND, TREE_DENSITY, WALLS, ROOFS } from './palette.js';

export const ROAD_ORDER = ['footway', 'path', 'cycleway', 'steps', 'track', 'service', 'pedestrian', 'living_street', 'residential', 'unclassified', 'tertiary_link', 'tertiary', 'secondary_link', 'secondary', 'primary_link', 'primary', 'trunk_link', 'trunk', 'motorway_link', 'motorway'];
const TILE = 800;
const CELL = 20;

let progressBase = 0;
const post = (type, payload, transfer) => self.postMessage({ type, ...payload }, transfer || []);
const progress = (p, step) => post('progress', { p, step });

// ---------------------------------------------------------------- utilities
function hash(n) {
  n = (n ^ 61) ^ (n >>> 16);
  n = (n + (n << 3)) | 0;
  n ^= n >>> 4;
  n = Math.imul(n, 0x27d4eb2d);
  n ^= n >>> 15;
  return (n >>> 0) / 4294967296;
}
function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const toRing = (flat) => {
  const r = new Array(flat.length / 2);
  for (let i = 0; i < r.length; i++) r[i] = [flat[2 * i] / 10, flat[2 * i + 1] / 10];
  return r;
};
const shoelace = (r) => {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

const colorCtx = new OffscreenCanvas(1, 1).getContext('2d');
const colorCache = new Map();
function parseColor(str) {
  if (colorCache.has(str)) return colorCache.get(str);
  colorCtx.fillStyle = '#000';
  colorCtx.fillStyle = str.startsWith('#') || !/^[0-9a-f]{3,6}$/i.test(str) ? str : '#' + str;
  const hex = colorCtx.fillStyle;
  const out = hex.startsWith('#') ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] : null;
  colorCache.set(str, out);
  return out;
}
const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toLinear8 = (v) => {
  const c = v / 255;
  return Math.round(255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
};

// Growable typed-array builder for one merged mesh.
class MeshBuilder {
  constructor(spec) {
    this.spec = spec; // { name: [ArrayType, itemSize] }
    this.cap = 1024;
    this.count = 0;
    this.arrays = {};
    for (const [k, [T, n]] of Object.entries(spec)) this.arrays[k] = new T(this.cap * n);
    this.index = new Uint32Array(this.cap * 2);
    this.icount = 0;
  }
  reserve(nv, ni) {
    if (this.count + nv > this.cap) {
      let c = this.cap;
      while (this.count + nv > c) c *= 2;
      for (const [k, [T, n]] of Object.entries(this.spec)) {
        const a = new T(c * n);
        a.set(this.arrays[k]);
        this.arrays[k] = a;
      }
      this.cap = c;
    }
    if (this.icount + ni > this.index.length) {
      let c = this.index.length;
      while (this.icount + ni > c) c *= 2;
      const a = new Uint32Array(c);
      a.set(this.index);
      this.index = a;
    }
  }
  finish() {
    const out = { count: this.count, attributes: {} };
    for (const [k, [, n]] of Object.entries(this.spec)) out.attributes[k] = this.arrays[k].slice(0, this.count * n);
    out.index = this.count < 65535 ? Uint16Array.from(this.index.subarray(0, this.icount)) : this.index.slice(0, this.icount);
    return out;
  }
}
const buffersOf = (m) => (m ? [...Object.values(m.attributes).map((a) => a.buffer), m.index.buffer] : []);

// ---------------------------------------------------------------- heightfield
function cubic(p0, p1, p2, p3, t) {
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
function buildHeightfield(elev) {
  const { n, ext, data } = elev;
  const nx = Math.ceil((ext.maxX - ext.minX) / CELL) + 1;
  const nz = Math.ceil((ext.maxZ - ext.minZ) / CELL) + 1;
  const dem = (i, j) => data[Math.max(0, Math.min(n - 1, j)) * n + Math.max(0, Math.min(n - 1, i))];
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    const z = ext.minZ + j * CELL;
    const fz = ((ext.maxZ - z) / (ext.maxZ - ext.minZ)) * (n - 1);
    const zj = Math.floor(fz), tz = fz - zj;
    for (let i = 0; i < nx; i++) {
      const x = ext.minX + i * CELL;
      const fx = ((x - ext.minX) / (ext.maxX - ext.minX)) * (n - 1);
      const xi = Math.floor(fx), tx = fx - xi;
      const rows = [];
      for (let k = -1; k <= 2; k++) rows.push(cubic(dem(xi - 1, zj + k), dem(xi, zj + k), dem(xi + 1, zj + k), dem(xi + 2, zj + k), tx));
      h[j * nx + i] = Math.max(0, cubic(rows[0], rows[1], rows[2], rows[3], tz));
    }
  }
  return new Heightfield({ nx, nz, minX: ext.minX, minZ: ext.minZ, cell: CELL, data: h, water: new Float32Array(nx * nz) });
}

function minFilter(src, nx, nz, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) m = Math.min(m, src[j * nx + k]);
      tmp[j * nx + i] = m;
    }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      let m = Infinity;
      for (let k = Math.max(0, j - r); k <= Math.min(nz - 1, j + r); k++) m = Math.min(m, tmp[k * nx + i]);
      out[j * nx + i] = m;
    }
  return out;
}
function boxBlur(src, nx, nz, r, passes = 2) {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(nx - 1, i + r); k++) { s += a[j * nx + k]; c++; }
        tmp[j * nx + i] = s / c;
      }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, j - r); k <= Math.min(nz - 1, j + r); k++) { s += tmp[k * nx + i]; c++; }
        out[j * nx + i] = s / c;
      }
    a = out;
  }
  return a;
}

// ---------------------------------------------------------------- painting
function worldCanvas(w, h, ext) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: false });
  const sx = w / (ext.maxX - ext.minX), sz = h / (ext.maxZ - ext.minZ);
  ctx.setTransform(sx, 0, 0, sz, -ext.minX * sx, -ext.minZ * sz);
  return { c, ctx, sx };
}
function pathOfRings(rings) {
  const p = new Path2D();
  for (const flat of rings) {
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i] / 10, z = flat[i + 1] / 10;
      if (i === 0) p.moveTo(x, z);
      else p.lineTo(x, z);
    }
    p.closePath();
  }
  return p;
}
function pathOfLine(flat) {
  const p = new Path2D();
  for (let i = 0; i < flat.length; i += 2) {
    if (i === 0) p.moveTo(flat[i] / 10, flat[i + 1] / 10);
    else p.lineTo(flat[i] / 10, flat[i + 1] / 10);
  }
  return p;
}

// ---------------------------------------------------------------- main build
self.onmessage = async (e) => {
  try {
    await build(e.data);
  } catch (err) {
    post('error', { message: err.message, stack: err.stack });
  }
};

async function fetchJSON(url, weight, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total) return res.json();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    progress(progressBase + weight * Math.min(1, got / total), `Downloading ${label} · ${(got / 1e6).toFixed(1)} MB`);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

async function build({ worldUrl, buildingsUrl }) {
  progress(0.01, 'Downloading map data');
  const worldP = fetchJSON(worldUrl, 0, 'map data');
  progressBase = 0.02;
  const buildings = await fetchJSON(buildingsUrl, 0.3, 'building footprints');
  const world = await worldP;
  const ext = world.meta.ext;

  // ---- terrain + water carving
  progress(0.34, 'Shaping terrain from elevation data');
  const hf = buildHeightfield(world.elevation);
  const { nx, nz } = hf;
  {
    const { c, ctx } = worldCanvas(nx, nz, { minX: ext.minX - CELL / 2, maxX: ext.minX + (nx - 0.5) * CELL, minZ: ext.minZ - CELL / 2, maxZ: ext.minZ + (nz - 0.5) * CELL });
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'round';
    for (const [, , , rings] of world.water.polys) ctx.fill(pathOfRings(rings), 'evenodd');
    for (const [, kind, w, , tunnel, flat] of world.water.lines) {
      if (tunnel || kind === 'river') continue;
      ctx.lineWidth = Math.max(w, 6);
      ctx.stroke(pathOfLine(flat));
    }
    const px = ctx.getImageData(0, 0, nx, nz).data;
    // Valley floor: lowest ground within ~300 m, smoothed. Water sits just below it.
    const floor = boxBlur(minFilter(hf.data, nx, nz, 15), nx, nz, 6, 2);
    const mask = new Float32Array(nx * nz);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4] / 255;
    const soft = boxBlur(mask, nx, nz, 1, 1);
    for (let i = 0; i < hf.data.length; i++) {
      hf.water[i] = floor[i] - 0.4;
      const m = Math.max(mask[i], soft[i] * 0.85);
      const bed = floor[i] - 3.5;
      hf.data[i] = hf.data[i] * (1 - m) + Math.min(hf.data[i], bed) * m;
    }
  }

  // ---- ground texture
  progress(0.4, 'Painting land use');
  const TEX_H = 4096;
  const TEX_W = Math.round((TEX_H * (ext.maxX - ext.minX)) / (ext.maxZ - ext.minZ));
  const ground = worldCanvas(TEX_W, TEX_H, ext);
  const density = worldCanvas(Math.round(TEX_W / 2), TEX_H / 2, ext);
  {
    const { ctx } = ground;
    ctx.fillStyle = GROUND.base;
    ctx.fillRect(ext.minX, ext.minZ, ext.maxX - ext.minX, ext.maxZ - ext.minZ);
    // Mottled natural ground.
    const rnd = mulberry(7);
    for (let i = 0; i < 26000; i++) {
      const x = ext.minX + rnd() * (ext.maxX - ext.minX), z = ext.minZ + rnd() * (ext.maxZ - ext.minZ);
      const r = 6 + rnd() * 40;
      const g = rnd();
      ctx.fillStyle = g < 0.4 ? 'rgba(96,120,62,0.10)' : g < 0.75 ? 'rgba(160,140,100,0.10)' : 'rgba(70,90,50,0.12)';
      ctx.beginPath();
      ctx.arc(x, z, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const d = density.ctx;
    d.fillStyle = `rgb(${Math.round(TREE_DENSITY.base * 255)},0,0)`;
    d.fillRect(ext.minX, ext.minZ, ext.maxX - ext.minX, ext.maxZ - ext.minZ);
    for (const [id, cls, , , rings] of world.areas.polys) {
      const p = pathOfRings(rings);
      const col = GROUND[cls] || GROUND.base;
      ctx.fillStyle = col;
      ctx.globalAlpha = cls === 'residential' || cls === 'military' || cls === 'aerodrome' ? 0.75 : 0.92;
      ctx.fill(p, 'evenodd');
      ctx.globalAlpha = 1;
      if (['park', 'garden', 'golf', 'pitch', 'wood'].includes(cls)) {
        // Subtle texture variation inside green areas.
        const r = mulberry(id);
        ctx.save();
        ctx.clip(p, 'evenodd');
        const b = bboxOfRings(rings);
        const n = Math.min(400, ((b[2] - b[0]) * (b[3] - b[1])) / 400);
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = r() < 0.5 ? 'rgba(40,70,30,0.10)' : 'rgba(140,170,90,0.10)';
          ctx.beginPath();
          ctx.arc(b[0] + r() * (b[2] - b[0]), b[1] + r() * (b[3] - b[1]), 3 + r() * 12, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      const dv = TREE_DENSITY[cls] ?? TREE_DENSITY.base;
      d.fillStyle = `rgb(${Math.round(dv * 255)},0,0)`;
      d.fill(p, 'evenodd');
    }
    // Airport markings.
    for (const [, kind, w, , flat] of world.areas.aeroLines) {
      const p = pathOfLine(flat);
      ctx.lineCap = 'butt';
      ctx.strokeStyle = kind === 'runway' ? GROUND.runway : GROUND.taxiway;
      ctx.lineWidth = w;
      ctx.stroke(p);
      if (kind === 'runway') {
        ctx.strokeStyle = 'rgba(245,245,240,0.85)';
        ctx.lineWidth = 0.9;
        ctx.setLineDash([30, 20]);
        ctx.stroke(p);
        ctx.setLineDash([]);
        ctx.lineWidth = 0.9;
        ctx.strokeStyle = 'rgba(245,245,240,0.6)';
        strokeOffset(ctx, flat, w / 2 - 1.5);
        strokeOffset(ctx, flat, -w / 2 + 1.5);
      } else {
        ctx.strokeStyle = 'rgba(240,200,60,0.7)';
        ctx.lineWidth = 0.5;
        ctx.stroke(p);
      }
      d.strokeStyle = '#000';
      d.lineWidth = w + 30;
      d.stroke(p);
    }
    // River bed + streams.
    ctx.fillStyle = GROUND.water;
    for (const [, , , rings] of world.water.polys) {
      const p = pathOfRings(rings);
      ctx.fill(p, 'evenodd');
      d.fillStyle = '#000';
      d.fill(p, 'evenodd');
    }
    ctx.strokeStyle = GROUND.water;
    ctx.lineCap = 'round';
    for (const [, , w, , tunnel, flat] of world.water.lines) {
      if (tunnel) continue;
      ctx.lineWidth = w;
      ctx.stroke(pathOfLine(flat));
    }
    // Soft shoulders under roads; railway ballast.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    d.lineCap = 'round';
    d.strokeStyle = '#000';
    for (const [, cls, w, , bridge, , tunnel, , flat] of world.roads) {
      if (tunnel || bridge) continue;
      const p = pathOfLine(flat);
      const rank = ROAD_ORDER.indexOf(cls);
      if (rank >= 5) {
        ctx.strokeStyle = 'rgba(95,90,82,0.55)';
        ctx.lineWidth = w + 3;
        ctx.stroke(p);
      } else if (rank >= 0) {
        ctx.strokeStyle = 'rgba(200,185,150,0.55)';
        ctx.lineWidth = w;
        ctx.stroke(p);
      }
      d.lineWidth = w + 4;
      d.stroke(p);
    }
    for (const [, kind, bridge, , , , , flat] of world.rail.lines) {
      if (kind !== 'rail' || bridge) continue;
      const p = pathOfLine(flat);
      ctx.strokeStyle = '#8a8076';
      ctx.lineWidth = 7;
      ctx.stroke(p);
      d.lineWidth = 12;
      d.stroke(p);
    }
    // Contact shadow around building bases.
    ctx.fillStyle = 'rgba(38,34,28,0.5)';
    ctx.strokeStyle = 'rgba(38,34,28,0.22)';
    ctx.lineWidth = 2.6;
    d.fillStyle = '#000';
    d.lineWidth = 5;
    for (const b of buildings) {
      const p = pathOfRings(b[9]);
      ctx.stroke(p);
      ctx.fill(p, 'evenodd');
      d.fill(p);
      d.stroke(p);
    }
  }
  // Raw pixels transfer reliably everywhere (GPU-backed ImageBitmaps do not).
  const groundTex = { w: TEX_W, h: TEX_H, data: ground.ctx.getImageData(0, 0, TEX_W, TEX_H).data };

  // ---- buildings
  progress(0.5, 'Extruding buildings');
  const B = buildBuildings(buildings, hf, ext, world.meta.buildingTypes);

  progress(0.72, 'Laying roads, bridges and rail');
  const roads = buildRoads(world.roads, hf);
  const rail = buildRail(world.rail.lines, hf);

  progress(0.8, 'Filling the Mula-Mutha');
  const water = buildWater(world.water, hf);

  progress(0.84, 'Planting trees');
  const trees = buildTrees(world.trees, density, ext, world.areas.polys);

  progress(0.88, 'Draping terrain');
  const terrain = buildTerrain(hf, ext);

  const transfer = [
    groundTex.data.buffer, hf.data.buffer, hf.water.buffer,
    ...B.tiles.flatMap((t) => [...buffersOf(t.major), ...buffersOf(t.minor)]),
    ...Object.values(B.info).map((a) => a.buffer),
    ...buffersOf(roads.mesh), ...buffersOf(roads.structure), ...buffersOf(rail.mesh), ...buffersOf(rail.structure),
    ...buffersOf(water.mesh), ...buffersOf(terrain), trees.buffer,
    ...roads.carPaths.map((p) => p.pts.buffer), ...rail.metroPaths.map((p) => p.pts.buffer),
  ];
  post('done', {
    meta: world.meta,
    demBase: world.elevation.base,
    heightfield: hf.toJSON(),
    groundTex,
    buildings: { tiles: B.tiles, info: B.info, ids: B.ids, names: B.names },
    roads: roads.mesh, structure: roads.structure, roadLabels: roads.labels, roadNames: roads.names, carPaths: roads.carPaths,
    rail: rail.mesh, railStructure: rail.structure, metroPaths: rail.metroPaths,
    water: water.mesh, waterLabels: water.labels, runways: world.areas.aeroLines.filter((a) => a[1] === 'runway').map((a) => a[4].map((v) => v / 10)),
    trees, terrain,
    areaNames: world.areas.polys.filter((p) => p[2] && p[3] > 3000 && ['park', 'garden', 'golf', 'wood', 'military', 'education', 'cemetery'].includes(p[1])).map((p) => { const b = bboxOfRings(p[4]); return { name: p[2], cls: p[1], x: (b[0] + b[2]) / 2, z: (b[1] + b[3]) / 2, area: p[3] }; }),
  }, transfer);
}

function bboxOfRings(rings) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const flat of rings)
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i] / 10, z = flat[i + 1] / 10;
      if (x < b[0]) b[0] = x;
      if (z < b[1]) b[1] = z;
      if (x > b[2]) b[2] = x;
      if (z > b[3]) b[3] = z;
    }
  return b;
}
function strokeOffset(ctx, flat, off) {
  const p = new Path2D();
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const dx = flat[2 * b] - flat[2 * a], dz = flat[2 * b + 1] - flat[2 * a + 1];
    const l = Math.hypot(dx, dz) || 1;
    const x = flat[2 * i] / 10 + (-dz / l) * off, z = flat[2 * i + 1] / 10 + (dx / l) * off;
    if (i === 0) p.moveTo(x, z);
    else p.lineTo(x, z);
  }
  ctx.stroke(p);
}

// ---------------------------------------------------------------- buildings
const BUILDING_SPEC = {
  position: [Float32Array, 3], normal: [Int8Array, 3], wuv: [Float32Array, 2], color: [Uint8Array, 3],
  elev: [Float32Array, 1], bid: [Float32Array, 1], meta: [Uint8Array, 2],
};
function wallPalette(type) {
  switch (type) {
    case 'house': return WALLS.house;
    case 'apartments': return WALLS.apartments;
    case 'commercial': case 'office': case 'retail': case 'hotel': return WALLS.commercial;
    case 'industrial': case 'warehouse': case 'hangar': return WALLS.industrial;
    case 'school': case 'university': case 'college': case 'hospital': case 'public': case 'government': case 'civic': return WALLS.education;
    case 'religious': case 'temple': case 'church': case 'mosque': return WALLS.religious;
    case 'palace': return WALLS.palace;
    case 'train_station': case 'transportation': case 'terminal': return WALLS.station;
    case 'garage': case 'shed': case 'hut': case 'roof': case 'service': return WALLS.small;
    default: return WALLS.residential;
  }
}
const NO_WINDOWS = new Set(['garage', 'shed', 'hut', 'roof', 'service', 'hangar', 'warehouse', 'construction']);
const GLASSY = new Set(['commercial', 'office', 'retail', 'hotel', 'terminal']);

function buildBuildings(list, hf, ext, TYPES) {
  const tilesX = Math.ceil((ext.maxX - ext.minX) / TILE);
  const tileMap = new Map();
  const N = list.length;
  const info = {
    cx: new Float32Array(N), cz: new Float32Array(N), h: new Float32Array(N), minH: new Float32Array(N),
    base: new Float32Array(N), area: new Float32Array(N), src: new Uint8Array(N), type: new Uint8Array(N), levels: new Uint8Array(N),
  };
  const ids = new Array(N);
  const names = {};
  for (let bi = 0; bi < N; bi++) {
    if (bi % 5000 === 0) progress(0.5 + (0.22 * bi) / N, `Extruding buildings · ${bi.toLocaleString()} / ${N.toLocaleString()}`);
    const [id, typeIdx, hDm, minHDm, src, levels, name, colour, roofColour, ringsFlat] = list[bi];
    const type = TYPES[typeIdx] || 'yes';
    const rings = ringsFlat.map(toRing);
    if (shoelace(rings[0]) < 0) rings[0].reverse();
    for (let k = 1; k < rings.length; k++) if (shoelace(rings[k]) > 0) rings[k].reverse();
    const outer = rings[0];
    let cx = 0, cz = 0, base = Infinity;
    for (const p of outer) {
      cx += p[0]; cz += p[1];
      base = Math.min(base, hf.at(p[0], p[1]));
    }
    cx /= outer.length; cz /= outer.length;
    base = Math.min(base, hf.at(cx, cz)) - 0.4;
    const h = hDm / 10, minH = minHDm / 10;
    const area = Math.abs(shoelace(outer));
    const hsh = strHash(id);
    info.cx[bi] = cx; info.cz[bi] = cz; info.h[bi] = h; info.minH[bi] = minH; info.base[bi] = base;
    info.area[bi] = area; info.src[bi] = src; info.type[bi] = typeIdx; info.levels[bi] = Math.min(255, levels);
    ids[bi] = id;
    if (name) names[bi] = name;

    const pal = wallPalette(name && /palace/i.test(name) ? 'palace' : type);
    let wall = colour ? parseColor(String(colour)) : null;
    if (!wall) wall = hexRgb(pal[Math.floor(hash(hsh) * pal.length)]);
    const shade = 0.93 + hash(hsh + 7) * 0.12;
    // Vertex colours are consumed as linear values by three.js.
    wall = wall.map((v) => toLinear8(Math.min(255, v * shade)));
    let roof = roofColour ? parseColor(String(roofColour)) : null;
    if (!roof) roof = hexRgb(ROOFS[Math.floor(hash(hsh + 3) * ROOFS.length)]);
    roof = roof.map(toLinear8);
    const flags = (NO_WINDOWS.has(type) || h < 2.8 ? 0 : 1) | (GLASSY.has(type) ? 2 : 0) | (type === 'house' ? 4 : 0);

    const tx = Math.floor((cx - ext.minX) / TILE), tz = Math.floor((cz - ext.minZ) / TILE);
    const key = tz * tilesX + tx;
    let tile = tileMap.get(key);
    if (!tile) {
      tile = { key, x0: ext.minX + tx * TILE, z0: ext.minZ + tz * TILE, maxH: 0, major: new MeshBuilder(BUILDING_SPEC), minor: new MeshBuilder(BUILDING_SPEC), nMajor: 0, nMinor: 0 };
      tileMap.set(key, tile);
    }
    const isMajor = h >= 11 || area >= 300 || name;
    const mb = isMajor ? tile.major : tile.minor;
    if (isMajor) tile.nMajor++; else tile.nMinor++;
    tile.maxH = Math.max(tile.maxH, h);

    // Count vertices first.
    let edges = 0;
    for (const r of rings) edges += r.length;
    const flatRoof = [];
    for (const r of rings) for (const p of r) flatRoof.push(p[0], p[1]);
    const holes = [];
    let acc = rings[0].length;
    for (let k = 1; k < rings.length; k++) { holes.push(acc); acc += rings[k].length; }
    const tris = earcut(flatRoof, holes.length ? holes : undefined, 2);
    mb.reserve(edges * 4 + acc, edges * 6 + tris.length);
    const P = mb.arrays.position, Nn = mb.arrays.normal, U = mb.arrays.wuv, C = mb.arrays.color, E = mb.arrays.elev, I = mb.arrays.bid, M = mb.arrays.meta, IX = mb.index;
    const put = (x, y, z, nx_, ny, nz_, u, v, col) => {
      const i = mb.count++;
      P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
      Nn[i * 3] = nx_ * 127; Nn[i * 3 + 1] = ny * 127; Nn[i * 3 + 2] = nz_ * 127;
      U[i * 2] = u; U[i * 2 + 1] = v;
      C[i * 3] = col[0]; C[i * 3 + 1] = col[1]; C[i * 3 + 2] = col[2];
      E[i] = base; I[i] = bi + 1; M[i * 2] = src; M[i * 2 + 1] = flags;
      return i;
    };
    const u0 = hash(hsh + 11) * 3;
    for (const r of rings) {
      let u = u0;
      for (let k = 0; k < r.length; k++) {
        const a = r[k], b = r[(k + 1) % r.length];
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 0.01) continue;
        const nx_ = dz / len, nz_ = -dx / len;
        const b0 = put(a[0], minH, a[1], nx_, 0, nz_, u, minH, wall);
        const b1 = put(b[0], minH, b[1], nx_, 0, nz_, u + len, minH, wall);
        const t1 = put(b[0], h, b[1], nx_, 0, nz_, u + len, h, wall);
        const t0 = put(a[0], h, a[1], nx_, 0, nz_, u, h, wall);
        IX[mb.icount++] = b0; IX[mb.icount++] = t1; IX[mb.icount++] = b1;
        IX[mb.icount++] = b0; IX[mb.icount++] = t0; IX[mb.icount++] = t1;
        u += len;
      }
    }
    const start = mb.count;
    for (let k = 0; k < flatRoof.length; k += 2) put(flatRoof[k], h, flatRoof[k + 1], 0, 1, 0, flatRoof[k], flatRoof[k + 1], roof);
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k], b = tris[k + 1], c = tris[k + 2];
      const ax = flatRoof[a * 2], az = flatRoof[a * 2 + 1];
      const cross = (flatRoof[b * 2 + 1] - az) * (flatRoof[c * 2] - ax) - (flatRoof[b * 2] - ax) * (flatRoof[c * 2 + 1] - az);
      if (cross >= 0) { IX[mb.icount++] = start + a; IX[mb.icount++] = start + b; IX[mb.icount++] = start + c; }
      else { IX[mb.icount++] = start + a; IX[mb.icount++] = start + c; IX[mb.icount++] = start + b; }
    }
  }
  const tiles = [...tileMap.values()].map((t) => ({
    key: t.key, cx: t.x0 + TILE / 2, cz: t.z0 + TILE / 2, maxH: t.maxH,
    major: t.nMajor ? t.major.finish() : null, minor: t.nMinor ? t.minor.finish() : null,
  }));
  return { tiles, info, ids, names };
}

// ---------------------------------------------------------------- lines → ribbons
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}
function cumulative(pts) {
  const s = [0];
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return s;
}
// Elevation profile: ground-following, or a straight deck between the bridge ends.
function profile(pts, hf, bridge, deckAbove, rampLen = 60) {
  const s = cumulative(pts);
  const L = s[s.length - 1] || 1;
  const ground = pts.map((p) => hf.at(p[0], p[1]));
  if (!bridge) return { s, L, elev: ground, off: pts.map(() => 0), ground };
  const e0 = ground[0], e1 = ground[ground.length - 1];
  const elev = s.map((d) => e0 + ((e1 - e0) * d) / L);
  const off = s.map((d) => deckAbove * Math.min(1, d / rampLen, (L - d) / rampLen));
  // Keep decks clear of the ground they cross.
  for (let i = 0; i < elev.length; i++) if (elev[i] + off[i] < ground[i] + 0.3) off[i] = ground[i] + 0.3 - elev[i];
  return { s, L, elev, off, ground };
}

const RIBBON_SPEC = { position: [Float32Array, 3], elev: [Float32Array, 1], wuv: [Float32Array, 2], rinfo: [Uint8Array, 3] };
const STRUCT_SPEC = { position: [Float32Array, 3], normal: [Int8Array, 3], elev: [Float32Array, 1] };

function ribbon(mb, pts, prof, width, yOff, cls, flags, caps) {
  const n = pts.length;
  const half = width / 2;
  mb.reserve(n * 2 + (caps ? 2 * 10 : 0), (n - 1) * 6 + (caps ? 2 * 24 : 0));
  const P = mb.arrays.position, E = mb.arrays.elev, U = mb.arrays.wuv, R = mb.arrays.rinfo, IX = mb.index;
  const put = (x, y, z, e, u, v) => {
    const i = mb.count++;
    P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; E[i] = e; U[i * 2] = u; U[i * 2 + 1] = v;
    R[i * 3] = cls; R[i * 3 + 1] = flags; R[i * 3 + 2] = Math.min(255, Math.round(width * 4));
    return i;
  };
  const first = mb.count;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let tx = b[0] - a[0], tz = b[1] - a[1];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    let nx = -tz, nz = tx;
    let scale = 1;
    if (i > 0 && i < n - 1) {
      // Miter join, limited.
      const d0x = p[0] - a[0], d0z = p[1] - a[1], l0 = Math.hypot(d0x, d0z) || 1;
      const n0x = -d0z / l0, n0z = d0x / l0;
      const dot = n0x * nx + n0z * nz;
      scale = 1 / Math.max(0.5, dot);
    }
    const y = yOff + prof.off[i];
    put(p[0] + nx * half * scale, y, p[1] + nz * half * scale, prof.elev[i], prof.s[i], -1);
    put(p[0] - nx * half * scale, y, p[1] - nz * half * scale, prof.elev[i], prof.s[i], 1);
    if (i > 0) {
      const k = first + i * 2;
      IX[mb.icount++] = k - 2; IX[mb.icount++] = k; IX[mb.icount++] = k - 1;
      IX[mb.icount++] = k - 1; IX[mb.icount++] = k; IX[mb.icount++] = k + 1;
    }
  }
  if (caps) {
    for (const end of [0, n - 1]) {
      const p = pts[end], q = pts[end === 0 ? 1 : n - 2];
      let dx = p[0] - q[0], dz = p[1] - q[1];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      const y = yOff + prof.off[end] - 0.005;
      const c = put(p[0], y, p[1], prof.elev[end], prof.s[end], 0);
      const seg = 8;
      const start = mb.count;
      for (let k = 0; k <= seg; k++) {
        const ang = -Math.PI / 2 + (Math.PI * k) / seg;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        // rotate direction (dx,dz) by ang
        const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
        put(p[0] + rx * half, y, p[1] + rz * half, prof.elev[end], prof.s[end], Math.sin(ang));
      }
      for (let k = 0; k < seg; k++) {
        IX[mb.icount++] = c; IX[mb.icount++] = start + k + 1; IX[mb.icount++] = start + k;
      }
    }
  }
}

// Box helper for structures (parapets, piers): 8 corners, flat normals via 24 verts.
function box(mb, corners, elevs) {
  // corners: 8 [x,y,z] (0-3 bottom ring, 4-7 top ring, CCW from above in math xz), elevs: 8 terrain elevations
  const faces = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7], [3, 2, 1, 0]];
  mb.reserve(24, 36);
  const P = mb.arrays.position, Nn = mb.arrays.normal, E = mb.arrays.elev, IX = mb.index;
  for (const f of faces) {
    const [a, b, c] = f.map((k) => corners[k]);
    let ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    let vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    // Faces are wound clockwise-from-outside in this corner order, so flip the cross product.
    let nx = -(uy * vz - uz * vy), ny = -(uz * vx - ux * vz), nz = -(ux * vy - uy * vx);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const s = mb.count;
    for (const k of f) {
      const i = mb.count++;
      P[i * 3] = corners[k][0]; P[i * 3 + 1] = corners[k][1]; P[i * 3 + 2] = corners[k][2];
      Nn[i * 3] = nx * 127; Nn[i * 3 + 1] = ny * 127; Nn[i * 3 + 2] = nz * 127;
      E[i] = elevs[k];
    }
    IX[mb.icount++] = s; IX[mb.icount++] = s + 2; IX[mb.icount++] = s + 1;
    IX[mb.icount++] = s; IX[mb.icount++] = s + 3; IX[mb.icount++] = s + 2;
  }
}
function orientBox(mb, cx, cz, dirx, dirz, len, wid, y0, y1, e0, e1) {
  const hx = (dirx * len) / 2, hz = (dirz * len) / 2;
  const wx = (-dirz * wid) / 2, wz = (dirx * wid) / 2;
  const ring = [[cx - hx - wx, cz - hz - wz], [cx + hx - wx, cz + hz - wz], [cx + hx + wx, cz + hz + wz], [cx - hx + wx, cz - hz + wz]];
  // Ensure CCW (math) for outward normals.
  const a = shoelace(ring);
  if (a < 0) ring.reverse();
  const corners = [...ring.map((p) => [p[0], y0, p[1]]), ...ring.map((p) => [p[0], y1, p[1]])];
  box(mb, corners, [e0, e0, e0, e0, e1, e1, e1, e1]);
}

// Deck edges, underside and piers for elevated segments.
function structureAlong(mb, pts, prof, width, deckThick, parapet, pierEvery, pierWidth) {
  const n = pts.length;
  for (let i = 1; i < n; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.2) continue;
    const ux = dx / len, uz = dz / len;
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    const off = (prof.off[i - 1] + prof.off[i]) / 2;
    const e = (prof.elev[i - 1] + prof.elev[i]) / 2;
    if (off < 1.2) continue;
    // Deck slab (below the ribbon) and parapets.
    orientBox(mb, mx, mz, ux, uz, len + 0.3, width + 0.6, off - deckThick, off - 0.02, e, e);
    if (parapet) {
      for (const side of [-1, 1]) {
        const ox = -uz * side * (width / 2 + 0.15), oz = ux * side * (width / 2 + 0.15);
        orientBox(mb, mx + ox, mz + oz, ux, uz, len + 0.3, 0.3, off - 0.05, off + parapet, e, e);
      }
    }
  }
  // Piers.
  if (!pierEvery) return;
  for (let d = pierEvery / 2; d < prof.L; d += pierEvery) {
    let i = 1;
    while (i < prof.s.length - 1 && prof.s[i] < d) i++;
    const t = (d - prof.s[i - 1]) / Math.max(0.001, prof.s[i] - prof.s[i - 1]);
    const x = pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z = pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t;
    const off = prof.off[i - 1] + (prof.off[i] - prof.off[i - 1]) * t;
    const e = prof.elev[i - 1] + (prof.elev[i] - prof.elev[i - 1]) * t;
    const g = prof.ground[i - 1] + (prof.ground[i] - prof.ground[i - 1]) * t;
    if (off < 3) continue;
    const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1], l = Math.hypot(dx, dz) || 1;
    orientBox(mb, x, z, dx / l, dz / l, pierWidth, pierWidth, -3, off - 0.5, g, e);
    // relative bottom sits on ground (elev g), top at deck (elev e)
  }
}

function buildRoads(list, hf) {
  const mesh = new MeshBuilder(RIBBON_SPEC);
  const structure = new MeshBuilder(STRUCT_SPEC);
  const labelsByName = new Map();
  const carPaths = [];
  // Draw low classes first (so larger roads end on top in index order too).
  const sorted = list.slice().sort((a, b) => ROAD_ORDER.indexOf(a[1]) - ROAD_ORDER.indexOf(b[1]));
  for (const [id, cls, width, name, bridge, layer, tunnel, oneway, flat] of sorted) {
    if (tunnel) continue;
    const rank = ROAD_ORDER.indexOf(cls);
    const pts = densify(toRing(flat), 18);
    if (pts.length < 2) continue;
    const deck = bridge ? 1.5 + Math.max(0, layer) * 5.5 : 0;
    const prof = profile(pts, hf, !!bridge, deck, Math.min(70, 15 + deck * 8));
    const yOff = 0.12 + rank * 0.028;
    ribbon(mesh, pts, prof, width, yOff, rank, bridge ? 1 : 0, rank >= 5 && !bridge);
    if (bridge) structureAlong(structure, pts, prof, width, 1.3, 1.0, rank >= 8 ? 32 : 0, 1.6);
    if (name && rank >= 8) {
      const e = labelsByName.get(name) || { name, rank, segs: [] };
      e.rank = Math.max(e.rank, rank);
      e.segs.push({ pts, len: prof.L, bridge });
      labelsByName.set(name, e);
    }
    if (rank >= 11 && prof.L > 120) {
      const arr = new Float32Array(pts.length * 4);
      pts.forEach((p, i) => { arr[i * 4] = p[0]; arr[i * 4 + 1] = p[1]; arr[i * 4 + 2] = prof.elev[i]; arr[i * 4 + 3] = yOff + prof.off[i] + 0.1; });
      carPaths.push({ pts: arr, len: prof.L, rank, oneway: !!oneway, width });
    }
  }
  // Label anchors: long named roads get one label per ~1.4 km of mapped length.
  const labels = [];
  const names = [];
  for (const e of labelsByName.values()) {
    const total = e.segs.reduce((s, x) => s + x.len, 0);
    const longest = e.segs.reduce((m, x) => (x.len > m.len ? x : m));
    const mid = longest.pts[Math.floor(longest.pts.length / 2)];
    names.push({ name: e.name, x: mid[0], z: mid[1], len: total, rank: e.rank, bridge: e.segs.some((s) => s.bridge) });
    if (total < 350 || e.rank < 11) continue;
    const segs = e.segs.filter((s) => s.len > 150).sort((a, b) => b.len - a.len);
    const want = Math.max(1, Math.min(5, Math.round(total / 1400)));
    const chosen = [];
    for (const s of segs) {
      const m = s.pts[Math.floor(s.pts.length / 2)];
      if (chosen.every((c) => Math.hypot(c[0] - m[0], c[1] - m[1]) > 900)) chosen.push(m);
      if (chosen.length >= want) break;
    }
    for (const m of chosen) labels.push({ name: e.name, x: m[0], z: m[1], rank: e.rank });
  }
  return { mesh: mesh.finish(), structure: structure.finish(), labels, names, carPaths };
}

function buildRail(lines, hf) {
  const mesh = new MeshBuilder(RIBBON_SPEC);
  const structure = new MeshBuilder(STRUCT_SPEC);
  const metro = [];
  for (const [id, kind, bridge, layer, name, service, usage, flat] of lines) {
    if (kind === 'platform' || kind.startsWith('construction')) continue;
    const pts = densify(toRing(flat), 15);
    if (pts.length < 2) continue;
    const isMetro = kind === 'subway' || kind === 'light_rail';
    if (isMetro) {
      // Pune Metro runs mostly on a viaduct; bridged metro ways are drawn elevated,
      // underground stretches (negative layer) are skipped.
      const elevated = bridge || layer > 0;
      if (!elevated && layer < 0) continue;
      const prof = profile(pts, hf, false, 0);
      if (elevated) prof.off = prof.off.map(() => 12.5);
      ribbon(mesh, pts, prof, 4.2, 0.2, 21, elevated ? 3 : 2, false);
      if (elevated) structureAlong(structure, pts, prof, 4.2, 1.6, 1.1, 30, 2.2);
      const arr = new Float32Array(pts.length * 4);
      pts.forEach((p, i) => { arr[i * 4] = p[0]; arr[i * 4 + 1] = p[1]; arr[i * 4 + 2] = prof.elev[i]; arr[i * 4 + 3] = 0.2 + prof.off[i] + 0.2; });
      metro.push({ pts: arr, len: prof.L, name: name || '' });
    } else {
      const prof = profile(pts, hf, !!bridge, bridge ? 2 + Math.max(0, layer) * 5 : 0);
      ribbon(mesh, pts, prof, service ? 3.6 : 4.4, 0.3, 20, bridge ? 1 : 0, false);
      if (bridge) structureAlong(structure, pts, prof, 4.4, 1.5, 0.6, 28, 1.8);
    }
  }
  // Chain metro ways into continuous runs for the train animation.
  return { mesh: mesh.finish(), structure: structure.finish(), metroPaths: chainPaths(metro) };
}

function chainPaths(paths) {
  const key = (a, i) => Math.round(a[i * 4] / 3) + ':' + Math.round(a[i * 4 + 1] / 3);
  const pool = paths.map((p) => ({ ...p, n: p.pts.length / 4 }));
  const out = [];
  while (pool.length) {
    let cur = pool.shift();
    let pts = Array.from(cur.pts);
    let grew = true;
    while (grew) {
      grew = false;
      const endK = key(pts, pts.length / 4 - 1), startK = key(pts, 0);
      for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        const a = Array.from(p.pts), n = p.n;
        const ps = key(a, 0), pe = key(a, n - 1);
        const rev = (arr) => { const r = []; for (let k = arr.length / 4 - 1; k >= 0; k--) r.push(arr[k * 4], arr[k * 4 + 1], arr[k * 4 + 2], arr[k * 4 + 3]); return r; };
        if (ps === endK) pts = pts.concat(a.slice(4));
        else if (pe === endK) pts = pts.concat(rev(a).slice(4));
        else if (pe === startK) pts = a.concat(pts.slice(4));
        else if (ps === startK) pts = rev(a).concat(pts.slice(4));
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    let len = 0;
    for (let k = 1; k < pts.length / 4; k++) len += Math.hypot(pts[k * 4] - pts[k * 4 - 4], pts[k * 4 + 1] - pts[k * 4 - 3]);
    if (len > 800) out.push({ pts: new Float32Array(pts), len });
  }
  return out;
}

// ---------------------------------------------------------------- water
function buildWater(water, hf) {
  const mb = new MeshBuilder({ position: [Float32Array, 3], elev: [Float32Array, 1] });
  const labels = [];
  const hasRiverPoly = water.polys.some((p) => p[1] === 'river' || p[1] === 'riverbank');
  for (const [id, kind, name, ringsFlat] of water.polys) {
    const rings = ringsFlat.map(toRing);
    // Subdivide long edges so the surface follows the valley level smoothly.
    const dens = rings.map((r) => densify([...r, r[0]], 40).slice(0, -1));
    const flat = [], holes = [];
    let acc = 0;
    dens.forEach((r, k) => { if (k) holes.push(acc); for (const p of r) flat.push(p[0], p[1]); acc += r.length; });
    const tris = earcut(flat, holes.length ? holes : undefined, 2);
    mb.reserve(acc, tris.length);
    const s = mb.count;
    for (let k = 0; k < flat.length; k += 2) {
      const i = mb.count++;
      mb.arrays.position[i * 3] = flat[k]; mb.arrays.position[i * 3 + 1] = 0; mb.arrays.position[i * 3 + 2] = flat[k + 1];
      mb.arrays.elev[i] = hf.waterAt(flat[k], flat[k + 1]);
    }
    for (let k = 0; k < tris.length; k += 3) {
      const a = tris[k], b = tris[k + 1], c = tris[k + 2];
      const ax = flat[a * 2], az = flat[a * 2 + 1];
      const cross = (flat[b * 2 + 1] - az) * (flat[c * 2] - ax) - (flat[b * 2] - ax) * (flat[c * 2 + 1] - az);
      if (cross >= 0) { mb.index[mb.icount++] = s + a; mb.index[mb.icount++] = s + b; mb.index[mb.icount++] = s + c; }
      else { mb.index[mb.icount++] = s + a; mb.index[mb.icount++] = s + c; mb.index[mb.icount++] = s + b; }
    }
  }
  for (const [id, kind, w, name, tunnel, flat] of water.lines) {
    if (tunnel || (kind === 'river' && hasRiverPoly)) {
      if (kind === 'river' && name) {
        const pts = toRing(flat);
        for (let i = Math.floor(pts.length / 4); i < pts.length; i += Math.max(1, Math.floor(pts.length / 3))) labels.push({ name, x: pts[i][0], z: pts[i][1] });
      }
      continue;
    }
    const pts = densify(toRing(flat), 20);
    if (pts.length < 2) continue;
    const n = pts.length;
    mb.reserve(n * 2, (n - 1) * 6);
    const s = mb.count;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], tz = b[1] - a[1];
      const l = Math.hypot(tx, tz) || 1;
      const nx = (-tz / l) * (w / 2), nz = (tx / l) * (w / 2);
      const lvl = Math.min(hf.waterAt(pts[i][0], pts[i][1]), hf.at(pts[i][0], pts[i][1]) - 0.3);
      for (const sgn of [1, -1]) {
        const k = mb.count++;
        mb.arrays.position[k * 3] = pts[i][0] + nx * sgn; mb.arrays.position[k * 3 + 1] = 0; mb.arrays.position[k * 3 + 2] = pts[i][1] + nz * sgn;
        mb.arrays.elev[k] = lvl;
      }
      if (i > 0) {
        const k = s + i * 2;
        mb.index[mb.icount++] = k - 2; mb.index[mb.icount++] = k; mb.index[mb.icount++] = k - 1;
        mb.index[mb.icount++] = k - 1; mb.index[mb.icount++] = k; mb.index[mb.icount++] = k + 1;
      }
    }
  }
  return { mesh: mb.finish(), labels };
}

// ---------------------------------------------------------------- trees
function buildTrees(trees, density, ext) {
  const { c } = density;
  const W = c.width, H = c.height;
  const px = density.ctx.getImageData(0, 0, W, H).data;
  const rnd = mulberry(1234);
  const out = [];
  const add = (x, z, type, s) => out.push(x, z, s, type);
  // Mapped trees from OSM first.
  for (let i = 0; i < trees.pts.length; i += 2) add(trees.pts[i] / 10, trees.pts[i + 1] / 10, rnd() < 0.15 ? 2 : rnd() < 0.5 ? 0 : 1, 0.9 + rnd() * 0.5);
  for (const flat of trees.rows) {
    const pts = densify(toRing(flat), 8);
    for (const p of pts) add(p[0], p[1], rnd() < 0.5 ? 0 : 1, 0.8 + rnd() * 0.4);
  }
  const step = 6;
  const sx = W / (ext.maxX - ext.minX), sz = H / (ext.maxZ - ext.minZ);
  for (let z = ext.minZ; z < ext.maxZ; z += step)
    for (let x = ext.minX; x < ext.maxX; x += step) {
      const jx = x + rnd() * step, jz = z + rnd() * step;
      const ix = Math.floor((jx - ext.minX) * sx), iz = Math.floor((jz - ext.minZ) * sz);
      if (ix < 0 || iz < 0 || ix >= W || iz >= H) continue;
      const d = px[(iz * W + ix) * 4] / 255;
      if (d <= 0 || rnd() > d) continue;
      // Clumping: modulate by low-frequency noise so groves form.
      const clump = 0.55 + 0.45 * Math.sin(jx * 0.013 + Math.sin(jz * 0.011) * 2) * Math.cos(jz * 0.017 - jx * 0.004);
      if (rnd() > clump) continue;
      const r = rnd();
      add(jx, jz, r < 0.1 ? 2 : r < 0.55 ? 0 : 1, 0.7 + rnd() * 0.7);
    }
  return new Float32Array(out);
}

// ---------------------------------------------------------------- terrain
function buildTerrain(hf, ext) {
  const { nx, nz, cell, minX, minZ, data } = hf;
  const n = nx * nz;
  const position = new Float32Array(n * 3), normal = new Int8Array(n * 3), uv = new Float32Array(n * 2), elev = new Float32Array(n);
  const W = ext.maxX - ext.minX, H = ext.maxZ - ext.minZ;
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const x = minX + i * cell, z = minZ + j * cell;
      position[k * 3] = x; position[k * 3 + 1] = 0; position[k * 3 + 2] = z;
      elev[k] = data[k];
      const hl = data[j * nx + Math.max(0, i - 1)], hr = data[j * nx + Math.min(nx - 1, i + 1)];
      const hd = data[Math.max(0, j - 1) * nx + i], hu = data[Math.min(nz - 1, j + 1) * nx + i];
      let gx = hl - hr, gz = hd - hu, gy = 2 * cell;
      const l = Math.hypot(gx, gy, gz);
      normal[k * 3] = (gx / l) * 127; normal[k * 3 + 1] = (gy / l) * 127; normal[k * 3 + 2] = (gz / l) * 127;
      uv[k * 2] = (x - ext.minX) / W; uv[k * 2 + 1] = (z - ext.minZ) / H;
    }
  const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let o = 0;
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      index[o++] = a; index[o++] = c; index[o++] = b;
      index[o++] = b; index[o++] = c; index[o++] = d;
    }
  return { count: n, attributes: { position, normal, uv, elev }, index };
}
