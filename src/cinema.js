// Cinema mode (?cinema): a scripted, deterministic film of the model.
// Nothing animates on its own; `window.__cinema.renderFrame(i)` advances the world
// by exactly one frame, so a recorder can capture perfectly smooth video no
// matter how slow the machine is.
import * as THREE from 'three';

const FPS = 30;
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * t * (t * (t * 6 - 15) + 10); };
const lerp = (a, b, t) => a + (b - a) * t;
const lerpLog = (a, b, t) => Math.exp(lerp(Math.log(a), Math.log(b), t));

export function startCinema(ctx) {
  const { renderer, composer, camera, city, life, atmosphere, setTime, U, markers, reversed } = ctx;
  const portrait = window.innerHeight > window.innerWidth;
  const zoomOut = portrait ? 1.35 : 1;
  document.body.classList.add('cinema');
  markers.visible = false;
  camera.fov = portrait ? 58 : 44;
  camera.updateProjectionMatrix();

  // Overlay: titles, lower thirds, fade.
  const ov = document.createElement('div');
  ov.id = 'cine';
  ov.innerHTML = `
    <div class="cine-title"><div class="cine-kicker">An explorable 3D model</div><div class="cine-big">East Pune</div><div class="cine-small">Viman Nagar · Kalyani Nagar · Koregaon Park</div></div>
    <div class="cine-lower"><i></i><div><div class="cine-name"></div><div class="cine-sub"></div></div></div>
    <div class="cine-end"><div class="cine-big">East Pune <em>3D</em></div><div class="cine-small">Built from OpenStreetMap · three.js</div><div class="cine-url">github.com/amitturare/east-pune-3d</div></div>
    <div class="cine-fade"></div>`;
  document.body.appendChild(ov);
  const $ = (s) => ov.querySelector(s);

  const g = (x, z) => city.hf.at(x, z);
  const V = (x, z, dy = 0) => new THREE.Vector3(x, g(x, z) + dy, z);
  const train = life.trains[0];
  const plane = life.plane;

  // Each shot: duration (s), hour(u), and view(u) -> { target, distance, polar(deg), azimuth(rad) }.
  const shots = [
    {
      dur: 5, hour: () => 17.05,
      view: (u) => ({ target: V(-150, 350), distance: lerpLog(15000, 4300, u), polar: lerp(18, 54, u), azimuth: lerp(-0.9, -0.15, u) }),
      title: true,
    },
    {
      dur: 6.5, hour: (u) => lerp(17.2, 17.3, u), name: 'Aga Khan Palace', sub: 'Where Gandhi was interned, 1942–44',
      view: (u) => ({ target: V(-154, 57, 10), distance: lerp(430, 320, u), polar: lerp(63, 60, u), azimuth: lerp(0.5, 1.45, u) }),
    },
    {
      // Lateral dolly along the river, sun from the side (no glare).
      dur: 7, hour: (u) => lerp(17.4, 17.5, u), name: 'Mula-Mutha River', sub: 'Its water ends up in the Bay of Bengal',
      view: (u) => {
        const x = lerp(-500, -1750, u), z = lerp(840, 1100, u);
        return { target: V(x, z, 5), distance: 900, polar: lerp(64, 67, u), azimuth: lerp(0.05, 0.25, u) };
      },
    },
    {
      dur: 6, hour: (u) => lerp(17.6, 17.7, u), name: 'Viman Nagar', sub: '“Airport City”, named for its neighbour',
      view: (u) => ({ target: V(1449, -1005, 10), distance: lerp(1500, 950, u), polar: lerp(62, 58, u), azimuth: lerp(-0.55, -0.25, u) }),
    },
    {
      dur: 7, hour: (u) => lerp(17.85, 17.95, u), name: 'Pune International Airport', sub: 'A civil enclave on an Air Force base',
      setup: () => { if (plane) life.planeT = 95 * 3 + 31; },
      view: (u) => {
        const p = plane.position;
        const { a, b } = life.runway;
        const heading = Math.atan2(b[0] - a[0], b[1] - a[1]);
        return { target: p.clone(), distance: lerp(200, 360, u), polar: lerp(74, 66, u), azimuth: heading + Math.PI * lerp(0.72, 0.58, u) };
      },
    },
    {
      dur: 6.5, hour: (u) => lerp(18.1, 18.25, u), name: 'Pune Metro · Aqua Line', sub: 'Elevated trains across the Mula-Mutha',
      setup: () => { if (train) { train.d = train.path.len * 0.42; train.dir = 1; train.wait = 0; } },
      view: (u) => {
        const c = train.coaches[1].position;
        const head = train.coaches[0].rotation.y; // azimuth of travel direction
        return { target: new THREE.Vector3(c.x, c.y + 2, c.z), distance: lerp(150, 210, u), polar: lerp(66, 62, u), azimuth: head + Math.PI * lerp(0.62, 0.78, u) };
      },
    },
    {
      dur: 9, hour: (u) => lerp(18.35, 20.3, smooth(u)), name: 'Built from OpenStreetMap', sub: '48,778 buildings · real streets · live Wikipedia facts',
      view: (u) => ({ target: V(-250, 250), distance: lerp(5200, 3900, u), polar: lerp(52, 58, u), azimuth: lerp(-0.45, 0.35, u) }),
    },
    {
      dur: 4.5, hour: () => 20.35, end: true,
      view: (u) => ({ target: V(-250, 250), distance: lerp(3900, 3700, u), polar: 58, azimuth: lerp(0.35, 0.45, u) }),
    },
  ];
  let acc = 0;
  for (const s of shots) { s.t0 = acc; acc += s.dur; }
  const duration = acc;
  const frames = Math.round(duration * FPS);

  let lastShot = -1;
  function poseCamera(v) {
    const ph = THREE.MathUtils.degToRad(v.polar);
    const d = v.distance * zoomOut;
    camera.position.set(
      v.target.x + d * Math.sin(ph) * Math.sin(v.azimuth),
      v.target.y + d * Math.cos(ph),
      v.target.z + d * Math.sin(ph) * Math.cos(v.azimuth),
    );
    const floor = g(camera.position.x, camera.position.z) + 12;
    if (camera.position.y < floor) camera.position.y = floor;
    camera.lookAt(v.target);
    camera.updateMatrixWorld();
  }

  function renderFrame(i) {
    const t = i / FPS;
    const dt = 1 / FPS;
    let si = shots.findIndex((s) => t < s.t0 + s.dur);
    if (si < 0) si = shots.length - 1;
    const s = shots[si];
    const local = Math.min(1, (t - s.t0) / s.dur);
    const u = smooth(local);
    if (si !== lastShot) { s.setup?.(); lastShot = si; }

    setTime(s.hour(u));
    U.uTime.value = t + 40;
    // Advance traffic/metro/plane, then frame the shot (some shots follow them).
    life.update(dt, t, camera);
    const v = s.view(u);
    poseCamera(v);
    life.update(0, t, camera); // re-cull cars around the final camera position

    atmosphere.update(camera, v.target, camera.position.distanceTo(v.target));
    const alt = Math.max(1, camera.position.y - city.ground(camera.position.x, camera.position.z));
    camera.near = reversed ? THREE.MathUtils.clamp(alt * 0.01, 0.3, 5) : THREE.MathUtils.clamp(alt * 0.04, 0.5, 40);
    camera.updateProjectionMatrix();
    city.updateLOD(camera);
    composer.render(dt);

    // Overlay timing.
    const into = t - s.t0, left = s.t0 + s.dur - t;
    const fadeIn = si === 0 ? Math.min(1, t / 1.2) : Math.min(1, into / 0.45);
    const fadeOut = si === shots.length - 1 ? Math.min(1, left / 1.2) : Math.min(1, left / 0.45);
    $('.cine-fade').style.opacity = String(1 - Math.min(fadeIn, fadeOut));
    const titleOp = s.title ? Math.min(1, Math.max(0, (into - 0.8) / 0.8)) * Math.min(1, Math.max(0, (left - 0.6) / 0.8)) : 0;
    $('.cine-title').style.opacity = titleOp;
    $('.cine-title').style.transform = `translateY(calc(-50% + ${((1 - titleOp) * 12).toFixed(1)}px))`;
    const lowOp = s.name ? Math.min(1, Math.max(0, (into - 0.7) / 0.6)) * Math.min(1, Math.max(0, (left - 0.5) / 0.6)) : 0;
    if (s.name) { $('.cine-name').textContent = s.name; $('.cine-sub').textContent = s.sub; }
    $('.cine-lower').style.opacity = lowOp;
    $('.cine-lower').style.transform = `translateX(${(1 - lowOp) * -18}px)`;
    const endOp = s.end ? Math.min(1, Math.max(0, (into - 0.4) / 1.0)) : 0;
    $('.cine-end').style.opacity = endOp;
  }

  window.__cinema = { fps: FPS, frames, duration, renderFrame };
  window.__cinemaCtx = ctx;
  renderFrame(0);
}
