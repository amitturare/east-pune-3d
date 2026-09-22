import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Heightfield } from './heightfield.js';
import { GROUND } from './palette.js';
import {
  U, buildingMaterial, roadMaterial, structureMaterial, waterMaterial, terrainMaterial, skirtMaterial,
  treeMaterial, depthMaterialWithElevation, pickMaterial, pickOccluderMaterial,
} from './materials.js';

const NORMALIZED = new Set(['normal', 'color']);

function toGeometry(m, extraBounds = 0) {
  const g = new THREE.BufferGeometry();
  for (const [name, arr] of Object.entries(m.attributes)) {
    const size = { position: 3, normal: 3, color: 3, wuv: 2, uv: 2, elev: 1, bid: 1, meta: 2, rinfo: 3 }[name];
    g.setAttribute(name, new THREE.BufferAttribute(arr, size, NORMALIZED.has(name)));
  }
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  // Bounds include terrain displacement.
  g.computeBoundingBox();
  const elev = m.attributes.elev;
  if (elev && elev.length) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < elev.length; i += 7) { if (elev[i] < lo) lo = elev[i]; if (elev[i] > hi) hi = elev[i]; }
    g.boundingBox.min.y += Math.min(0, lo) - 5;
    g.boundingBox.max.y += hi + 5;
  }
  g.boundingBox.expandByScalar(extraBounds);
  g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
  return g;
}

export class City {
  constructor(scene, data) {
    this.scene = scene;
    this.data = data;
    this.meta = data.meta;
    this.hf = new Heightfield(data.heightfield);
    this.groups = {
      terrain: new THREE.Group(), buildings: new THREE.Group(), roads: new THREE.Group(),
      water: new THREE.Group(), trees: new THREE.Group(),
    };
    for (const g of Object.values(this.groups)) scene.add(g);
    this.pickScene = new THREE.Scene();
    this.buildTerrain();
    this.buildBuildings();
    this.buildRoads();
    this.buildWater();
    this.buildTrees();
    this.terrainScale = 1;
  }

  ground(x, z) {
    return this.hf.at(x, z) * U.uTerrain.value;
  }

  // ------------------------------------------------------------ terrain
  buildTerrain() {
    const { w, h, data } = this.data.groundTex;
    const tex = new THREE.DataTexture(new Uint8Array(data.buffer), w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.flipY = false;
    tex.magFilter = THREE.LinearFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    const g = toGeometry(this.data.terrain);
    const mesh = new THREE.Mesh(g, terrainMaterial(tex));
    mesh.receiveShadow = true;
    mesh.customDepthMaterial = depthMaterialWithElevation('terrain');
    this.groups.terrain.add(mesh);
    this.terrainMesh = mesh;

    // Surrounding land beyond the mapped area: a ring whose inner edge follows the
    // terrain boundary exactly and whose outer edge fades into the haze.
    const ext = this.meta.ext;
    const ring = [];
    const step = this.hf.cell * 2;
    for (let x = ext.minX; x < ext.maxX; x += step) ring.push([x, ext.minZ]);
    for (let z = ext.minZ; z < ext.maxZ; z += step) ring.push([ext.maxX, z]);
    for (let x = ext.maxX; x > ext.minX; x -= step) ring.push([x, ext.maxZ]);
    for (let z = ext.maxZ; z > ext.minZ; z -= step) ring.push([ext.minX, z]);
    const cx = (ext.minX + ext.maxX) / 2, cz = (ext.minZ + ext.maxZ) / 2;
    const edge = ring.reduce((s, [x, z]) => s + this.hf.at(x, z), 0) / ring.length;
    const n = ring.length;
    const pos = new Float32Array(n * 9), el = new Float32Array(n * 3), nor = new Float32Array(n * 9), idx = [];
    ring.forEach(([x, z], i) => {
      const dx = x - cx, dz = z - cz;
      // inner (on the boundary), middle (1.5 km out), outer (60 km out)
      pos.set([x, -0.05, z, cx + dx * 1.35, 0, cz + dz * 1.35, cx + dx * 14, 0, cz + dz * 14], i * 9);
      el.set([this.hf.at(x, z), edge, edge], i * 3);
      nor.set([0, 1, 0, 0, 1, 0, 0, 1, 0], i * 9);
      const j = (i + 1) % n;
      for (let k = 0; k < 2; k++) {
        const a0 = i * 3 + k, a1 = i * 3 + k + 1, b0 = j * 3 + k, b1 = j * 3 + k + 1;
        idx.push(a0, b0, a1, b0, b1, a1);
      }
    });
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    rg.setAttribute('elev', new THREE.BufferAttribute(el, 1));
    rg.setIndex(idx);
    const skirtMat = structureMaterial();
    skirtMat.color.set('#6f7349');
    skirtMat.roughness = 1;
    const skirt = new THREE.Mesh(rg, skirtMat);
    skirt.frustumCulled = false;
    skirt.receiveShadow = true;
    this.groups.terrain.add(skirt);
    this.skirtEdge = edge;
    this.pickScene.add(new THREE.Mesh(g, pickOccluderMaterial()));
  }

  // ------------------------------------------------------------ buildings
  buildBuildings() {
    const mat = (this.buildingMat = buildingMaterial());
    const depth = depthMaterialWithElevation('building');
    const pick = pickMaterial();
    this.tiles = [];
    for (const t of this.data.buildings.tiles) {
      const tile = { cx: t.cx, cz: t.cz, meshes: [] };
      for (const lod of ['major', 'minor']) {
        if (!t[lod]) continue;
        const g = toGeometry(t[lod]);
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = depth;
        mesh.userData.lod = lod;
        this.groups.buildings.add(mesh);
        const pm = new THREE.Mesh(g, pick);
        this.pickScene.add(pm);
        tile.meshes.push({ mesh, pick: pm, lod });
      }
      this.tiles.push(tile);
    }
    const info = this.data.buildings.info;
    this.bInfo = info;
    this.bIds = this.data.buildings.ids;
    this.bNames = this.data.buildings.names;
  }

  buildingRecord(i) {
    const f = this.bInfo;
    return {
      index: i, id: this.bIds[i], name: this.bNames[i] || null, x: f.cx[i], z: f.cz[i], h: f.h[i], minH: f.minH[i],
      base: f.base[i], area: f.area[i], src: f.src[i], type: this.meta.buildingTypes[f.type[i]], levels: f.levels[i],
    };
  }

  // ------------------------------------------------------------ roads, rail
  buildRoads() {
    const rm = roadMaterial();
    const sm = structureMaterial();
    const sd = depthMaterialWithElevation('structure');
    for (const m of [this.data.roads, this.data.rail]) {
      if (!m.count) continue;
      const mesh = new THREE.Mesh(toGeometry(m), rm);
      mesh.receiveShadow = true;
      this.groups.roads.add(mesh);
    }
    for (const m of [this.data.structure, this.data.railStructure]) {
      if (!m.count) continue;
      const mesh = new THREE.Mesh(toGeometry(m), sm);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.customDepthMaterial = sd;
      this.groups.roads.add(mesh);
    }
  }

  buildWater() {
    const mesh = new THREE.Mesh(toGeometry(this.data.water), waterMaterial());
    mesh.receiveShadow = true;
    this.groups.water.add(mesh);
  }

  // ------------------------------------------------------------ trees
  treeGeometries() {
    const tint = (g, c) => {
      const col = new THREE.Color(c);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      if (g.attributes.uv) g.deleteAttribute('uv');
      return g.index ? g.toNonIndexed() : g;
    };
    const blob = (r, y, sx, sy, detail, jitter, seed, x = 0, z = 0) => {
      const ico = new THREE.IcosahedronGeometry(r, detail);
      ico.deleteAttribute('uv');
      ico.deleteAttribute('normal');
      const g = mergeVertices(ico);
      const p = g.attributes.position;
      let s = seed;
      for (let i = 0; i < p.count; i++) {
        s = (s * 16807) % 2147483647;
        const k = 1 + ((s / 2147483647) - 0.5) * jitter;
        p.setXYZ(i, p.getX(i) * sx * k + x, p.getY(i) * sy * k + y, p.getZ(i) * sx * k + z);
      }
      g.computeVertexNormals();
      return g;
    };
    const trunk = (h, r) => { const g = new THREE.CylinderGeometry(r * 0.7, r, h, 6, 1, true); g.translate(0, h / 2, 0); return g; };
    const bark = '#5b4636';
    const make = (detail) => {
      // 0: wide rain-tree/banyan style canopy
      const big = mergeGeometries([
        tint(trunk(4.2, 0.35), bark),
        tint(blob(3.8, 6.2, 1.25, 0.62, detail, 0.35, 11), '#ffffff'),
        tint(blob(2.6, 7.3, 1.1, 0.7, detail, 0.3, 23, 1.6, 0.8), '#f0f0f0'),
        tint(blob(2.4, 6.8, 1.1, 0.7, detail, 0.3, 37, -1.5, -1.1), '#e6e6e6'),
      ]);
      // 1: compact round tree (neem, gulmohar…)
      const small = mergeGeometries([tint(trunk(2.8, 0.22), bark), tint(blob(2.4, 4.4, 1.0, 0.9, detail, 0.3, 5), '#ffffff'), tint(blob(1.6, 5.4, 1, 0.9, detail, 0.25, 9, 0.6, 0.3), '#eeeeee')]);
      // 2: coconut palm
      const fronds = [];
      for (let i = 0; i < 7; i++) {
        const f = new THREE.ConeGeometry(0.55, 4.6, 3, 1, true);
        f.translate(0, 2.3, 0);
        f.scale(1, 1, 0.25);
        f.rotateZ(-1.15 - (i % 2) * 0.25);
        f.rotateY((i / 7) * Math.PI * 2);
        f.translate(0, 9.6, 0);
        fronds.push(tint(f, '#ffffff'));
      }
      const palmTrunk = new THREE.CylinderGeometry(0.16, 0.24, 9.8, 5, 3, true);
      palmTrunk.translate(0, 4.9, 0);
      const pp = palmTrunk.attributes.position;
      for (let i = 0; i < pp.count; i++) pp.setX(i, pp.getX(i) + Math.pow(pp.getY(i) / 9.8, 2) * 0.8);
      const palm = mergeGeometries([tint(palmTrunk, '#7a6650'), ...fronds.map((f) => { f.translate(0.8, 0, 0); return f; })]);
      return [big, small, palm];
    };
    return { near: make(1), far: make(0) };
  }

  buildTrees() {
    const T = this.data.trees;
    const n = T.length / 4;
    const geos = this.treeGeometries();
    const mat = treeMaterial();
    const TILE = 1500;
    const ext = this.meta.ext;
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const x = T[i * 4], z = T[i * 4 + 1], type = T[i * 4 + 3];
      const key = Math.floor((x - ext.minX) / TILE) + ':' + Math.floor((z - ext.minZ) / TILE) + ':' + type;
      (buckets.get(key) || buckets.set(key, []).get(key)).push(i);
    }
    const greens = [new THREE.Color('#4d7a34'), new THREE.Color('#5f8a3a'), new THREE.Color('#3f6b2e'), new THREE.Color('#6d8f3f'), new THREE.Color('#557f45'), new THREE.Color('#7a8f3c')];
    const palmGreen = [new THREE.Color('#6b8a3a'), new THREE.Color('#7d9444')];
    const flowering = [new THREE.Color('#c9573a'), new THREE.Color('#d8b640')]; // gulmohar / copper-pod accents
    this.treeTiles = [];
    let seed = 99;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), c = new THREE.Color();
    for (const [key, idx] of buckets) {
      const type = +key.split(':')[2];
      const near = new THREE.InstancedMesh(geos.near[type], mat, idx.length);
      const far = new THREE.InstancedMesh(geos.far[type], mat, idx.length);
      far.instanceMatrix = near.instanceMatrix;
      const colors = new Float32Array(idx.length * 3);
      let cx = 0, cz = 0;
      idx.forEach((i, k) => {
        const x = T[i * 4], z = T[i * 4 + 1], sc = T[i * 4 + 2];
        cx += x; cz += z;
        q.setFromAxisAngle(up, rnd() * Math.PI * 2);
        s.set(sc, sc * (0.85 + rnd() * 0.3), sc);
        p.set(x, this.hf.at(x, z), z);
        m4.compose(p, q, s);
        near.setMatrixAt(k, m4);
        if (type === 2) c.copy(palmGreen[k % 2]);
        else if (rnd() < 0.04) c.copy(flowering[k % 2]);
        else c.copy(greens[Math.floor(rnd() * greens.length)]);
        c.multiplyScalar(0.85 + rnd() * 0.3);
        colors.set([c.r, c.g, c.b], k * 3);
      });
      const ic = new THREE.InstancedBufferAttribute(colors, 3);
      near.instanceColor = ic;
      far.instanceColor = ic;
      for (const m of [near, far]) {
        m.castShadow = true;
        m.receiveShadow = m === near;
        m.computeBoundingSphere();
        m.boundingSphere.radius += 20;
        this.groups.trees.add(m);
      }
      far.castShadow = false;
      this.treeTiles.push({ near, far, cx: cx / idx.length, cz: cz / idx.length, idx, count: idx.length });
    }
    this.treeCount = n;
  }

  // Re-seat instanced trees when terrain relief changes.
  updateTreeHeights() {
    const T = this.data.trees;
    const m4 = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const k = U.uTerrain.value;
    for (const t of this.treeTiles) {
      t.idx.forEach((i, j) => {
        t.near.getMatrixAt(j, m4);
        m4.decompose(p, q, s);
        p.y = this.hf.at(T[i * 4], T[i * 4 + 1]) * k;
        m4.compose(p, q, s);
        t.near.setMatrixAt(j, m4);
      });
      t.near.instanceMatrix.needsUpdate = true;
    }
  }

  // Make every LOD mesh visible and shadow-casting for one render so all geometry,
  // textures and shadow programs are uploaded/compiled before the user sees motion.
  warmup(render) {
    const saved = [];
    const show = (m, cast) => {
      saved.push([m, m.visible, m.castShadow, m.frustumCulled]);
      m.visible = true;
      m.frustumCulled = false; // off-screen tiles would otherwise upload mid-flight
      if (cast) m.castShadow = true;
    };
    for (const t of this.tiles) for (const m of t.meshes) show(m.mesh, true);
    for (const t of this.treeTiles) { show(t.near, true); show(t.far, false); }
    for (const g of [this.groups.roads, this.groups.water, this.groups.terrain]) g.traverse((o) => o.isMesh && show(o, o.castShadow));
    render();
    for (const [m, v, c, f] of saved) { m.visible = v; m.castShadow = c; m.frustumCulled = f; }
  }

  // Distance-based level of detail.
  updateLOD(camera) {
    // True 3D distance: from high up everything is far away, so detail drops
    // (and the view stays smooth) exactly when it can't be seen anyway.
    const cp = camera.position;
    const alt = Math.max(0, cp.y - this.ground(cp.x, cp.z));
    for (const t of this.tiles) {
      const d = Math.hypot(t.cx - cp.x, t.cz - cp.z, alt);
      for (const m of t.meshes) {
        if (m.lod === 'minor') m.mesh.visible = d < 4200;
        m.mesh.castShadow = d < 5000 && (m.lod === 'major' || d < 2500);
        m.pick.visible = m.mesh.visible && this.groups.buildings.visible;
      }
    }
    for (const t of this.treeTiles) {
      const d = Math.hypot(t.cx - cp.x, t.cz - cp.z, alt);
      t.near.visible = d < 1900;
      t.near.castShadow = d < 1500;
      t.far.visible = d >= 1900 && d < 11000;
    }
  }

  stats() {
    return { buildings: this.bIds.length, trees: this.treeCount };
  }
}
