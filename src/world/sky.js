import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { U } from './materials.js';

const LAT = 18.553, LON = 73.903, TZ = 5.5; // Pune, IST

// NOAA-style solar position. Returns elevation/azimuth (radians, azimuth clockwise from north).
export function solarPosition(date, hourLocal) {
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const doy = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 864e5);
  const g = ((2 * Math.PI) / 365) * (doy - 1 + (hourLocal - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const tst = hourLocal * 60 + eqTime + 4 * LON - 60 * TZ;
  const ha = ((tst / 4 - 180) * Math.PI) / 180;
  const lat = (LAT * Math.PI) / 180;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  let az = Math.acos(Math.max(-1, Math.min(1, (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zen)))));
  az = ha > 0 ? (az + Math.PI) % (2 * Math.PI) : (3 * Math.PI - az) % (2 * Math.PI);
  return { elevation: Math.PI / 2 - zen, azimuth: az };
}
export function dirFromAngles(elevation, azimuth, out = new THREE.Vector3()) {
  // north = -z, east = +x
  return out.set(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), -Math.cos(azimuth) * Math.cos(elevation));
}
// Hours of sunrise/sunset today (by bisection on elevation).
export function sunTimes(date) {
  const find = (a, b) => {
    for (let i = 0; i < 30; i++) {
      const m = (a + b) / 2;
      const up = solarPosition(date, m).elevation > -0.0145;
      if (up === solarPosition(date, a).elevation > -0.0145) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  return { sunrise: find(3, 12), sunset: find(12, 21) };
}

const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerpC = (a, b, t) => a.clone().lerp(b, t);

export class Atmosphere {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.date = new Date();
    this.hour = 17.5;
    this.sunDir = new THREE.Vector3();
    this.moonDir = new THREE.Vector3();

    // Sky dome (Preetham scattering).
    this.sky = new Sky();
    this.sky.scale.setScalar(90000);
    this.sky.material.fog = false;
    Object.assign(this.sky.material.uniforms, {});
    scene.add(this.sky);
    const su = this.sky.material.uniforms;
    su.turbidity.value = 7.5; // monsoon-season haze
    su.rayleigh.value = 1.6;
    su.mieCoefficient.value = 0.006;
    su.mieDirectionalG.value = 0.82;

    // Night sky: stars + moon.
    this.stars = this.makeStars();
    scene.add(this.stars);
    this.moon = new THREE.Mesh(new THREE.CircleGeometry(900, 48), new THREE.MeshBasicMaterial({ color: 0xf2efe6, fog: false, transparent: true }));
    scene.add(this.moon);

    this.clouds = this.makeClouds();
    scene.add(this.clouds);

    // Lights.
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.6;
    const sc = this.sun.shadow.camera;
    sc.near = 100; sc.far = 7000;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd4ee, 0x6b6552, 0.9);
    scene.add(this.hemi);
    this.fill = new THREE.AmbientLight(0x8090b0, 0.05);
    scene.add(this.fill);

    scene.fog = new THREE.FogExp2(0xbfcad3, 0.00009);

    // Environment map for PBR reflections, regenerated when the sky changes.
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envDome = new THREE.Mesh(
      new THREE.SphereGeometry(100, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: {
          uTop: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
          uSunDir: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
        },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform vec3 uTop, uHorizon, uGround, uSunDir, uSunColor; varying vec3 vDir;
          void main(){
            vec3 d = normalize(vDir);
            vec3 c = d.y > 0.0 ? mix(uHorizon, uTop, pow(d.y, 0.6)) : mix(uHorizon, uGround, pow(-d.y, 0.4));
            c += uSunColor * pow(max(0.0, dot(d, uSunDir)), 400.0) + uSunColor * 0.08 * pow(max(0.0, dot(d, uSunDir)), 8.0);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    );
    this.envScene.add(this.envDome);
    this.envKey = null;
  }

  makeStars() {
    const n = 2600, pos = new Float32Array(n * 3), size = new Float32Array(n);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < n; i++) {
      const u = rnd(), v = rnd() * 0.95;
      const th = 2 * Math.PI * u, ph = Math.acos(1 - v);
      pos[i * 3] = 60000 * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = 60000 * Math.cos(ph);
      pos[i * 3 + 2] = 60000 * Math.sin(ph) * Math.sin(th);
      size[i] = 0.6 + Math.pow(rnd(), 6) * 3.2;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      uniforms: { uAlpha: { value: 0 }, uTime: U.uTime },
      vertexShader: `attribute float size; varying float vS; uniform float uTime; void main(){ vS = size; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size * (1.0 + 0.25*sin(uTime*2.0 + position.x)); }`,
      fragmentShader: `uniform float uAlpha; varying float vS; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vec3(0.9,0.93,1.0), a * uAlpha * min(1.0, vS)); }`,
    });
    const p = new THREE.Points(g, m);
    p.frustumCulled = false;
    return p;
  }

  makeClouds() {
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
      uniforms: { uTime: U.uTime, uSun: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(0.7, 0.75, 0.8) }, uCover: { value: 0.52 }, uAlpha: { value: 1 } },
      vertexShader: `varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uSun; uniform vec3 uShade; uniform float uCover; uniform float uAlpha;
        varying vec2 vUv; varying vec3 vW;
        float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f); return mix(mix(h(i),h(i+vec2(1,0)),u.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x),u.y); }
        float fbm(vec2 p){ float s=0., a=.5; for(int i=0;i<6;i++){ s+=a*n(p); p=p*2.02+vec2(1.7,9.2); a*=.5; } return s; }
        void main(){
          vec2 p = vW.xz * 0.00016 + vec2(uTime * 0.0016, uTime * 0.0006);
          float d = fbm(p);
          float c = smoothstep(uCover, uCover + 0.22, d);
          float edge = length(vUv - 0.5) * 2.0;
          c *= 1.0 - smoothstep(0.55, 1.0, edge);
          float lit = smoothstep(uCover, uCover + 0.5, fbm(p + vec2(0.03)));
          vec3 col = mix(uSun, uShade, lit * 0.7);
          gl_FragColor = vec4(col, c * 0.82 * uAlpha);
        }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000), m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 2600;
    mesh.renderOrder = -1;
    return mesh;
  }

  setTime(hour) {
    this.hour = ((hour % 24) + 24) % 24;
    const { elevation, azimuth } = solarPosition(this.date, this.hour);
    dirFromAngles(elevation, azimuth, this.sunDir);
    // Moon: roughly opposite the sun, tilted — good enough for ambience.
    const moonEl = Math.max(0.25, -elevation * 0.8 + 0.2);
    dirFromAngles(moonEl, (azimuth + Math.PI * 0.92) % (2 * Math.PI), this.moonDir);
    this.elevation = elevation;

    const elDeg = (elevation * 180) / Math.PI;
    const day = smooth(-6, 8, elDeg); // 0 night … 1 day
    const golden = Math.max(0, 1 - Math.abs(elDeg - 3) / 12) * smooth(-7, 0, elDeg);
    this.day = day;
    this.golden = golden;
    U.uNight.value = 1 - smooth(-5, 4, elDeg);

    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(this.sunDir).multiplyScalar(1000);
    su.turbidity.value = 6 + golden * 4;
    su.rayleigh.value = 1.4 + golden * 1.4 + (1 - day) * 0.8;

    // Sun / moon light.
    const sunCol = lerpC(new THREE.Color(1.0, 0.45, 0.2), new THREE.Color(1.0, 0.96, 0.9), smooth(1, 28, elDeg));
    if (elDeg > -3) {
      this.sun.color.copy(sunCol);
      this.sun.intensity = 3.8 * smooth(-3, 6, elDeg);
      this.lightDir = this.sunDir;
    } else {
      this.sun.color.setRGB(0.55, 0.65, 0.95);
      this.sun.intensity = 0.28 * smooth(-3, -12, elDeg);
      this.lightDir = this.moonDir;
    }
    this.hemi.color.copy(lerpC(new THREE.Color(0.26, 0.32, 0.55), new THREE.Color(0.72, 0.82, 0.95), day)).lerp(new THREE.Color(0.95, 0.7, 0.55), golden * 0.35);
    this.hemi.groundColor.copy(lerpC(new THREE.Color(0.08, 0.08, 0.1), new THREE.Color(0.45, 0.42, 0.34), day));
    this.hemi.intensity = 0.32 + day * 0.13 + golden * 0.1;
    this.fill.intensity = 0.05 + (1 - day) * 0.1;

    // Fog tracks the horizon colour.
    const fogDay = new THREE.Color(0.74, 0.8, 0.86);
    const fogGold = new THREE.Color(0.9, 0.66, 0.5);
    const fogNight = new THREE.Color(0.05, 0.07, 0.12);
    const fc = lerpC(fogNight, fogDay, day).lerp(fogGold, golden * 0.7);
    this.scene.fog.color.copy(fc);
    this.scene.fog.density = 0.000075 + golden * 0.00003 + (1 - day) * 0.00002;
    this.renderer.setClearColor(fc);

    // Night sky.
    this.stars.material.uniforms.uAlpha.value = 1 - smooth(-10, -2, elDeg);
    this.moon.visible = elDeg < 2;
    this.moon.material.opacity = 1 - smooth(-6, 2, elDeg);

    const cu = this.clouds.material.uniforms;
    cu.uSun.value.copy(lerpC(new THREE.Color(0.12, 0.14, 0.2), new THREE.Color(1, 0.98, 0.96), day)).lerp(new THREE.Color(1.0, 0.62, 0.42), golden * 0.8);
    cu.uShade.value.copy(lerpC(new THREE.Color(0.06, 0.07, 0.1), new THREE.Color(0.66, 0.7, 0.78), day)).lerp(new THREE.Color(0.55, 0.38, 0.4), golden * 0.6);

    this.renderer.toneMappingExposure = 0.6 + day * 0.28 + golden * 0.12;
    this.updateEnvironment(elDeg);
  }

  // Reflection environment: a gradient dome in display-range colours (the Preetham
  // sky itself is far too bright to light the scene with).
  updateEnvironment(elDeg) {
    const key = Math.round(elDeg * 2) + ':' + Math.round(this.sunDir.x * 10) + ':' + Math.round(this.sunDir.z * 10);
    if (key === this.envKey) return;
    this.envKey = key;
    const u = this.envDome.material.uniforms;
    u.uTop.value.copy(this.hemi.color).multiplyScalar(0.55 + this.day * 0.3);
    u.uHorizon.value.copy(this.scene.fog.color).multiplyScalar(0.9);
    u.uGround.value.copy(this.hemi.groundColor).multiplyScalar(0.6);
    u.uSunDir.value.copy(this.sunDir);
    u.uSunColor.value.copy(this.sun.color).multiplyScalar(this.elevation > 0 ? 4 : 0);
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.02);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.25 + this.day * 0.2;
  }

  // Keep the shadow frustum centred on what the camera is looking at.
  update(camera, focus, viewDist) {
    const size = THREE.MathUtils.clamp(viewDist * 0.9, 250, 3200);
    const sc = this.sun.shadow.camera;
    if (sc.right !== size) {
      sc.left = -size; sc.right = size; sc.top = size; sc.bottom = -size;
      sc.updateProjectionMatrix();
    }
    // Snap to shadow texels to avoid shimmering while moving.
    const texel = (size * 2) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    const d = this.lightDir || this.sunDir;
    this.sun.target.position.set(fx, focus.y, fz);
    // Light sits 3 km out; bias is in normalised depth over a 7 km range (1e-5 ≈ 7 cm).
    this.sun.position.set(fx + d.x * 3000, focus.y + Math.max(0.05, d.y) * 3000, fz + d.z * 3000);
    this.sun.shadow.bias = -0.00001 - 0.00002 * (size / 3200);
    this.sun.shadow.normalBias = 0.25 + (size / 3200) * 1.2;
    this.stars.position.copy(camera.position);
    this.moon.position.copy(camera.position).addScaledVector(this.moonDir, 55000);
    this.moon.lookAt(camera.position);
    this.clouds.position.x = camera.position.x;
    this.clouds.position.z = camera.position.z;
    this.sky.position.copy(camera.position);
  }
}
