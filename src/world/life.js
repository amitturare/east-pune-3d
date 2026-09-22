import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { U, carMaterial } from './materials.js';

// Samples a polyline stored as Float32Array [x, z, elev, yOff] * n.
class Path {
  constructor(pts) {
    this.p = pts;
    this.n = pts.length / 4;
    this.s = new Float32Array(this.n);
    for (let i = 1; i < this.n; i++) this.s[i] = this.s[i - 1] + Math.hypot(pts[i * 4] - pts[i * 4 - 4], pts[i * 4 + 1] - pts[i * 4 - 3]);
    this.len = this.s[this.n - 1];
    this.hint = 1;
  }
  sample(d, out) {
    d = Math.max(0, Math.min(this.len, d));
    let i = this.hint;
    while (i < this.n - 1 && this.s[i] < d) i++;
    while (i > 1 && this.s[i - 1] > d) i--;
    this.hint = i;
    const t = (d - this.s[i - 1]) / Math.max(1e-3, this.s[i] - this.s[i - 1]);
    const p = this.p, a = (i - 1) * 4, b = i * 4;
    out.x = p[a] + (p[b] - p[a]) * t;
    out.z = p[a + 1] + (p[b + 1] - p[a + 1]) * t;
    out.elev = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
    out.off = p[a + 3] + (p[b + 3] - p[a + 3]) * t;
    let dx = p[b] - p[a], dz = p[b + 1] - p[a + 1];
    const l = Math.hypot(dx, dz) || 1;
    out.dx = dx / l;
    out.dz = dz / l;
    return out;
  }
}

function carGeometry() {
  const body = new THREE.BoxGeometry(1.8, 0.8, 4.0);
  body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(1.6, 0.6, 2.1);
  cabin.translate(0, 1.3, -0.2);
  const g = mergeGeometries([body, cabin]);
  g.deleteAttribute('uv');
  return g;
}

export class Life {
  constructor(scene, data, hf) {
    this.scene = scene;
    this.hf = hf;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tmp = {};
    this.buildCars(data.carPaths);
    this.buildMetro(data.metroPaths);
    this.buildPlane(data.runways);
  }

  // ----------------------------------------------------------- cars
  buildCars(paths) {
    const palette = ['#f2f2f0', '#e8e8e6', '#1d1f24', '#9aa0a8', '#c4c7cc', '#8a1c1c', '#1f3f73', '#d9d2c2', '#3a3f45', '#f4d03f', '#2e6b3a'];
    this.paths = paths.map((p) => ({ path: new Path(p.pts), rank: p.rank, oneway: p.oneway, width: p.width }));
    const cars = [];
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [pi, p] of this.paths.entries()) {
      const density = p.rank >= 15 ? 1 / 55 : p.rank >= 13 ? 1 / 90 : 1 / 160;
      const n = Math.floor(p.path.len * density);
      for (let k = 0; k < n; k++) {
        const dir = p.oneway ? 1 : rnd() < 0.5 ? 1 : -1;
        const auto = rnd() < 0.3; // auto-rickshaws: shorter, yellow-green-black
        cars.push({ pi, d: rnd() * p.path.len, dir, v: (p.rank >= 15 ? 11 : 8) * (0.7 + rnd() * 0.5), auto });
      }
    }
    const MAX = 1400;
    while (cars.length > MAX) cars.splice(Math.floor(rnd() * cars.length), 1);
    this.cars = cars;
    const mesh = new THREE.InstancedMesh(carGeometry(), carMaterial(), cars.length);
    const c = new THREE.Color();
    cars.forEach((car, i) => {
      if (car.auto) c.set(rnd() < 0.8 ? '#2f6b34' : '#e2c229');
      else c.set(palette[Math.floor(rnd() * palette.length)]);
      mesh.setColorAt(i, c);
    });
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    this.carMesh = mesh;
    this.group.add(mesh);
  }

  // ----------------------------------------------------------- metro
  buildMetro(paths) {
    this.trains = [];
    const coach = new THREE.BoxGeometry(2.9, 3.4, 21);
    coach.translate(0, 1.9, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xeef1f3, roughness: 0.35, metalness: 0.3 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x1c9fb5, roughness: 0.4, emissive: 0x0b3a44, emissiveIntensity: 0.2 });
    const win = new THREE.MeshStandardMaterial({ color: 0x1b2328, roughness: 0.1, metalness: 0.6, emissive: 0xfff1d0, emissiveIntensity: 0 });
    this.trainWinMat = win;
    const stripeG = new THREE.BoxGeometry(2.95, 0.35, 21.02);
    stripeG.translate(0, 1.05, 0);
    const winG = new THREE.BoxGeometry(2.95, 0.9, 19);
    winG.translate(0, 2.4, 0);
    for (const p of paths.sort((a, b) => b.len - a.len).slice(0, 3)) {
      const path = new Path(p.pts);
      for (let t = 0; t < 2; t++) {
        const g = new THREE.Group();
        const coaches = [];
        for (let k = 0; k < 3; k++) {
          const cg = new THREE.Group();
          cg.add(new THREE.Mesh(coach, mat), new THREE.Mesh(stripeG, stripe), new THREE.Mesh(winG, win));
          cg.traverse((o) => (o.castShadow = true));
          g.add(cg);
          coaches.push(cg);
        }
        this.group.add(g);
        this.trains.push({ path, g, coaches, d: t === 0 ? 0 : path.len * 0.5, dir: t === 0 ? 1 : -1, v: 16, wait: 0 });
      }
    }
  }

  // ----------------------------------------------------------- aircraft
  buildPlane(runways) {
    if (!runways || !runways.length) return;
    const r = runways.sort((a, b) => b.length - a.length)[0];
    const a = [r[0], r[1]], b = [r[r.length - 2], r[r.length - 1]];
    this.runway = { a, b };
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f5f7, roughness: 0.4, metalness: 0.2 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x2c4f9e, roughness: 0.5 });
    const plane = new THREE.Group();
    const fus = new THREE.CylinderGeometry(1.9, 1.9, 34, 12);
    fus.rotateX(Math.PI / 2);
    const nose = new THREE.SphereGeometry(1.9, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2);
    nose.rotateX(Math.PI / 2);
    nose.translate(0, 0, 17);
    const wing = new THREE.BoxGeometry(34, 0.4, 5);
    wing.translate(0, -0.6, 1);
    const stab = new THREE.BoxGeometry(12, 0.3, 3);
    stab.translate(0, 0.6, -15.5);
    const fin = new THREE.BoxGeometry(0.4, 6, 4.5);
    fin.translate(0, 4, -15);
    plane.add(new THREE.Mesh(mergeGeometries([fus, nose]), white), new THREE.Mesh(wing, white), new THREE.Mesh(stab, white), new THREE.Mesh(fin, tailMat));
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    beacon.position.set(0, 2.2, 0);
    plane.add(beacon);
    this.beacon = beacon;
    plane.traverse((o) => (o.castShadow = true));
    plane.visible = false;
    this.plane = plane;
    this.planeT = 20;
    this.group.add(plane);
  }

  update(dt, time, camera) {
    const k = U.uTerrain.value;
    const o = this.tmp;
    // Cars — Indian traffic keeps left.
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const sAuto = new THREE.Vector3(0.78, 0.95, 0.68);
    const cp = camera.position;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      const p = this.paths[c.pi];
      c.d += c.v * c.dir * dt;
      if (c.d > p.path.len) { if (p.oneway) c.d -= p.path.len; else { c.d = p.path.len; c.dir = -1; } }
      if (c.d < 0) { if (p.oneway) c.d += p.path.len; else { c.d = 0; c.dir = 1; } }
      p.path.sample(c.d, o);
      const dx = o.dx * c.dir, dz = o.dz * c.dir;
      const lane = p.oneway ? 0 : p.width * 0.23;
      // Left of travel direction = (dz, -dx) in this frame (x east, z south).
      pos.set(o.x + dz * lane, o.elev * k + o.off, o.z - dx * lane);
      if (Math.abs(pos.x - cp.x) > 6000 || Math.abs(pos.z - cp.z) > 6000) pos.y = -1e4;
      q.setFromAxisAngle(up, Math.atan2(dx, dz));
      m4.compose(pos, q, c.auto ? sAuto : one);
      this.carMesh.setMatrixAt(i, m4);
    }
    this.carMesh.instanceMatrix.needsUpdate = true;

    // Metro.
    this.trainWinMat.emissiveIntensity = U.uNight.value * 1.4;
    for (const t of this.trains) {
      if (t.wait > 0) t.wait -= dt;
      else {
        t.d += t.v * t.dir * dt;
        if (t.d > t.path.len - 70 || t.d < 0) {
          t.dir *= -1;
          t.d = THREE.MathUtils.clamp(t.d, 0, t.path.len - 70);
          t.wait = 12;
        }
      }
      t.coaches.forEach((cg, j) => {
        const d = t.d + j * 21.8 + 10.5;
        t.path.sample(d, o);
        cg.position.set(o.x, o.elev * k + o.off, o.z);
        cg.rotation.y = Math.atan2(o.dx, o.dz);
      });
    }

    // Departing aircraft: roll, rotate, climb out, repeat.
    if (this.plane) {
      this.planeT += dt;
      const cycle = 95;
      const t = this.planeT % cycle;
      const { a, b } = this.runway;
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
      const accel = 2.2; // m/s²
      const dist = 0.5 * accel * t * t;
      const rollLen = Math.min(L * 0.7, 1500);
      this.plane.visible = t < 70;
      if (this.plane.visible) {
        let along = dist, alt = 0, pitch = 0;
        if (dist > rollLen) {
          const over = dist - rollLen;
          alt = over * Math.tan(THREE.MathUtils.degToRad(8));
          pitch = THREE.MathUtils.degToRad(Math.min(12, over * 0.05));
        }
        const x = a[0] + ux * along, z = a[1] + uz * along;
        const g = this.hf.at(a[0], a[1]) * k;
        this.plane.position.set(x, g + 3.2 + alt, z);
        this.plane.rotation.set(0, Math.atan2(ux, uz), 0);
        this.plane.rotateX(-pitch);
        this.beacon.visible = Math.sin(time * 6) > 0.6;
      }
    }
  }

  setVisible(v) {
    this.group.visible = v;
  }
}
