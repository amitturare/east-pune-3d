import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const MIN_POLAR = THREE.MathUtils.degToRad(5);
const MAX_POLAR = THREE.MathUtils.degToRad(80);

// Map-style exploration (drag to pan, right/Ctrl-drag to rotate, scroll to zoom)
// plus free flight, with smooth animated transitions between views.
export class CameraRig {
  constructor(camera, dom, groundAt) {
    this.camera = camera;
    this.dom = dom;
    this.groundAt = groundAt; // (x, z) => ground height in world units
    this.mode = 'orbit';

    const c = (this.orbit = new MapControls(camera, dom));
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.screenSpacePanning = false; // pan across the ground, not the screen
    c.zoomToCursor = true;
    c.minDistance = 40;
    c.maxDistance = 14000;
    c.minPolarAngle = MIN_POLAR;
    c.maxPolarAngle = MAX_POLAR;
    c.rotateSpeed = 0.45;
    c.zoomSpeed = 1.4;
    c.panSpeed = 1.1;
    // Left = pan, right = rotate/tilt, middle = zoom. Holding Ctrl/Cmd/Shift turns
    // left-drag into rotate (for trackpads). One finger pans, two fingers zoom/rotate.
    c.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    c.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.fly = { vel: new THREE.Vector3(), yaw: 0, pitch: 0, speed: 60, dragging: false, last: null };
    this.keys = new Set();
    this.anim = null;
    this.onModeChange = () => {};

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    // Any user input cancels an in-progress camera animation.
    const interrupt = () => {
      if (!this.anim || this.mode !== 'orbit') return;
      this.anim = null;
      this.orbit.enabled = true;
      this.orbit.update();
    };
    dom.addEventListener('pointerdown', interrupt, true);
    dom.addEventListener('wheel', interrupt, { capture: true, passive: true });

    dom.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'fly') return;
      this.fly.dragging = true;
      this.fly.last = [e.clientX, e.clientY];
      dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.mode !== 'fly' || !this.fly.dragging) return;
      const [lx, ly] = this.fly.last;
      this.fly.yaw -= (e.clientX - lx) * 0.0032;
      this.fly.pitch = THREE.MathUtils.clamp(this.fly.pitch - (e.clientY - ly) * 0.0032, -1.45, 1.2);
      this.fly.last = [e.clientX, e.clientY];
    });
    dom.addEventListener('pointerup', () => (this.fly.dragging = false));
    dom.addEventListener('wheel', (e) => {
      if (this.mode !== 'fly') return;
      e.preventDefault();
      this.fly.speed = THREE.MathUtils.clamp(this.fly.speed * (e.deltaY > 0 ? 0.85 : 1.18), 5, 800);
      this.onSpeed?.(this.fly.speed);
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // Double-click: zoom in on the clicked spot.
    dom.addEventListener('dblclick', (e) => {
      if (this.mode !== 'orbit') return;
      const p = this.groundPointAt(e.clientX, e.clientY);
      if (!p) return;
      const d = this.camera.position.distanceTo(this.orbit.target);
      this.flyTo(p, { distance: Math.max(120, d * 0.45), polar: THREE.MathUtils.radToDeg(this.orbit.getPolarAngle()), azimuth: this.orbit.getAzimuthalAngle(), duration: 0.9 });
    });
  }

  get target() {
    return this.orbit.target;
  }

  // Ray-march the heightfield under a screen point.
  groundPointAt(clientX, clientY) {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, d = ray.ray.direction;
    if (d.y > -0.01) return null;
    let t = 0, step = Math.max(5, (o.y - this.groundAt(o.x, o.z)) / 200);
    const p = new THREE.Vector3();
    for (let i = 0; i < 2000; i++) {
      p.copy(o).addScaledVector(d, t);
      if (p.y <= this.groundAt(p.x, p.z)) {
        // Refine by bisection.
        let a = t - step, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          p.copy(o).addScaledVector(d, m);
          if (p.y <= this.groundAt(p.x, p.z)) b = m;
          else a = m;
        }
        p.y = this.groundAt(p.x, p.z);
        return p;
      }
      t += step;
    }
    return null;
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.anim = null;
    if (mode === 'fly') {
      this.orbit.enabled = false;
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.fly.yaw = Math.atan2(-d.x, -d.z);
      this.fly.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      this.fly.vel.set(0, 0, 0);
    } else {
      // Re-seat the orbit target on the ground in front of the camera.
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      const p = this.camera.position;
      let t = 400;
      if (d.y < -0.05) t = Math.min(4000, (p.y - this.groundAt(p.x, p.z)) / -d.y);
      const tgt = p.clone().addScaledVector(d, t);
      tgt.y = this.groundAt(tgt.x, tgt.z);
      this.orbit.target.copy(tgt);
      this.orbit.enabled = true;
      this.orbit.update();
    }
    this.onModeChange(mode);
  }

  // Animate to look at `target` from a given distance/angles (azimuth in radians).
  flyTo(target, { distance = 600, polar = 58, azimuth = null, duration = 2.2 } = {}) {
    if (this.mode === 'fly') this.setMode('orbit');
    const cam = this.camera;
    // Start from the current view expressed around the current target.
    const fromTgt = this.orbit.target.clone();
    const off = new THREE.Spherical().setFromVector3(cam.position.clone().sub(fromTgt));
    const toTgt = target.clone();
    distance = THREE.MathUtils.clamp(distance, this.orbit.minDistance, this.orbit.maxDistance);
    const toPhi = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(polar, 5, 80));
    let toTheta = azimuth ?? off.theta;
    // Turn the short way round.
    while (toTheta - off.theta > Math.PI) toTheta -= 2 * Math.PI;
    while (toTheta - off.theta < -Math.PI) toTheta += 2 * Math.PI;
    const travel = fromTgt.distanceTo(toTgt);
    // Pull back (in log-distance) while travelling far, so long hops arc gracefully.
    const bump = Math.log(1 + travel / Math.max(300, Math.min(off.radius, distance))) * 0.35;
    const dur = duration * THREE.MathUtils.clamp(0.6 + travel / 5000, 0.7, 1.6);
    this.anim = {
      t: 0, dur, fromTgt, toTgt, bump,
      d0: Math.log(Math.max(1, off.radius)), d1: Math.log(distance),
      p0: off.phi, p1: toPhi, a0: off.theta, a1: toTheta,
    };
    this.orbit.enabled = false;
  }

  // Zoom by a factor around the current target (buttons / keys).
  zoom(factor) {
    const c = this.orbit;
    const d = THREE.MathUtils.clamp(this.camera.position.distanceTo(c.target) * factor, c.minDistance, c.maxDistance);
    this.flyTo(c.target.clone(), { distance: d, polar: THREE.MathUtils.radToDeg(c.getPolarAngle()), azimuth: c.getAzimuthalAngle(), duration: 0.35 });
  }

  // Keyboard navigation in explore mode: WASD/arrows pan, Q/E rotate, R/F tilt, +/- zoom.
  keyboardOrbit(dt) {
    const k = this.keys;
    const c = this.orbit;
    const cam = this.camera;
    const offset = cam.position.clone().sub(c.target);
    const dist = offset.length();
    const sph = new THREE.Spherical().setFromVector3(offset);
    let moved = false;
    const pan = new THREE.Vector3();
    const fwd = new THREE.Vector3(-Math.sin(sph.theta), 0, -Math.cos(sph.theta));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    if (k.has('KeyW') || k.has('ArrowUp')) pan.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) pan.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) pan.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) pan.sub(right);
    if (pan.lengthSq()) {
      pan.normalize().multiplyScalar(dist * 0.9 * dt * (k.has('ShiftLeft') || k.has('ShiftRight') ? 2.5 : 1));
      c.target.add(pan);
      moved = true;
    }
    if (k.has('KeyQ')) { sph.theta += 1.2 * dt; moved = true; }
    if (k.has('KeyE')) { sph.theta -= 1.2 * dt; moved = true; }
    if (k.has('KeyR')) { sph.phi = Math.max(MIN_POLAR, sph.phi - 0.8 * dt); moved = true; }
    if (k.has('KeyG')) { sph.phi = Math.min(MAX_POLAR, sph.phi + 0.8 * dt); moved = true; }
    if (k.has('Equal') || k.has('NumpadAdd')) { sph.radius = Math.max(c.minDistance, sph.radius * (1 - 1.5 * dt)); moved = true; }
    if (k.has('Minus') || k.has('NumpadSubtract')) { sph.radius = Math.min(c.maxDistance, sph.radius * (1 + 1.5 * dt)); moved = true; }
    if (moved) cam.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph));
  }

  update(dt) {
    const cam = this.camera;
    // Frame-time smoothing: a single slow frame slows the animation briefly
    // instead of making the camera jump.
    this.smoothDt = this.smoothDt == null ? dt : this.smoothDt + (Math.min(dt, 1 / 20) - this.smoothDt) * 0.2;
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + this.smoothDt / a.dur);
      const k = ease(a.t);
      // Target moves a little ahead of the orbit so the camera "leans" into the move.
      const kt = ease(Math.min(1, a.t * 1.08));
      this.orbit.target.lerpVectors(a.fromTgt, a.toTgt, kt);
      const sph = new THREE.Spherical(
        Math.exp(a.d0 + (a.d1 - a.d0) * k + a.bump * Math.sin(Math.PI * k)),
        a.p0 + (a.p1 - a.p0) * k,
        a.a0 + (a.a1 - a.a0) * k,
      );
      cam.position.copy(this.orbit.target).add(new THREE.Vector3().setFromSpherical(sph));
      cam.lookAt(this.orbit.target);
      if (a.t >= 1) {
        this.anim = null;
        this.orbit.enabled = true;
        this.orbit.update();
      }
      return;
    }
    if (this.mode === 'orbit') {
      this.keyboardOrbit(dt);
      // Keep the pivot on the ground as you pan across hills and the river valley.
      const t = this.orbit.target;
      const dy = (this.groundAt(t.x, t.z) - t.y) * Math.min(1, dt * 4);
      t.y += dy;
      cam.position.y += dy;
      this.orbit.update();
      // Never dip below the ground: lift camera (and keep looking at the pivot).
      const g = this.groundAt(cam.position.x, cam.position.z) + 8;
      if (cam.position.y < g) {
        cam.position.y = g;
        cam.lookAt(t);
      }
      return;
    }
    // Free flight.
    const f = this.fly;
    const k = this.keys;
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const fwd = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
    const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    const want = new THREE.Vector3();
    if (k.has('KeyW') || k.has('ArrowUp')) want.add(fwd);
    if (k.has('KeyS') || k.has('ArrowDown')) want.sub(fwd);
    if (k.has('KeyD') || k.has('ArrowRight')) want.add(right);
    if (k.has('KeyA') || k.has('ArrowLeft')) want.sub(right);
    if (k.has('KeyE') || k.has('Space')) want.y += 1;
    if (k.has('KeyQ') || k.has('KeyC')) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(f.speed * boost);
    f.vel.lerp(want, 1 - Math.exp(-dt * 4));
    cam.position.addScaledVector(f.vel, dt);
    const g = this.groundAt(cam.position.x, cam.position.z) + 2.5;
    if (cam.position.y < g) { cam.position.y = g; f.vel.y = Math.max(0, f.vel.y); }
    cam.position.y = Math.min(cam.position.y, 9000);
    const look = cam.position.clone().add(fwd);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, look, new THREE.Vector3(0, 1, 0)));
    cam.quaternion.slerp(q, 1 - Math.exp(-dt * 14));
  }

  // Point on the ground the camera is focused on (for shadows, labels).
  focus(out = new THREE.Vector3()) {
    if (this.mode === 'orbit' || this.anim) return out.copy(this.orbit.target);
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    const p = this.camera.position;
    const h = p.y - this.groundAt(p.x, p.z);
    const t = d.y < -0.1 ? Math.min(1500, h / -d.y) : Math.min(600, 150 + h);
    out.copy(p).addScaledVector(d, t);
    out.y = this.groundAt(out.x, out.z);
    return out;
  }
}
