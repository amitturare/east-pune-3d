import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Orbit exploration + free flight, with smooth animated transitions between views.
export class CameraRig {
  constructor(camera, dom, groundAt) {
    this.camera = camera;
    this.dom = dom;
    this.groundAt = groundAt; // (x, z) => ground height in world units
    this.mode = 'orbit';

    const c = (this.orbit = new OrbitControls(camera, dom));
    c.enableDamping = true;
    c.dampingFactor = 0.075;
    c.screenSpacePanning = false;
    c.zoomToCursor = true;
    c.minDistance = 25;
    c.maxDistance = 16000;
    c.maxPolarAngle = THREE.MathUtils.degToRad(86);
    c.rotateSpeed = 0.55;
    c.zoomSpeed = 1.1;
    c.panSpeed = 1.0;
    c.keyPanSpeed = 30;
    c.listenToKeyEvents(window);

    this.fly = { vel: new THREE.Vector3(), yaw: 0, pitch: 0, speed: 60, keys: new Set(), dragging: false, last: null };
    this.anim = null;
    this.onModeChange = () => {};

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.fly.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.fly.keys.delete(e.code));
    window.addEventListener('blur', () => this.fly.keys.clear());
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
  }

  get target() {
    return this.orbit.target;
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

  // Animate to look at `target` from a given distance/angles.
  flyTo(target, { distance = 600, polar = 58, azimuth = null, duration = 2.2 } = {}) {
    if (this.mode === 'fly') this.setMode('orbit');
    const cam = this.camera;
    const fromPos = cam.position.clone();
    const fromTgt = this.orbit.target.clone();
    const az = azimuth ?? Math.atan2(cam.position.x - fromTgt.x, cam.position.z - fromTgt.z);
    const ph = THREE.MathUtils.degToRad(polar);
    const toTgt = target.clone();
    const toPos = new THREE.Vector3(
      toTgt.x + distance * Math.sin(ph) * Math.sin(az),
      toTgt.y + distance * Math.cos(ph),
      toTgt.z + distance * Math.sin(ph) * Math.cos(az),
    );
    const travel = fromTgt.distanceTo(toTgt);
    const lift = Math.min(2500, travel * 0.35);
    const dur = duration * THREE.MathUtils.clamp(0.6 + travel / 5000, 0.7, 1.6);
    this.anim = { t: 0, dur, fromPos, toPos, fromTgt, toTgt, lift };
    this.orbit.enabled = false;
  }

  update(dt) {
    const cam = this.camera;
    if (this.anim) {
      const a = this.anim;
      a.t = Math.min(1, a.t + dt / a.dur);
      const k = ease(a.t);
      this.orbit.target.lerpVectors(a.fromTgt, a.toTgt, k);
      cam.position.lerpVectors(a.fromPos, a.toPos, k);
      cam.position.y += Math.sin(Math.PI * k) * a.lift;
      cam.lookAt(this.orbit.target);
      if (a.t >= 1) {
        this.anim = null;
        this.orbit.enabled = true;
        this.orbit.update();
      }
      return;
    }
    if (this.mode === 'orbit') {
      this.orbit.update();
      // Never dip below the ground.
      const g = this.groundAt(cam.position.x, cam.position.z) + 6;
      if (cam.position.y < g) cam.position.y = g;
      return;
    }
    // Free flight.
    const f = this.fly;
    const k = f.keys;
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
    // Smoothly steer the view (tiny lag feels cinematic).
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
