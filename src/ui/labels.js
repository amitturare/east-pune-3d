import * as THREE from 'three';

// Screen-space HTML labels with distance fading and priority-based decluttering.
export class Labels {
  constructor(root, camera, groundAt) {
    this.root = root;
    this.camera = camera;
    this.groundAt = groundAt;
    this.items = [];
    this.v = new THREE.Vector3();
    this.visible = { landmarks: true, roads: true, places: true };
  }

  add({ html, cls, x, z, y = 0, absY = null, priority = 1, near = 0, far = 6000, group = 'places', onClick, title, data }) {
    const el = document.createElement('div');
    el.className = 'lbl ' + cls;
    el.innerHTML = html;
    if (title) el.title = title;
    el.style.opacity = '0';
    if (onClick) el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    this.root.appendChild(el);
    const item = { el, x, z, y, absY, priority, near, far, group, w: 0, h: 0, shown: false, op: 0, data };
    this.items.push(item);
    return item;
  }

  setGroupVisible(group, v) {
    this.visible[group] = v;
  }

  update(width, height) {
    const cam = this.camera;
    const cp = cam.position;
    const placed = [];
    // Measure lazily (once).
    for (const it of this.items) if (!it.w) { it.w = it.el.offsetWidth || 80; it.h = it.el.offsetHeight || 20; }
    const cand = [];
    for (const it of this.items) {
      if (!this.visible[it.group]) { this.hide(it); continue; }
      const wy = it.absY != null ? it.absY() : this.groundAt(it.x, it.z) + it.y;
      const d = Math.hypot(it.x - cp.x, wy - cp.y, it.z - cp.z);
      if (d > it.far || d < it.near) { this.hide(it); continue; }
      this.v.set(it.x, wy, it.z).project(cam);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.1 || Math.abs(this.v.y) > 1.1) { this.hide(it); continue; }
      const sx = (this.v.x * 0.5 + 0.5) * width, sy = (-this.v.y * 0.5 + 0.5) * height;
      const fadeFar = 1 - THREE.MathUtils.smoothstep(d, it.far * 0.75, it.far);
      const fadeNear = it.near ? THREE.MathUtils.smoothstep(d, it.near, it.near * 1.4) : 1;
      cand.push({ it, sx, sy, d, alpha: fadeFar * fadeNear });
    }
    cand.sort((a, b) => b.it.priority - a.it.priority || a.d - b.d);
    for (const c of cand) {
      const { it, sx, sy } = c;
      const x0 = sx - it.w / 2 - 4, y0 = sy - it.h - 4, x1 = sx + it.w / 2 + 4, y1 = sy + 4;
      let hit = false;
      for (const r of placed) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) { hit = true; break; }
      if (hit && !it.el.classList.contains('sel')) { this.hide(it); continue; }
      placed.push([x0, y0, x1, y1]);
      it.el.style.transform = `translate3d(${(sx - it.w / 2).toFixed(1)}px, ${(sy - it.h).toFixed(1)}px, 0)`;
      const op = c.alpha.toFixed(2);
      if (it.op !== op) { it.el.style.opacity = op; it.op = op; }
      it.el.style.pointerEvents = c.alpha > 0.3 ? '' : 'none';
      it.shown = true;
    }
  }

  hide(it) {
    if (it.op !== '0') { it.el.style.opacity = '0'; it.el.style.pointerEvents = 'none'; it.op = '0'; }
    it.shown = false;
  }
}
