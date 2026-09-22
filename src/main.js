import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import BuildWorker from './world/build.worker.js?worker';
import { U } from './world/materials.js';
import { Atmosphere, solarPosition, sunTimes } from './world/sky.js';
import { City } from './world/city.js';
import { Life } from './world/life.js';
import { CATEGORY } from './world/palette.js';
import { CameraRig } from './camera.js';
import { Labels } from './ui/labels.js';
import { InfoPanel } from './ui/panel.js';
import { Search } from './ui/search.js';
import { unproject } from '../scripts/config.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const BASE = import.meta.env.BASE_URL;

// ------------------------------------------------------------------ renderer
const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', reversedDepthBuffer: !params.has('noreverse') });
const reversed = renderer.capabilities.reversedDepthBuffer;
let pixelRatio = Math.min(window.devicePixelRatio, 1.75);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = params.has('vsm') ? THREE.VSMShadowMap : params.has('basic') ? THREE.BasicShadowMap : THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 1, 150000);
camera.position.set(-2500, 9000, 12000);
camera.lookAt(0, 0, 0);

const atmosphere = new Atmosphere(renderer, scene);

const rt = new THREE.WebGLRenderTarget(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.setPixelRatio(pixelRatio);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.3, 0.55, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ------------------------------------------------------------------ loading
const loaderFill = $('loader-fill'), loaderStep = $('loader-step');
const setProgress = (p, step) => { loaderFill.style.width = (p * 100).toFixed(1) + '%'; if (step) loaderStep.textContent = step; };

const placesP = fetch(BASE + 'data/places.json').then((r) => r.json());
const worker = new BuildWorker();
const built = new Promise((resolve, reject) => {
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') setProgress(m.p * 0.92, m.step);
    else if (m.type === 'done') resolve(m);
    else if (m.type === 'error') reject(new Error(m.message));
  };
  worker.onerror = (e) => reject(e);
});
const abs = (p) => new URL(BASE + p, location.href).href;
worker.postMessage({ worldUrl: abs('data/world.json'), buildingsUrl: abs('data/buildings.json') });

let city, life, labels, rig, panel;
const markers = new THREE.Group();
scene.add(markers);

async function init() {
  const [data, places] = await Promise.all([built, placesP]);
  worker.terminate();
  setProgress(0.93, 'Assembling the scene');
  await new Promise((r) => setTimeout(r, 20));
  city = new City(scene, data);
  life = new Life(scene, data, city.hf);
  rig = new CameraRig(camera, canvas, (x, z) => city.ground(x, z));
  labels = new Labels($('labels'), camera, (x, z) => city.ground(x, z));
  panel = new InfoPanel($('info'), $('info-body'), $('info-close'));
  panel.onClose = () => selectLandmark(null);

  setupLandmarks(data, places);
  setupUI(data);
  setTime(initialHour());

  setProgress(0.97, 'Compiling shaders');
  try { await renderer.compileAsync(scene, camera); } catch {}
  setProgress(1, 'Ready');
  $('loader').classList.add('done');
  resetView(3.2);
  loop();
}
init().catch((err) => {
  console.error(err);
  loaderStep.textContent = 'Failed to build the city: ' + err.message;
});

// ------------------------------------------------------------------ landmarks
const LM = { list: [], byBuilding: new Map(), labelById: new Map(), markerById: new Map() };
let selectedId = null;

function catFor(poi) {
  const c = poi.cat;
  if (c === 'mall') return 'mall';
  if (c === 'historic' || c.startsWith('tourism:museum') || c.startsWith('tourism:attraction')) return 'heritage';
  if (c === 'amenity:place_of_worship') return 'religious';
  if (c === 'amenity:hospital' || c === 'amenity:clinic' || c === 'amenity:prison' || c === 'amenity:post_office') return 'civic';
  if (c === 'amenity:college' || c === 'amenity:school' || c === 'amenity:university') return 'education';
  if (c.startsWith('leisure:')) return 'park';
  if (c === 'transit') return 'transit';
  return null;
}

function setupLandmarks(data, places) {
  const idIndex = new Map(city.bIds.map((id, i) => [id, i]));
  const curated = places.landmarks.filter((l) => l.resolved);
  const near = (a, b, d) => Math.hypot(a.x - b.x, a.z - b.z) < d;
  const all = curated.map((l) => ({ ...l, curated: true }));
  // Other significant places that OSM links to Wikidata.
  for (const p of places.pois) {
    const cat = catFor(p);
    if (!cat || !p.wikidata) continue;
    if (all.some((l) => (l.wikidata && l.wikidata === p.wikidata) || (near(l, p, 250) && l.name.split(' ')[0] === p.name.split(' ')[0]))) continue;
    all.push({ id: 'osm-' + p.id, name: p.name, category: cat, x: p.x, z: p.z, wikidata: p.wikidata, importance: 3, osm: osmPath(p.id) });
  }
  for (const s of places.stations) {
    if (!s.subway) continue;
    if (all.some((l) => near(l, s, 300) && l.category === 'transit')) continue;
    all.push({ id: 'st-' + s.id, name: s.name.replace(/ Metro Station$/i, '') + ' Metro', category: 'transit', x: s.x, z: s.z, wikidata: s.wikidata, importance: 3, osm: osmPath(s.id) });
  }
  for (const l of all) {
    if (l.footprint && idIndex.has(l.footprint)) {
      l.bindex = idIndex.get(l.footprint);
      LM.byBuilding.set(l.bindex, l);
      if (!l.osm) l.osm = osmPath(l.footprint);
    }
    const bh = l.bindex != null ? city.bInfo.h[l.bindex] : 0;
    const cat = CATEGORY[l.category] || CATEGORY.civic;
    LM.list.push(l);
    if (l.category === 'neighbourhood') {
      l.labelY = 90;
      LM.labelById.set(l.id, labels.add({ html: esc(l.name), cls: 'hood big click', x: l.x, z: l.z, y: 90, priority: 9, near: 350, far: 16000, group: 'landmarks', onClick: () => openLandmark(l) }));
      continue;
    }
    if (l.category === 'road') {
      l.labelY = 12;
      LM.labelById.set(l.id, labels.add({ html: esc(l.name), cls: 'road click', x: l.x, z: l.z, y: 12, priority: 6, far: 7000, group: 'landmarks', onClick: () => openLandmark(l) }));
      continue;
    }
    if (l.category === 'river') {
      l.labelY = 6;
      LM.labelById.set(l.id, labels.add({ html: esc(l.name), cls: 'water click', x: l.x, z: l.z, y: 6, priority: 8, far: 12000, group: 'landmarks', onClick: () => openLandmark(l) }));
      continue;
    }
    const imp = l.importance || 3;
    const y = Math.max(imp === 1 ? 70 : 48, bh + 28);
    l.labelY = y;
    const html = `<span class="pin" style="background:${cat.color};color:#111">${cat.icon}</span>${esc(l.name)}`;
    LM.labelById.set(l.id, labels.add({ html, cls: 'lm' + (imp >= 3 ? ' minor' : ''), x: l.x, z: l.z, y, priority: 10 - imp, far: imp === 1 ? 14000 : imp === 2 ? 7000 : 3200, group: 'landmarks', onClick: () => openLandmark(l), title: l.tagline || '' }));
    if (imp <= 2) addMarker(l, y, cat.color);
  }
  // Neighbourhood names that aren't curated landmarks.
  const hoodNames = new Set(LM.list.filter((l) => l.category === 'neighbourhood').map((l) => l.name.toLowerCase()));
  for (const p of places.pois) {
    if (!p.cat.startsWith('place:')) continue;
    if (!['place:suburb', 'place:neighbourhood', 'place:quarter'].includes(p.cat) && !p.wikidata) continue;
    if (/society|housing|apartment|complex|residency|heights/i.test(p.name)) continue;
    if (hoodNames.has(p.name.toLowerCase())) continue;
    hoodNames.add(p.name.toLowerCase());
    const l = { id: 'place-' + p.id, name: p.name, category: 'neighbourhood', x: p.x, z: p.z, wikidata: p.wikidata, importance: 3, osm: osmPath(p.id) };
    LM.list.push(l);
    LM.labelById.set(l.id, labels.add({ html: esc(p.name), cls: 'hood click', x: p.x, z: p.z, y: 70, priority: 5, near: 300, far: 9000, group: 'landmarks', onClick: () => openLandmark(l) }));
  }
  // Roads and river names from the map itself.
  const curatedRoads = LM.list.filter((l) => l.category === 'road').map((l) => l.name.toLowerCase());
  for (const r of data.roadLabels) {
    if (curatedRoads.some((n) => r.name.toLowerCase().includes(n.split(' ')[0]) && r.name.toLowerCase().includes('road') && n.includes(r.name.toLowerCase().split(' ')[0]))) continue;
    labels.add({ html: esc(r.name), cls: 'road', x: r.x, z: r.z, y: 8, priority: 3 + r.rank / 10, far: r.rank >= 15 ? 4200 : 2600, group: 'roads' });
  }
  const river = LM.list.find((l) => l.category === 'river');
  for (const w of data.waterLabels) {
    if (river && Math.hypot(w.x - river.x, w.z - river.z) < 1500) continue;
    labels.add({ html: esc(w.name), cls: 'water click', x: w.x, z: w.z, y: 5, priority: 4, far: 9000, group: 'landmarks', onClick: river && /mutha|mula/i.test(w.name) ? () => openLandmark(river) : null });
  }
  for (const a of data.areaNames) {
    if (/^[a-z]/.test(a.name) || a.name.length < 4) continue; // generic/untidy names like "forest"
    if (LM.list.some((l) => Math.hypot(l.x - a.x, l.z - a.z) < 300)) continue;
    labels.add({ html: `<span class="pin" style="background:${CATEGORY.park.color};color:#111">${CATEGORY.park.icon}</span>${esc(a.name)}`, cls: 'lm minor', x: a.x, z: a.z, y: 30, priority: 2, far: 2200, group: 'landmarks' });
  }
  LM.roadNames = data.roadNames;
  LM.runways = data.runways;
}

const osmPath = (id) => ({ n: 'node/', w: 'way/', r: 'relation/' }[id[0]] + id.slice(1));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function addMarker(l, y, color) {
  const col = new THREE.Color(color);
  const g = new THREE.Group();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.9, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  );
  beam.position.y = 0.5;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(10, 13, 48),
    new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }),
  );
  ring.rotation.x = -Math.PI / 2;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 8), new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(2.2) }));
  g.add(beam, ring, dot);
  g.userData = { l, y, beam, ring, dot, phase: Math.random() * 6 };
  markers.add(g);
  LM.markerById.set(l.id, g);
}

function updateMarkers(time) {
  const cp = camera.position;
  for (const g of markers.children) {
    const { l, y, beam, ring, dot, phase } = g.userData;
    const base = city.ground(l.x, l.z);
    g.position.set(l.x, base, l.z);
    const d = Math.hypot(l.x - cp.x, l.z - cp.z, base - cp.y);
    const s = THREE.MathUtils.clamp(d / 900, 0.6, 7);
    const top = y - 8;
    beam.scale.set(s * 0.6, top, s * 0.6);
    beam.position.y = top / 2;
    dot.position.y = top;
    dot.scale.setScalar(s * 0.8);
    const k = (time * 0.6 + phase) % 1;
    ring.scale.setScalar((0.6 + k * 1.6) * Math.max(1, s * 0.7));
    ring.material.opacity = (1 - k) * 0.65;
    ring.position.y = 1.5;
    const sel = l.id === selectedId;
    beam.material.opacity = sel ? 0.9 : 0.35 + U.uNight.value * 0.3;
  }
}

function selectLandmark(l) {
  if (selectedId && LM.labelById.get(selectedId)) LM.labelById.get(selectedId).el.classList.remove('sel');
  selectedId = l ? l.id : null;
  if (l && LM.labelById.get(l.id)) LM.labelById.get(l.id).el.classList.add('sel');
  U.uSelected.value = l && l.bindex != null ? l.bindex + 1 : -1;
}

function mapFacts(l) {
  const out = [];
  const info = city.bInfo;
  const R = l.category === 'neighbourhood' ? 700 : l.category === 'airport' ? 1500 : 400;
  let n = 0, real = 0, tallest = -1;
  for (let i = 0; i < info.cx.length; i++) {
    const dx = info.cx[i] - l.x, dz = info.cz[i] - l.z;
    if (dx * dx + dz * dz > R * R) continue;
    n++;
    if (info.src[i] < 2) { real++; if (tallest < 0 || info.h[i] > info.h[tallest]) tallest = i; }
  }
  const asl = Math.round(city.hf.at(l.x, l.z) + city.data.demBase);
  if (n) out.push(`<b>${n.toLocaleString('en-IN')}</b> building footprints are mapped within ${R >= 1000 ? R / 1000 + ' km' : R + ' m'}; only <b>${real}</b> carry real height or floor data in OpenStreetMap.`);
  if (tallest >= 0 && info.h[tallest] > 15) out.push(`Tallest nearby building with mapped height: <b>${Math.round(info.h[tallest])} m</b>${city.bNames[tallest] ? ` (${esc(city.bNames[tallest])})` : ''}.`);
  out.push(`Ground level here: about <b>${asl} m</b> above sea level (SRTM elevation).`);
  if (l.category === 'road') {
    const key = l.name.toLowerCase().replace(/ road$/, '').split(/[ /]/)[0];
    const segs = (LM.roadNames || []).filter((r) => r.name.toLowerCase().includes(key));
    const len = segs.reduce((s, r) => s + r.len, 0);
    if (len > 300) out.push(`About <b>${(len / 1000).toFixed(1)} km</b> of carriageway named like “${esc(l.name)}” is mapped inside this model.`);
  }
  if (l.category === 'airport' && LM.runways?.length) {
    const r = LM.runways[0];
    const L = Math.hypot(r[r.length - 2] - r[0], r[r.length - 1] - r[1]);
    out.push(`The mapped runway centreline measures about <b>${(L / 1000).toFixed(2)} km</b>.`);
  }
  const airport = LM.list.find((x) => x.id === 'pune-airport');
  if (airport && l.id !== airport.id && l.category !== 'airport') {
    const d = Math.hypot(airport.x - l.x, airport.z - l.z) / 1000;
    if (d < 12) out.push(`${d.toFixed(1)} km from the airport terminal as the crow flies.`);
  }
  out.latlon = unproject(l.x, l.z);
  return out;
}

function openLandmark(l, fly = true) {
  selectLandmark(l);
  panel.showLandmark(l, mapFacts(l));
  if (!fly) return;
  const bh = l.bindex != null ? city.bInfo.h[l.bindex] : 20;
  const dist = { neighbourhood: 1500, river: 2200, airport: 2800, road: 1500, park: 700 }[l.category] || Math.max(380, bh * 5);
  const target = new THREE.Vector3(l.x, city.ground(l.x, l.z) + Math.min(bh, 40) * 0.4, l.z);
  rig.flyTo(target, { distance: dist, polar: l.category === 'neighbourhood' ? 50 : 60 });
}

function openBuilding(i) {
  const b = city.buildingRecord(i);
  selectLandmark(null);
  U.uSelected.value = i + 1;
  panel.showBuilding(b, { asl: city.hf.at(b.x, b.z) + city.data.demBase });
}

// ------------------------------------------------------------------ picking
const pickRT = new THREE.WebGLRenderTarget(1, 1);
const pickBuf = new Uint8Array(4);
function pick(x, y) {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  camera.setViewOffset(w, h, x, y, 1, 1);
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 1);
  renderer.setRenderTarget(pickRT);
  renderer.render(city.pickScene, camera);
  renderer.readRenderTargetPixels(pickRT, 0, 0, 1, 1, pickBuf);
  renderer.setRenderTarget(null);
  renderer.setClearColor(prevClear, prevAlpha);
  camera.clearViewOffset();
  const id = pickBuf[0] + pickBuf[1] * 256 + pickBuf[2] * 65536;
  return id - 1;
}

let down = null;
canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || !city) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  if (moved > 5 || performance.now() - down.t > 500) return;
  if (!city.groups.buildings.visible) return;
  const i = pick(e.clientX, e.clientY);
  if (i < 0) { panel.close(); return; }
  const l = LM.byBuilding.get(i);
  if (l) openLandmark(l, false);
  else openBuilding(i);
});

// ------------------------------------------------------------------ time of day
let hour = 17.5, playing = false;
function initialHour() {
  // Open in late afternoon light unless it's that time already.
  return 17.4;
}
function phaseName(h) {
  const { sunrise, sunset } = sunTimes(atmosphere.date);
  if (h < sunrise - 0.6 || h > sunset + 0.7) return 'Night';
  if (h < sunrise) return 'Dawn';
  if (h < sunrise + 0.8) return 'Sunrise';
  if (h < 11) return 'Morning';
  if (h < 14) return 'Midday';
  if (h < sunset - 1.2) return 'Afternoon';
  if (h < sunset - 0.1) return 'Golden hour';
  if (h < sunset + 0.25) return 'Sunset';
  return 'Dusk';
}
function setTime(h) {
  hour = ((h % 24) + 24) % 24;
  atmosphere.setTime(hour);
  $('time-slider').value = hour;
  const hh = Math.floor(hour), mm = Math.floor((hour - hh) * 60);
  $('time-readout').innerHTML = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}<small>${phaseName(hour)}</small>`;
  // Bloom only catches genuinely bright things: the sun glint by day, lights by night.
  bloom.strength = 0.12 + U.uNight.value * 0.55;
  bloom.threshold = 3.0 - U.uNight.value * 2.2;
}

// ------------------------------------------------------------------ UI
function setupUI(data) {
  const meta = city.meta;
  $('time-slider').addEventListener('input', (e) => setTime(+e.target.value));
  $('time-play').addEventListener('click', () => {
    playing = !playing;
    $('time-play').classList.toggle('on', playing);
    $('time-play').innerHTML = playing ? '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  });
  $('time-presets').addEventListener('click', (e) => {
    const t = e.target.dataset.t;
    if (!t) return;
    if (t === 'now') {
      const now = new Date();
      const utc = now.getUTCHours() + now.getUTCMinutes() / 60;
      setTime(utc + 5.5);
    } else setTime(+t);
  });

  // Layers
  let terrainTarget = 1;
  $('layers').addEventListener('change', (e) => {
    const layer = e.target.dataset.layer, on = e.target.checked;
    if (layer === 'buildings') {
      city.groups.buildings.visible = on;
    } else if (layer === 'roads') {
      city.groups.roads.visible = on;
      labels.setGroupVisible('roads', on);
    } else if (layer === 'landmarks') {
      markers.visible = on;
      labels.setGroupVisible('landmarks', on);
    } else if (layer === 'terrain') {
      terrainTarget = on ? 1 : 0;
      terrainAnim = { from: U.uTerrain.value, to: terrainTarget, t: 0 };
    } else if (layer === 'trees') {
      city.groups.trees.visible = on;
    } else if (layer === 'traffic') {
      life.setVisible(on);
    }
  });

  // Height legend
  const h = meta.heights;
  const pct = (n) => ((n / h.total) * 100).toFixed(n / h.total < 0.01 ? 2 : 1) + '%';
  $('height-legend').innerHTML = `
    <div class="bar"><span style="width:${(h.height / h.total) * 100}%;min-width:3px;background:#40b3fa"></span><span style="width:${(h.levels / h.total) * 100}%;min-width:3px;background:#66cc73"></span><span style="flex:1;background:#ffa940"></span></div>
    <div class="row"><span class="sw" style="background:#40b3fa"></span>OSM height tag<b>${h.height.toLocaleString('en-IN')} · ${pct(h.height)}</b></div>
    <div class="row"><span class="sw" style="background:#66cc73"></span>From floor count<b>${h.levels.toLocaleString('en-IN')} · ${pct(h.levels)}</b></div>
    <div class="row"><span class="sw" style="background:#ffa940"></span>Estimated<b>${h.estimated.toLocaleString('en-IN')} · ${pct(h.estimated)}</b></div>
    <p>Estimates use building type and footprint only, snapped to whole storeys. Click any building to see where its height comes from.</p>`;
  $('height-source').addEventListener('change', (e) => (U.uDataView.value = e.target.checked ? 1 : 0));

  // Camera
  const hint = $('mode-hint');
  const setMode = (m) => {
    rig.setMode(m);
    document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('fly-hud').classList.toggle('hidden', m !== 'fly');
    hint.textContent = m === 'fly' ? 'WASD to fly · Q/E down/up · Shift boost · drag to look · scroll changes speed' : 'Drag to orbit · Right-drag to pan · Scroll to zoom';
  };
  rig.onSpeed = (s) => ($('fly-speed').textContent = Math.round(s));
  $('mode').addEventListener('click', (e) => e.target.dataset.mode && setMode(e.target.dataset.mode));
  $('reset-cam').addEventListener('click', () => { setMode('orbit'); resetView(); });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.code === 'KeyF') setMode(rig.mode === 'fly' ? 'orbit' : 'fly');
    if (e.code === 'Escape') { if (rig.mode === 'fly') setMode('orbit'); else panel.close(); }
  });
  $('compass').addEventListener('click', () => {
    const t = rig.target.clone();
    rig.flyTo(t, { distance: camera.position.distanceTo(t), polar: THREE.MathUtils.radToDeg(rig.orbit.getPolarAngle()), azimuth: 0, duration: 1.2 });
  });
  const ctl = $('controls');
  $('controls-toggle').addEventListener('click', () => {
    if (window.innerWidth <= 760) ctl.classList.toggle('touched');
    else ctl.classList.toggle('collapsed');
  });

  // Search
  const search = new Search($('search-input'), $('search-results'), (r) => {
    if (r.landmark) openLandmark(r.landmark);
    else rig.flyTo(new THREE.Vector3(r.x, city.ground(r.x, r.z), r.z), { distance: r.dist || 700 });
  });
  const entries = [];
  for (const l of LM.list) {
    const cat = CATEGORY[l.category] || CATEGORY.civic;
    entries.push({ name: l.name, kind: l.category, kindLabel: cat.label, color: cat.color, landmark: l, weight: l.curated ? 8 - (l.importance || 3) : 0, featured: l.curated && l.importance === 1 });
  }
  for (const r of data.roadNames) if (r.len > 200) entries.push({ name: r.name, kind: 'road', kindLabel: r.bridge ? 'Road · bridge' : 'Road', color: CATEGORY.road.color, x: r.x, z: r.z, dist: 900, weight: -2 });
  for (const a of data.areaNames) entries.push({ name: a.name, kind: 'area', kindLabel: a.cls, color: CATEGORY.park.color, x: a.x, z: a.z, dist: 600, weight: -1 });
  search.setEntries(entries);

  // Stats
  const s = city.stats();
  $('stats').textContent = `${s.buildings.toLocaleString('en-IN')} buildings · ${s.trees.toLocaleString('en-IN')} trees · ${meta.counts.roads.toLocaleString('en-IN')} road segments`;
  $('brand-sub').textContent = 'Viman Nagar · Kalyani Nagar · Koregaon Park';
}

function resetView(duration = 2.4) {
  const t = new THREE.Vector3(-150, city.ground(-150, 350), 350);
  // Looking roughly north, so Viman Nagar sits top-right and Koregaon Park across the river below.
  rig.flyTo(t, { distance: 4600, polar: 56, azimuth: -0.12, duration });
}

// ------------------------------------------------------------------ loop
let terrainAnim = null;
const timer = new THREE.Timer();
let time = 0;
const focus = new THREE.Vector3();
const perf = { frames: 0, acc: 0, low: 0, high: 0 };
const needle = document.querySelector('#compass .needle');

function loop() {
  requestAnimationFrame(loop);
  timer.update();
  const dt = Math.min(0.1, timer.getDelta());
  time += dt;
  U.uTime.value = time;

  if (playing) setTime(hour + dt * 0.25);
  if (terrainAnim) {
    terrainAnim.t = Math.min(1, terrainAnim.t + dt / 1.2);
    const k = terrainAnim.t * terrainAnim.t * (3 - 2 * terrainAnim.t);
    U.uTerrain.value = terrainAnim.from + (terrainAnim.to - terrainAnim.from) * k;
    city.updateTreeHeights();
    if (terrainAnim.t >= 1) terrainAnim = null;
  }

  rig.update(dt);
  rig.focus(focus);
  const viewDist = camera.position.distanceTo(focus);
  atmosphere.update(camera, focus, viewDist);

  // Adaptive near plane keeps depth precise without a log depth buffer.
  const alt = Math.max(1, camera.position.y - city.ground(camera.position.x, camera.position.z));
  const near = reversed ? THREE.MathUtils.clamp(alt * 0.01, 0.3, 5) : THREE.MathUtils.clamp(alt * 0.04, 0.5, 40);
  if (Math.abs(camera.near - near) > 0.05 * near) { camera.near = near; camera.updateProjectionMatrix(); }

  city.updateLOD(camera);
  if (life.group.visible) life.update(dt, time, camera);
  updateMarkers(time);
  composer.render(dt);
  labels.update(canvas.clientWidth, canvas.clientHeight);

  // Compass: rotate so N points to world north on screen.
  const d = new THREE.Vector3();
  camera.getWorldDirection(d);
  needle.style.transform = `rotate(${Math.atan2(d.x, -d.z) * -1}rad)`;

  // Resolution scaling to hold frame rate.
  perf.frames++;
  perf.acc += dt;
  if (perf.acc > 2) {
    const fps = perf.frames / perf.acc;
    perf.frames = 0;
    perf.acc = 0;
    const max = Math.min(window.devicePixelRatio, 1.75);
    if (fps < 38 && pixelRatio > 0.8) setPixelRatio(pixelRatio - 0.25);
    else if (fps > 57 && pixelRatio < max) setPixelRatio(Math.min(max, pixelRatio + 0.25));
    $('stats').dataset.fps = Math.round(fps);
  }
}

function setPixelRatio(p) {
  pixelRatio = p;
  renderer.setPixelRatio(p);
  composer.setPixelRatio(p);
  composer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  labels?.items.forEach((it) => (it.w = 0));
});

// Expose for debugging in the console.
window.__pune = {
  get city() { return city; }, get rig() { return rig; }, camera, scene, renderer, U, setTime, THREE, atmosphere, pick, openLandmark: (id) => openLandmark(LM.list.find((l) => l.id === id)),
  look(x, z, distance, polar = 60, azimuth = 0) { rig.flyTo(new THREE.Vector3(x, city.ground(x, z), z), { distance, polar, azimuth, duration: 0.01 }); },
};
