import * as THREE from 'three';

// Uniforms shared by every material in the scene.
export const U = {
  uTerrain: { value: 1 }, // 0 = flattened, 1 = real relief
  uTime: { value: 0 },
  uNight: { value: 0 }, // 0 day … 1 full night (drives window and street lights)
  uDataView: { value: 0 }, // 1 = colour buildings by height data source
  uSelected: { value: -1 }, // building id (1-based) to highlight
  uTreeSway: { value: 1 },
};

const HASH = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;

// Adds `elev` (ground height) displacement scaled by uTerrain.
function elevVertex(shader, extraDecl = '', extraBody = '') {
  shader.uniforms.uTerrain = U.uTerrain;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\nattribute float elev;\nuniform float uTerrain;\n${extraDecl}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\ntransformed.y += elev * uTerrain;\n${extraBody}`);
}

function withElevation(material, key, patch) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U);
    patch(shader);
  };
  material.customProgramCacheKey = () => key;
  return material;
}

export function depthMaterialWithElevation(key) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  return withElevation(m, key + '-depth', (s) => elevVertex(s));
}

// ------------------------------------------------------------------ buildings
export function buildingMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, envMapIntensity: 0.6 });
  return withElevation(m, 'building', (shader) => {
    elevVertex(
      shader,
      `attribute vec2 wuv; attribute float bid; attribute vec2 meta;\nvarying vec2 vWuv; varying float vBid; varying vec2 vMeta; varying vec3 vObjN;`,
      `vWuv = wuv; vBid = bid; vMeta = meta; vObjN = normal;`,
    );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uNight; uniform float uDataView; uniform float uSelected;\nvarying vec2 vWuv; varying float vBid; varying vec2 vMeta; varying vec3 vObjN;\n${HASH}`,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        bool isWall = abs(vObjN.y) < 0.5;
        float flags = vMeta.y;
        float hasWin = mod(flags, 2.0);
        float glassy = mod(floor(flags / 2.0), 2.0);
        float isHouse = mod(floor(flags / 4.0), 2.0);
        float winMask = 0.0, lit = 0.0;
        vec2 cell = vec2(0.0);
        if (isWall) {
          float floorH = 3.2;
          float cellW = glassy > 0.5 ? 1.8 : (isHouse > 0.5 ? 3.6 : 3.0);
          vec2 g = vWuv / vec2(cellW, floorH);
          cell = floor(g);
          vec2 f = fract(g);
          vec2 fw = fwidth(g);
          float fade = 1.0 - smoothstep(0.25, 0.7, max(fw.x, fw.y));
          if (hasWin > 0.5) {
            vec2 lo = glassy > 0.5 ? vec2(0.05, 0.08) : vec2(0.24, 0.3);
            vec2 hi = glassy > 0.5 ? vec2(0.95, 0.92) : vec2(0.76, 0.8);
            vec2 w = smoothstep(lo, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi, f));
            winMask = w.x * w.y * step(0.6, vWuv.y);
            // Some bays have no window, breaking up the grid.
            float bay = hash12(vec2(cell.x, vBid * 0.371));
            if (glassy < 0.5 && bay < 0.18) winMask = 0.0;
            float r = hash12(cell + vec2(vBid * 0.137, vBid * 0.071));
            // Far away the window grid is sub-pixel: fall back to its average coverage.
            lit = step(0.5, r) * mix(glassy > 0.5 ? 0.7 : 0.3, winMask, fade);
            vec3 glass = glassy > 0.5 ? vec3(0.26, 0.34, 0.4) : vec3(0.16, 0.18, 0.2);
            diffuseColor.rgb = mix(diffuseColor.rgb, glass, winMask * 0.8 * fade);
            // Far away: approximate the average darkening of windows.
            diffuseColor.rgb *= mix(1.0 - (glassy > 0.5 ? 0.3 : 0.14), 1.0, fade);
            winMask *= fade;
          }
          // Floor slab lines.
          float slab = 1.0 - smoothstep(0.0, fw.y * 1.5 + 0.02, abs(f.y - 0.02));
          diffuseColor.rgb *= 1.0 - slab * 0.12 * fade * step(1.0, cell.y);
          // Soft ambient occlusion near the ground.
          diffuseColor.rgb *= mix(0.6, 1.0, smoothstep(0.0, 6.0, vWuv.y));
        } else {
          // Roof: subtle grime.
          diffuseColor.rgb *= 0.9 + 0.18 * vnoise(vWuv * 0.35);
        }
        if (uDataView > 0.5) {
          vec3 c = vMeta.x < 0.5 ? vec3(0.05, 0.45, 0.95) : (vMeta.x < 1.5 ? vec3(0.13, 0.6, 0.16) : vec3(1.0, 0.4, 0.05));
          diffuseColor.rgb = mix(diffuseColor.rgb, c, 0.78);
          winMask *= 0.3;
        }
        if (abs(vBid - uSelected) < 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.72, 0.3), 0.55);
        `,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, winMask);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.55, winMask * glassy);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        float tone = hash12(cell * 1.73 + vBid);
        vec3 winLight = tone > 0.78 ? vec3(0.8, 0.88, 1.0) : mix(vec3(1.0, 0.62, 0.3), vec3(1.0, 0.8, 0.52), tone);
        totalEmissiveRadiance += lit * uNight * winLight * (1.2 + 1.4 * tone);
        if (abs(vBid - uSelected) < 0.5) totalEmissiveRadiance += vec3(0.25, 0.14, 0.03) * (0.4 + uNight);`,
      );
  });
}

// ------------------------------------------------------------------ roads & rail
export function roadMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  return withElevation(m, 'road', (shader) => {
    elevVertex(shader, `attribute vec2 wuv; attribute vec3 rinfo; varying vec2 vWuv; varying vec3 vInfo;`, `vWuv = wuv; vInfo = rinfo;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight;\nvarying vec2 vWuv; varying vec3 vInfo;\n${HASH}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        float rank = vInfo.x;
        float halfW = vInfo.z * 0.125;
        float across = vWuv.y * halfW;
        float along = vWuv.x;
        float light = 0.0;
        vec3 col;
        if (rank < 4.5) col = vec3(0.74, 0.69, 0.6);
        else if (rank < 7.5) col = vec3(0.4, 0.4, 0.4);
        else if (rank < 10.5) col = vec3(0.33, 0.33, 0.34);
        else col = vec3(0.27, 0.275, 0.29);
        float grain = vnoise(vec2(along * 1.3, across * 1.3)) * 0.08 + vnoise(vec2(along * 0.05, across * 0.2)) * 0.1;
        col *= 0.92 + grain;
        float fwA = fwidth(across), fwL = fwidth(along);
        float fade = 1.0 - smoothstep(0.08, 0.35, fwA);
        if (rank > 10.5 && rank < 19.5) {
          // Centre dashes and edge lines.
          float centre = 1.0 - smoothstep(0.08, 0.08 + fwA, abs(across));
          float dash = step(fract(along / 9.0), 0.45);
          float edge = 1.0 - smoothstep(0.08, 0.08 + fwA, abs(abs(across) - (halfW - 0.55)));
          float paint = max(centre * dash * (rank > 14.5 ? 0.0 : 1.0), edge * 0.75);
          if (rank > 14.5) {
            float dbl = 1.0 - smoothstep(0.07, 0.07 + fwA, abs(abs(across) - 0.18));
            paint = max(paint, dbl * 0.85);
          }
          col = mix(col, vec3(0.86, 0.84, 0.76), paint * fade * 0.9);
          // Kerb.
          col = mix(col, vec3(0.62, 0.6, 0.56), smoothstep(halfW - 0.3, halfW - 0.1, abs(across)));
        }
        if (rank > 7.5 && rank < 19.5) {
          // Sodium street-light pools, alternating sides every 32 m.
          float seg = floor(along / 32.0);
          float side = mod(seg, 2.0) * 2.0 - 1.0;
          float d = fract(along / 32.0) * 32.0 - 16.0;
          float pool = exp(-(d * d) / 160.0 - pow(across - side * halfW * 0.8, 2.0) / (18.0 + halfW * 3.0));
          light = (pool * 0.8 + 0.2) * (rank > 12.5 ? 1.0 : rank > 10.5 ? 0.6 : 0.22);
        }
        if (rank > 19.5) {
          bool metro = rank > 20.5;
          float gauge = metro ? 0.72 : 0.84;
          col = metro ? vec3(0.6, 0.6, 0.58) : vec3(0.44, 0.4, 0.37) * (0.9 + grain);
          float sleeper = step(fract(along / 0.65), 0.38) * step(abs(across), gauge + 0.35);
          col = mix(col, metro ? vec3(0.5, 0.5, 0.5) : vec3(0.32, 0.28, 0.25), sleeper * fade);
          float rail = 1.0 - smoothstep(0.05, 0.05 + fwA, abs(abs(across) - gauge));
          col = mix(col, vec3(0.62, 0.62, 0.64), rail * max(fade, 0.5));
        }
        // Palette above is authored in sRGB; lighting works in linear.
        diffuseColor.rgb = pow(col, vec3(2.2));
        `,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += light * uNight * vec3(1.0, 0.62, 0.28) * 0.55;`,
      );
  });
}

export function structureMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xc4bfb5, roughness: 0.85 });
  return withElevation(m, 'structure', (s) => elevVertex(s));
}

// ------------------------------------------------------------------ water
export function waterMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0x2b4a45, roughness: 0.11, metalness: 0.15, envMapIntensity: 1.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  return withElevation(m, 'water', (shader) => {
    elevVertex(shader, `varying vec3 vWPos;`, ``);
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; uniform float uNight;\nvarying vec3 vWPos;\n${HASH}`)
      .replace(
        '#include <color_fragment>',
        /* glsl */ `#include <color_fragment>
        vec2 wp = vWPos.xz;
        float weed = smoothstep(0.62, 0.7, fbm(wp * 0.02 + vec2(uTime * 0.002, 0.0)));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.3, 0.12), weed * 0.85);
        diffuseColor.rgb *= 0.9 + 0.2 * fbm(wp * 0.006);`,
      )
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.8, weed);`)
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          vec2 p = vWPos.xz * 0.09;
          float t = uTime * 0.6;
          float e = 0.25;
          float h0 = fbm(p + vec2(t * 0.3, t * 0.2));
          float hx = fbm(p + vec2(e, 0.0) + vec2(t * 0.3, t * 0.2));
          float hz = fbm(p + vec2(0.0, e) + vec2(t * 0.3, t * 0.2));
          vec3 rip = vec3(h0 - hx, 0.0, h0 - hz) * 1.2 * (1.0 - weed);
          normal = normalize(normal + (viewMatrix * vec4(rip, 0.0)).xyz);
        }`,
      );
  });
}

// ------------------------------------------------------------------ terrain
export function terrainMaterial(map) {
  const m = new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 });
  return withElevation(m, 'terrain', (shader) => {
    elevVertex(shader, `varying vec3 vWPos;`, ``);
    shader.vertexShader = shader.vertexShader
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\nobjectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, uTerrain));`)
      .replace('#include <project_vertex>', `#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWPos;\n${HASH}`)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>\nfloat dn = fbm(vWPos.xz * 0.12) * 0.6 + fbm(vWPos.xz * 0.9) * 0.4;\ndiffuseColor.rgb *= 0.86 + 0.26 * dn;`,
      );
  });
}

export function skirtMaterial(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 1 });
}

// ------------------------------------------------------------------ trees
export function treeMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uTreeSway = U.uTreeSway;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime; uniform float uTreeSway;`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        float ph = instanceMatrix[3].x * 0.05 + instanceMatrix[3].z * 0.07;
        #else
        float ph = 0.0;
        #endif
        float bend = max(0.0, position.y - 2.0) * 0.012 * uTreeSway;
        transformed.x += sin(uTime * 1.3 + ph) * bend;
        transformed.z += cos(uTime * 1.1 + ph * 1.3) * bend * 0.6;`,
      );
  };
  m.customProgramCacheKey = () => 'tree';
  return m;
}

// ------------------------------------------------------------------ vehicles
export function carMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.4 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = U.uNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvLocal = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uNight; varying vec3 vLocal;`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float front = step(1.95, vLocal.z) * step(vLocal.y, 0.95) * step(0.35, vLocal.y);
        float back = step(vLocal.z, -1.95) * step(vLocal.y, 0.95) * step(0.35, vLocal.y);
        totalEmissiveRadiance += (front * vec3(3.0, 2.8, 2.2) + back * vec3(2.4, 0.15, 0.1)) * (0.15 + uNight);`,
      );
  };
  m.customProgramCacheKey = () => 'car';
  return m;
}

// ------------------------------------------------------------------ picking
export function pickMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTerrain: U.uTerrain },
    vertexShader: /* glsl */ `
      attribute float elev; attribute float bid; uniform float uTerrain; varying float vBid;
      void main() {
        vec3 p = position; p.y += elev * uTerrain; vBid = bid;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying float vBid;
      void main() {
        float id = floor(vBid + 0.5);
        gl_FragColor = vec4(mod(id, 256.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, floor(id / 65536.0) / 255.0, 1.0);
      }`,
  });
}
export function pickOccluderMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTerrain: U.uTerrain },
    vertexShader: `attribute float elev; uniform float uTerrain; void main() { vec3 p = position; p.y += elev * uTerrain; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
    fragmentShader: `void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }`,
  });
}
