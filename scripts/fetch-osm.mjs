// Downloads raw OpenStreetMap data for the East Pune bounding box from Overpass,
// plus an elevation grid from the public AWS Terrain Tiles.
// Output: data/raw/*.json (not committed). Run `npm run data` to rebuild.
import fs from 'node:fs/promises';
import path from 'node:path';
import { BBOX } from './config.mjs';

const RAW = path.resolve('data/raw');
const UA = '5.5-map/1.0 (https://github.com/amitturare/5.5-map)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const force = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query, label) {
  for (let attempt = 0; attempt < 15; attempt++) {
    // Main instance is the most reliable; mirrors are tried occasionally.
    const url = attempt % 3 === 2 ? ENDPOINTS[1 + ((attempt / 3) | 0) % 2] : ENDPOINTS[0];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(240_000),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        const json = JSON.parse(text);
        if (json.remark && /runtime error/i.test(json.remark)) throw new Error(json.remark);
        return json;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.warn(`  [${label}] attempt ${attempt + 1} via ${new URL(url).host} failed: ${err.message.slice(0, 200)}`);
      await sleep(5000 + attempt * 3000);
    }
  }
  throw new Error(`Overpass failed for ${label}`);
}

const bboxStr = (b) => `${b.south},${b.west},${b.north},${b.east}`;

function tiles(n) {
  const out = [];
  const dLat = (BBOX.north - BBOX.south) / n;
  const dLon = (BBOX.east - BBOX.west) / n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      out.push({
        south: BBOX.south + i * dLat,
        north: BBOX.south + (i + 1) * dLat,
        west: BBOX.west + j * dLon,
        east: BBOX.west + (j + 1) * dLon,
      });
  return out;
}

const QUERIES = {
  highways: (b) => `[out:json][timeout:180];way["highway"](${bboxStr(b)});out geom tags;`,
  railways: (b) => `[out:json][timeout:180];(way["railway"](${bboxStr(b)});node["railway"~"station|halt"](${bboxStr(b)});node["public_transport"="station"](${bboxStr(b)}););out geom tags;`,
  water: (b) => `[out:json][timeout:180];(
    way["natural"="water"](${bboxStr(b)});relation["natural"="water"](${bboxStr(b)});
    way["waterway"](${bboxStr(b)});relation["waterway"="riverbank"](${bboxStr(b)});
    way["water"](${bboxStr(b)});
  );out geom tags;`,
  areas: (b) => `[out:json][timeout:180];(
    way["landuse"](${bboxStr(b)});relation["landuse"](${bboxStr(b)});
    way["leisure"](${bboxStr(b)});relation["leisure"](${bboxStr(b)});
    way["natural"~"wood|scrub|grassland|heath|wetland|sand|bare_rock"](${bboxStr(b)});
    relation["natural"~"wood|scrub|grassland|wetland"](${bboxStr(b)});
    way["aeroway"](${bboxStr(b)});
    way["amenity"~"school|college|university|hospital|parking|place_of_worship"](${bboxStr(b)});
    relation["amenity"~"school|college|university|hospital"](${bboxStr(b)});
    way["man_made"="bridge"](${bboxStr(b)});
  );out geom tags;`,
  trees: (b) => `[out:json][timeout:180];(node["natural"="tree"](${bboxStr(b)});way["natural"="tree_row"](${bboxStr(b)}););out geom tags;`,
  pois: (b) => `[out:json][timeout:180];(
    nwr["place"~"suburb|neighbourhood|quarter|locality"](${bboxStr(b)});
    nwr["name"]["wikidata"](${bboxStr(b)});
    nwr["name"]["tourism"](${bboxStr(b)});
    nwr["name"]["historic"](${bboxStr(b)});
    nwr["name"]["shop"="mall"](${bboxStr(b)});
    nwr["name"]["aeroway"~"aerodrome|terminal"](${bboxStr(b)});
    nwr["name"]["leisure"~"park|garden|stadium|golf_course|nature_reserve"](${bboxStr(b)});
    nwr["name"~"Kopa|KOPA|Phoenix|Osho",i](${bboxStr(b)});
  );out center tags;`,
};

async function saveOnce(name, fn) {
  const file = path.join(RAW, name + '.json');
  if (!force) {
    try {
      await fs.access(file);
      console.log(`✓ ${name} (cached)`);
      return;
    } catch {}
  }
  console.log(`↓ ${name}`);
  const data = await fn();
  await fs.writeFile(file, JSON.stringify(data));
  console.log(`✓ ${name}: ${data.elements?.length ?? data.elevation?.length} items`);
}

async function fetchBuildings() {
  const all = new Map();
  const ts = tiles(3);
  for (let i = 0; i < ts.length; i++) {
    const q = `[out:json][timeout:180];(way["building"](${bboxStr(ts[i])});relation["building"](${bboxStr(ts[i])});way["building:part"](${bboxStr(ts[i])}););out geom tags;`;
    const res = await overpass(q, `buildings ${i + 1}/${ts.length}`);
    for (const el of res.elements) all.set(el.type + el.id, el);
    console.log(`  tile ${i + 1}/${ts.length}: ${res.elements.length}`);
  }
  return { elements: [...all.values()] };
}

// Elevation from the public AWS Terrain Tiles (Terrarium encoding, SRTM-derived),
// resampled to a regular N x N grid over the bbox.
async function fetchElevation() {
  const { PNG } = await import('pngjs');
  const Z = 13;
  const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
  const lat2y = (lat) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
  const x0 = Math.floor(lon2x(BBOX.west)), x1 = Math.floor(lon2x(BBOX.east));
  const y0 = Math.floor(lat2y(BBOX.north)), y1 = Math.floor(lat2y(BBOX.south));
  const tiles = new Map();
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('terrain tile ' + url + ' ' + r.status);
      tiles.set(x + '/' + y, PNG.sync.read(Buffer.from(await r.arrayBuffer())));
    }
  const px = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(tx + '/' + ty);
    const i = ((gy - ty * 256) * 256 + (gx - tx * 256)) * 4;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  const N = 128;
  const elev = [];
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const lat = BBOX.south + ((BBOX.north - BBOX.south) * i) / (N - 1);
      const lon = BBOX.west + ((BBOX.east - BBOX.west) * j) / (N - 1);
      const fx = lon2x(lon) * 256 - 0.5, fy = lat2y(lat) * 256 - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const v = px(ix, iy) * (1 - tx) * (1 - ty) + px(ix + 1, iy) * tx * (1 - ty) + px(ix, iy + 1) * (1 - tx) * ty + px(ix + 1, iy + 1) * tx * ty;
      elev.push(+v.toFixed(2));
    }
  // Row-major, row 0 = south edge, column 0 = west edge.
  return { n: N, bbox: BBOX, elevation: elev, source: 'AWS Terrain Tiles (SRTM, Terrarium z13)' };
}

await fs.mkdir(RAW, { recursive: true });
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const jobs = {};
for (const [name, q] of Object.entries(QUERIES)) jobs[name] = () => overpass(q(BBOX), name);
jobs.buildings = fetchBuildings;
jobs.elevation = fetchElevation;
for (const [name, fn] of Object.entries(jobs)) if (!only || only === name) await saveOnce(name, fn);
console.log('done');
