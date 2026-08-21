// IRONWILD - procedural terrain: heightfield source of truth + ground/water meshes.
// terrainHeight() is THE single source of truth; geometry vertices are generated
// from it, and gameplay (player gravity, AI, prop placement) queries it directly.
// v3: water sheet gained gentle GPU vertex waves + shore-faded opacity
// (onBeforeCompile injection, driven by updateWaterWaves from environment.js).

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { clamp, smoothstep, fbm2 } from '../core/utils.js';

const SEG = 128;                 // grid segments per side (perf cap: 128x128)
const WATER_SEG = 32;            // v3 wave grid per side (contract cap: 32x32)
const LAKE_X = 0;                // lake basin centre
const LAKE_Z = -60;
const LAKE_R = 58;               // basin influence radius
const NORMAL_EPS = 0.5;          // finite-difference step for normalAt()

// v3 water-wave clock, shared with the material injected below. environment.js
// advances it every frame via updateWaterWaves(); safe to set before compile.
const waveUniform = { value: 0 };

// v6: live sky-gradient + sun-glint uniforms for the water's fresnel term (a
// cheap "reflection" stand-in - matching the sky's current day/night/storm
// colour reads far better than a flat highlight, without a second scene
// render). environment.js writes these every frame via setWaterSkyUniforms().
const skyTopUniform = { value: new THREE.Color(0x5e93c8) };
const skyHorizonUniform = { value: new THREE.Color(0xc4d3de) };
const sunDirUniform = { value: new THREE.Vector3(0.8, 0.6, 0.35) };
const sunColorUniform = { value: new THREE.Color(0xfff1d6) };
const sunVisUniform = { value: 1 }; // 0..1 day/dusk glint visibility (fades at night)

/**
 * Ground height at world (x, z). Pure + deterministic (seeded fbm).
 * Character: rolling grassland around y≈4, mid-frequency ridges, a lake basin
 * near (0, -60) dipping below CONFIG.waterLevel, and a mountain ring rising
 * beyond CONFIG.playRadius to form the natural world border.
 */
export function terrainHeight(x, z) {
  // Rolling grassland: broad fbm hills.
  let h = 4 + (fbm2(x * 0.0075, z * 0.0075, 4) - 0.5) * 13;
  // Modest mid-frequency ridges for secondary relief.
  h += (fbm2(x * 0.028 + 41.7, z * 0.028 - 17.3, 3) - 0.5) * 4.5;

  // Spawn meadow: flatten low spots so the start point stays dry. Applied
  // before the lake dip so the basin always carves through it.
  const r = Math.sqrt(x * x + z * z);
  const meadow = smoothstep(42, 16, r);
  if (meadow > 0) {
    const floor = 2.4 + meadow * 1.8; // rises to y≈4.2 at the centre
    if (h < floor) h = floor;
  }

  // Lake basin: smooth radial depression centred on (LAKE_X, LAKE_Z).
  const dx = x - LAKE_X;
  const dz = z - LAKE_Z;
  const dl = Math.sqrt(dx * dx + dz * dz);
  const basin = smoothstep(LAKE_R, LAKE_R * 0.25, dl); // 1 at centre -> 0 at rim
  h -= basin * basin * 13;

  // Mountain ring past the playable radius, saturating at the world edge.
  const ring = smoothstep(CONFIG.playRadius - 25, CONFIG.worldSize * 0.5 - 8, r);
  h += ring * ring * 88;

  return h;
}

/** Alias of terrainHeight (contract name used by gameplay systems). */
export const heightAt = terrainHeight;

// ---- v2 biomes -------------------------------------------------------------
// Biomes are a pure classification over (x,z): dense forest in the NE quadrant,
// rocky highlands in the S, sandy shore hugging the waterline, meadow elsewhere.
// terrainHeight() is deliberately untouched - biomes change ground colour and
// prop density only, so v1 gameplay geometry is bit-identical.

const BIOME_EDGE = 0.45; // factor threshold for a hard biomeAt verdict

/** 0..1 forest density factor (NE quadrant, fbm-perturbed organic edge). */
function forestFactor(x, z) {
  const mask = smoothstep(20, 110, x) * smoothstep(20, 110, -z);
  const n = fbm2(x * 0.011 + 7.7, z * 0.011 - 3.1, 2);
  return clamp(mask * (0.35 + n * 1.3), 0, 1);
}

/** 0..1 highland rockiness factor (S half, fbm-perturbed edge). */
function highlandFactor(x, z) {
  const mask = smoothstep(30, 130, z);
  const n = fbm2(x * 0.013 - 13.9, z * 0.013 + 5.5, 2);
  return clamp(mask * (0.35 + n * 1.3), 0, 1);
}

/**
 * Biome id at world (x,z): 'meadow' | 'forest' | 'highland' | 'shore'.
 * Shore wins first (any low ground at the waterline), then the stronger of
 * forest/highland past the edge threshold, else meadow.
 */
export function biomeAt(x, z) {
  if (terrainHeight(x, z) < CONFIG.waterLevel + 1.1) return 'shore';
  const f = forestFactor(x, z);
  const hl = highlandFactor(x, z);
  if (f >= hl) return f > BIOME_EDGE ? 'forest' : 'meadow';
  return hl > BIOME_EDGE ? 'highland' : 'meadow';
}

/**
 * Continuous biome factors for prop distribution / tinting. Writes
 * {forest, highland} into `out` (reused object to avoid allocations) and
 * returns it. Build-time convenience alongside the discrete biomeAt().
 */
export function biomeFactors(x, z, out = { forest: 0, highland: 0 }) {
  out.forest = forestFactor(x, z);
  out.highland = highlandFactor(x, z);
  return out;
}

/**
 * Finite-difference surface normal at (x, z).
 * Pass `out` (Vector3) to avoid allocation in hot loops.
 */
export function normalAt(x, z, out = new THREE.Vector3()) {
  const hx = terrainHeight(x + NORMAL_EPS, z) - terrainHeight(x - NORMAL_EPS, z);
  const hz = terrainHeight(x, z + NORMAL_EPS) - terrainHeight(x, z - NORMAL_EPS);
  return out.set(-hx / (2 * NORMAL_EPS), 1, -hz / (2 * NORMAL_EPS)).normalize();
}

// Terrain palette (ARCHITECTURE.md visual style guide + v2 biome tints).
const GRASS_A = new THREE.Color(0x6a8f4f);
const GRASS_B = new THREE.Color(0x8aa85c);
const ROCK = new THREE.Color(0x7d7f82);
const ROCK_HIGH = new THREE.Color(0x9a9da1);
const SAND = new THREE.Color(0xc7b077);
const FOREST_GRASS = new THREE.Color(0x557a42); // deeper green canopy floor
const FOREST_SOIL = new THREE.Color(0x4a4030);  // dark soil tint (NE forest)
const HIGHLAND_GRASS = new THREE.Color(0x9a8f6e); // grey-brown dry grass (S)

// Scratch colour for the build-time bake (not a hot loop).
const _col = new THREE.Color();

/** Per-face ground colour from centroid height + face slope. Writes into `out`. */
function faceColor(out, h, ny, x, z) {
  // Patchy grass mix.
  const patch = fbm2(x * 0.045 + 91.2, z * 0.045 + 33.8, 2);
  out.copy(GRASS_A).lerp(GRASS_B, patch);
  // Biome tints: dark soil + deeper green in the forest, grey-brown in the S.
  const ff = forestFactor(x, z);
  const hf = highlandFactor(x, z);
  out.lerp(FOREST_GRASS, ff * 0.45);
  out.lerp(FOREST_SOIL, ff * 0.38);
  out.lerp(HIGHLAND_GRASS, hf * 0.6);
  // Rock on steep slopes and high altitudes (mountain ring); highlands
  // rock over on much gentler slopes.
  const rocky = Math.max(
    smoothstep(0.82, 0.6, ny),
    smoothstep(24, 46, h),
    hf * smoothstep(0.93, 0.72, ny),
  );
  out.lerp(ROCK, rocky);
  out.lerp(ROCK_HIGH, smoothstep(62, 86, h) * 0.8);
  // Sandy band around the waterline.
  const sandy = 1 - smoothstep(CONFIG.waterLevel + 0.35, CONFIG.waterLevel + 1.7, h);
  out.lerp(SAND, sandy * (1 - rocky * 0.6));
  // Darker moisture ring right at the shore.
  const moist = 1 - smoothstep(0.5, 1.4, Math.abs(h - CONFIG.waterLevel));
  out.multiplyScalar(1 - moist * 0.22);
  // Lake bed darkens with depth.
  out.multiplyScalar(1 - smoothstep(CONFIG.waterLevel, CONFIG.waterLevel - 7, h) * 0.4);
}

// ---- shoreline foam ring ---------------------------------------------------

const FOAM_SEGMENTS = 96;   // angular resolution of the traced waterline
const FOAM_NAME = 'ironwild_foam'; // environment.js finds + animates it by name

/**
 * Traces the real waterline (first radial crossing of the lake basin) and
 * builds a flat foam ribbon hugging it, local to the lake centre so the mesh
 * can breathe/scale in place. Zero-width segments where a ray never crosses
 * keep the strip closed without drawing foam over dry land.
 */
function buildFoamRing() {
  const wl = CONFIG.waterLevel;
  const cos = new Float32Array(FOAM_SEGMENTS);
  const sin = new Float32Array(FOAM_SEGMENTS);
  const innerR = new Float32Array(FOAM_SEGMENTS);
  const outerR = new Float32Array(FOAM_SEGMENTS);

  for (let i = 0; i < FOAM_SEGMENTS; i++) {
    const a = (i / FOAM_SEGMENTS) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    cos[i] = ca;
    sin[i] = sa;
    // March outward for the first rise through the water level.
    let rCross = -1;
    let prevH = terrainHeight(LAKE_X + ca * 6, LAKE_Z + sa * 6);
    for (let r = 7; r <= LAKE_R + 34; r++) {
      const h = terrainHeight(LAKE_X + ca * r, LAKE_Z + sa * r);
      if (prevH < wl && h >= wl) {
        const t = (wl - prevH) / (h - prevH); // linear refine within the step
        rCross = r - 1 + t;
        break;
      }
      prevH = h;
    }
    if (rCross < 0) {
      innerR[i] = 0; // degenerate: no waterline along this ray
      outerR[i] = 0;
      continue;
    }
    // Organic width variation around the traced edge.
    const n = fbm2(ca * 2.3 + 51.7, sa * 2.3 - 12.4, 2);
    innerR[i] = rCross - (1.0 + n * 1.4);
    outerR[i] = rCross + (0.35 + n * 0.8);
  }

  // Ribbon: two vertices per angle (+ duplicated seam), y = 0 locally.
  const vertCount = (FOAM_SEGMENTS + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  for (let i = 0; i <= FOAM_SEGMENTS; i++) {
    const j = i % FOAM_SEGMENTS; // seam wraps to segment 0
    const x = cos[j];
    const z = sin[j];
    let o = i * 6;
    positions[o] = x * innerR[j];
    positions[o + 2] = z * innerR[j];
    o += 3;
    positions[o] = x * outerR[j];
    positions[o + 2] = z * outerR[j];
    o = i * 4;
    uvs[o] = 0;                    // inner edge: across = 0
    uvs[o + 2] = 1;                // outer edge: across = 1
    uvs[o + 1] = i / FOAM_SEGMENTS; // v runs around the ring
    uvs[o + 3] = i / FOAM_SEGMENTS;
  }
  const indices = [];
  for (let i = 0; i < FOAM_SEGMENTS; i++) {
    const a = i * 2;
    // Wound CCW seen from above: outer_i - inner_i points outward radially,
    // so the naive (a, a+1, a+2) order faces -Y and gets front-face culled.
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();

  // Cheap animated foam: width fade + bands crawling around the shore +
  // slow opacity pulse, all driven from the single uTime uniform.
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        float across = smoothstep(0.0, 0.35, vUv.x) * (1.0 - smoothstep(0.45, 1.0, vUv.x));
        float bands = 0.55 + 0.45 * sin(vUv.y * 90.0 - uTime * 1.3);
        float pulse = 0.78 + 0.22 * sin(uTime * 1.7);
        float a = across * bands * pulse * 0.55;
        gl_FragColor = vec4(0.92, 0.97, 1.0, a);
      }`,
  });
  const foam = new THREE.Mesh(geo, mat);
  foam.name = FOAM_NAME;
  foam.position.set(LAKE_X, wl + 0.06, LAKE_Z); // just above the water sheet
  foam.renderOrder = 2; // after the translucent water plane
  G.scene.add(foam);
  return foam;
}

// v7: shared GLSL for world-space value noise + fbm. Cheap hash-based value
// noise (no textures) used by the ground detail injection below.
const NOISE_GLSL = /* glsl */`
  float iwHash(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }
  float iwNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = iwHash(i);
    float b = iwHash(i + vec2(1.0, 0.0));
    float c = iwHash(i + vec2(0.0, 1.0));
    float d = iwHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float iwFbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * iwNoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }`;

/**
 * v7: inject procedural surface detail into the ground's standard material.
 * Adds a world-position varying, then in the fragment stage:
 *   - modulates the baked diffuse with multi-scale colour noise (soil/grass
 *     mottling + a faint macro tint drift) so no two facets read identical;
 *   - perturbs the shading normal by the gradient of a fine noise field, so
 *     the flat ground catches directional light as micro-relief.
 * Works alongside flatShading (we perturb the geometric normal, not replace).
 */
function addGroundDetail(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vIwWorld;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvIwWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec3 vIwWorld;\n${NOISE_GLSL}`,
      )
      // Perturb the (flat) geometric normal with a fine noise gradient before
      // lighting - gives the ground tactile micro-relief under the sun.
      .replace(
        '#include <normal_fragment_begin>',
        [
          '#include <normal_fragment_begin>',
          'vec2 nq = vIwWorld.xz * 1.6;',
          'float e = 0.35;',
          'float nx = iwFbm(nq + vec2(e, 0.0)) - iwFbm(nq - vec2(e, 0.0));',
          'float nz = iwFbm(nq + vec2(0.0, e)) - iwFbm(nq - vec2(0.0, e));',
          'normal = normalize(normal + vec3(-nx, 0.0, -nz) * 1.4);',
        ].join('\n'),
      )
      // Multi-scale colour break-up over the baked vertex colour.
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          'float dFine = iwFbm(vIwWorld.xz * 2.3);',
          'float dMid = iwFbm(vIwWorld.xz * 0.45 + 11.7);',
          'float dMacro = iwNoise(vIwWorld.xz * 0.06 + 3.1);',
          // Fine mottling darkens crevices / lightens raised specks (+/-18%).
          'diffuseColor.rgb *= 0.82 + dFine * 0.36;',
          // Mid-scale patchiness: cool/warm drift so grass isn\'t one tone.',
          'diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.03, 0.9), dMid * 0.5);',
          // Macro tint drift keeps large areas from banding.',
          'diffuseColor.rgb *= 0.94 + dMacro * 0.12;',
        ].join('\n'),
      );
  };
}

/**
 * Builds the ground mesh + water plane and adds them to G.scene.
 * Returns { groundMesh, waterMesh } (+ foamMesh, additive in v2).
 */
export function createTerrain() {
  const size = CONFIG.worldSize;

  // Ground: displaced plane, non-indexed so every facet gets one solid colour.
  let geo = new THREE.PlaneGeometry(size, size, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  geo = geo.toNonIndexed();
  geo.deleteAttribute('uv'); // no maps -> save memory
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  }

  // Bake per-face vertex colours from centroid height + face normal.
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i += 3) {
    const x0 = pos.getX(i), y0 = pos.getY(i), z0 = pos.getZ(i);
    const x1 = pos.getX(i + 1), y1 = pos.getY(i + 1), z1 = pos.getZ(i + 1);
    const x2 = pos.getX(i + 2), y2 = pos.getY(i + 2), z2 = pos.getZ(i + 2);
    // Face normal = normalize(cross(B - A, C - A)); only need its Y component.
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    faceColor(_col, (y0 + y1 + y2) / 3, ny * il, (x0 + x1 + x2) / 3, (z0 + z1 + z2) / 3);
    for (let k = 0; k < 3; k++) {
      const o = (i + k) * 3;
      colors[o] = _col.r;
      colors[o + 1] = _col.g;
      colors[o + 2] = _col.b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeBoundingSphere();

  const groundMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1.0,
    metalness: 0.0,
  });
  // v7: procedural surface detail. The baked per-face colour reads as flat
  // "plastic" ground; injecting multi-octave world-space value noise into the
  // fragment stage adds (a) fine soil/grass colour break-up at several scales
  // and (b) a micro-normal perturbation so the terrain catches light like a
  // textured surface instead of a matte sheet - the single biggest lift from
  // stylised toward AAA, at the cost of one varying + a cheap noise loop.
  addGroundDetail(groundMat);
  const groundMesh = new THREE.Mesh(geo, groundMat);
  groundMesh.receiveShadow = true; // terrain receives but does not cast (perf rules)
  G.scene.add(groundMesh);

  // Water sheet across the whole world at the lake level. environment.js
  // finds it by name for the nightly shimmer. v3: 32x32 grid so the vertex
  // shader can displace gentle waves; opacity fades out toward the shore.
  const waterGeo = new THREE.PlaneGeometry(size, size, WATER_SEG, WATER_SEG);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x3d6f7d,
    transparent: true,
    opacity: 0.75,
    roughness: 0.35,
    metalness: 0.1,
  });
  // v3 waves + shore fade, injected into the standard material (one draw call,
  // no CPU vertex streaming). Local xz == world xz (mesh sits at the origin).
  // v4: fresnel rim - a self-contained view direction varying (rather than
  // relying on the standard shader's own conditionally-declared vViewPosition)
  // brightens the water at grazing angles, the cheap stand-in for a real
  // reflection probe.
  waterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uWaveTime = waveUniform;
    shader.uniforms.uSkyTop = skyTopUniform;
    shader.uniforms.uSkyHorizon = skyHorizonUniform;
    shader.uniforms.uSunDir = sunDirUniform;
    shader.uniforms.uSunColor = sunColorUniform;
    shader.uniforms.uSunVis = sunVisUniform;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWaveTime;\nvarying vec2 vLakePos;\nvarying vec3 vWaterWorldPos;\nvarying vec3 vWNormal;',
      )
      .replace(
        '#include <begin_vertex>',
        [
          '#include <begin_vertex>',
          'vLakePos = position.xz;',
          'float wv = sin(position.x * 0.16 + uWaveTime * 1.15) * cos(position.z * 0.13 - uWaveTime * 0.85)',
          '  + 0.6 * sin((position.x + position.z) * 0.07 + uWaveTime * 0.6);',
          'transformed.y += wv * 0.13;',
          'vWaterWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
          'vWNormal = normalize(mat3(modelMatrix) * objectNormal);', // world space
        ].join('\n'),
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying vec2 vLakePos;',
          'varying vec3 vWaterWorldPos;',
          'varying vec3 vWNormal;',
          'const vec2 LAKE_C = vec2(0.0, -60.0);',
          'uniform vec3 uSkyTop;',
          'uniform vec3 uSkyHorizon;',
          'uniform vec3 uSunDir;',
          'uniform vec3 uSunColor;',
          'uniform float uSunVis;',
        ].join('\n'),
      )
      .replace(
        '#include <color_fragment>',
        [
          '#include <color_fragment>',
          'float dl = length(vLakePos - LAKE_C);',
          'diffuseColor.a *= mix(0.55, 1.0, 1.0 - smoothstep(26.0, 60.0, dl));',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>', // renamed from output_fragment in three r154
        [
          // v6: the fresnel highlight now samples the LIVE sky gradient along
          // the reflected view ray instead of a flat colour - a free "sky
          // reflection" that already tracks day/night/dusk/storm exactly,
          // plus a sun glint so a low sun glitters across the wave crests
          // the way real open water does. Injected right before
          // opaque_fragment: outgoingLight is final there but still
          // pre-tonemapping / pre-fog.
          'vec3 waterViewDir = normalize(cameraPosition - vWaterWorldPos);',
          'vec3 waterNormal = normalize(vWNormal);', // world space (`normal` is view space here)
          'float waterFresnel = pow(1.0 - max(dot(waterNormal, waterViewDir), 0.0), 3.0);',
          'vec3 reflectDir = reflect(-waterViewDir, waterNormal);',
          'vec3 skyReflect = mix(uSkyHorizon, uSkyTop, smoothstep(-0.1, 0.5, reflectDir.y));',
          'outgoingLight += waterFresnel * 0.5 * skyReflect;',
          'float glint = pow(max(dot(reflectDir, normalize(uSunDir)), 0.0), 260.0);',
          'outgoingLight += glint * uSunVis * 2.2 * uSunColor;',
          '#include <opaque_fragment>',
        ].join('\n'),
      );
  };
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.name = 'ironwild_water';
  waterMesh.position.y = CONFIG.waterLevel;
  waterMesh.receiveShadow = true;
  G.scene.add(waterMesh);

  const foamMesh = buildFoamRing();

  return { groundMesh, waterMesh, foamMesh };
}

/**
 * v3: advance the water wave clock (called every frame by environment.js,
 * which already drives the shimmer + foam). t is any monotonic time source.
 */
export function updateWaterWaves(t) {
  waveUniform.value = t;
}

/**
 * v6: feed the water shader's fresnel/glint term the live sky gradient + sun
 * state (called once per frame by environment.js, which already owns these
 * colours). `sunVis` is a 0..1 day/dusk factor so the glint fades out at
 * night instead of glinting off moonlight.
 */
export function setWaterSkyUniforms(topColor, horizonColor, sunDir, sunColor, sunVis) {
  skyTopUniform.value.copy(topColor);
  skyHorizonUniform.value.copy(horizonColor);
  sunDirUniform.value.copy(sunDir);
  sunColorUniform.value.copy(sunColor);
  sunVisUniform.value = sunVis;
}
