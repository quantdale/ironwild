// IRONWILD - environment lighting + art-direction config (Wave C render infra).
// Two jobs:
//   1. ART_DIRECTION - the single reference table for look constants (exposure,
//      bloom, atmosphere tints per time-of-day bucket, fog hints, shadow policy
//      per quality tier). Later systems read this instead of re-inventing magic
//      numbers; hex values mirror world/environment.js's COL table, which stays
//      the runtime source of truth - keep them in sync.
//   2. Image-based lighting plumbing: bake a PMREM environment from a tiny
//      procedural sky scene matched to environment.js's palette and assign it
//      as scene.environment. Infrastructure-first: the baked intensity baseline
//      is deliberately LOW so existing visuals stay unchanged until a dedicated
//      tuning wave turns IBL up.
//
// Hard rules this module obeys:
//   * NEVER touches scene.background and adds NO persistent lights - the sky
//     dome/sun/moon/hemi in world/environment.js keep full ownership.
//   * initEnvironmentLighting is idempotent, feature-detects
//     scene.environmentIntensity (r163+; three 0.166 has it) and must never
//     crash boot - any failure leaves the scene exactly as it was.
//   * applyShadowPolicy is exported for the integrator but NOT called from
//     here: main.js already owns shadow-map sizing/enable per quality tier and
//     environment.js owns the light orbit radius + shadow near/far.

import * as THREE from 'three';
import { G } from '../core/state.js';
import { clamp, damp, lerp, smoothstep } from '../core/utils.js';

// --- art direction ----------------------------------------------------------

/**
 * Reference look config. Everything here is data consumed by code or future
 * systems - nothing in this file mutates it.
 */
export const ART_DIRECTION = {
  // ACES exposure: baseline matches main.js boot value; live changes (e.g. a
  // lightning-flash or underwater grade) must stay inside this range.
  exposureBaseline: 1.05,
  exposureRange: [0.55, 1.6],

  bloom: {
    // Reference values == main.js's UnrealBloomPass constructor args.
    strength: 0.55, radius: 0.45, threshold: 0.82,
    // Per-tier strengths mirroring main.js QUALITY_PRESETS (low disables bloom).
    strengthByQuality: { high: 0.55, medium: 0.4, low: 0 },
  },

  // Atmosphere tints per time-of-day bucket. Buckets are resolved by SUN
  // ELEVATION (not raw time) with the rule "first entry whose belowElev is
  // above the current elevation wins" - identical edges to environment.js's
  // day/dusk smoothsteps. Dusk's `top` is a representative blend of the
  // runtime night->day lerp at dusk peak, not a literal COL constant.
  atmosphere: [
    {
      id: 'night', belowElev: -0.16,
      top: 0x131c2d, horizon: 0x2a3548, fog: 0x2a3548, sun: 0x93a9cf, // moonlight
      fogNear: 30, fogFar: 240,
    },
    {
      id: 'dusk', belowElev: 0.16,
      top: 0x15243d, horizon: 0xd6a685, fog: 0xd6a685, sun: 0xffab6e,
      fogNear: 45, fogFar: 330,
    },
    {
      id: 'day', belowElev: Infinity,
      top: 0x3f7fc4, horizon: 0xc4d3de, fog: 0xc4d3de, sun: 0xfff1d6,
      fogNear: 60, fogFar: 420,
    },
  ],

  // Weather overrides on top of the time-of-day bucket (environment.js lerps
  // toward these as its gloom factor rises; far values are its wet targets).
  weatherAtmosphere: {
    rain: { sky: 0x6d7a86, fog: 0x8d99a3, fogNear: 22, fogFar: 200 },
    storm: { sky: 0x4a545e, fog: 0x59626c, fogNear: 14, fogFar: 120 },
  },

  // Submerged camera contract (environment.js applyUnderwater owns the live lerp).
  underwaterHint: { fog: 0x1d4a56, near: 1, far: 24 },

  ibl: {
    // Conservative baseline: a faint fill so assigning scene.environment does
    // not visibly brighten existing scenes. Raise ONLY in a dedicated visual
    // QA pass alongside envMapIntensity retunes in materials.js.
    dayIntensity: 0.16,
    nightFloor: 0.35,   // fraction of dayIntensity kept under moonlight
    weatherCut: 0.6,    // fraction eaten at full rain/storm gloom
    dampLambda: 1.0,    // smoothing rate for per-frame intensity modulation
    sigma: 0.035,       // PMREM blur - hides disc aliasing in the bake
    sunBoost: 5.0,      // HDR multiplier on the baked sun core (specular hotspot)
  },

  // Shadow policy per quality tier. `high` mirrors what environment.js/main.js
  // build today (2048 box / extent 120 / bias -0.0006 / normalBias 0.6);
  // medium's mapSize matches main.js QUALITY_PRESETS. `low` documents what to
  // use IF shadows are ever forced on there - main.js currently disables them.
  shadow: {
    high: { shadows: true, mapSize: 2048, cameraExtent: 120, bias: -0.0006, normalBias: 0.6 },
    medium: { shadows: true, mapSize: 1024, cameraExtent: 105, bias: -0.0008, normalBias: 0.75 },
    low: { shadows: false, mapSize: 512, cameraExtent: 90, bias: -0.0012, normalBias: 0.9 },
  },
};

// Palette mirror of world/environment.js COL entries used by the bake (source
// of truth lives there - update both if the day palette ever changes).
const SKY_PALETTE = {
  dayTop: 0x3f7fc4,
  dayHorizon: 0xc4d3de,
  nightTop: 0x131c2d,
  nightHorizon: 0x2a3548,
  dusk: 0xe8956b,
  sunDay: 0xfff1d6,
  sunDusk: 0xffab6e,
};

// Bake-scene geometry (kept small: PMREM only needs angular coverage).
const BAKE_DOME_RADIUS = 50;
const BAKE_SUN_DIST = 42;
const BAKE_SUN_RADIUS = 2.6;

// --- module state -----------------------------------------------------------

let inited = false;
let envRT = null;              // PMREM render target we own
let prevEnvironment = null;    // scene.environment before we touched it
let supportsEnvIntensity = false;
let curIntensity = 0;          // live damped IBL scale

// --- internals --------------------------------------------------------------

/**
 * Sun elevation/direction math mirrors environment.js updateEnvironment
 * ((timeOfDay - 0.25) * TAU phase, fixed z-tilt 0.38). Keep in sync with it.
 */
function sunElevation(timeOfDay) {
  return Math.sin((timeOfDay - 0.25) * Math.PI * 2);
}

function sunDirectionFromTime(timeOfDay, out) {
  const ang = (timeOfDay - 0.25) * Math.PI * 2;
  return out.set(Math.cos(ang), Math.sin(ang), 0.38).normalize();
}

/** Numeric option with fallback; NaN/garbage falls back instead of poisoning. */
function optNum(v, fallback) {
  const n = +v;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Target IBL intensity for a moment in time + weather state. Pure function so
 * init can snap to it and the per-frame step can damp toward it.
 */
function computeTargetIntensity(timeOfDay, wx) {
  const elev = typeof timeOfDay === 'number' ? sunElevation(timeOfDay) : 0;
  const day = smoothstep(-0.04, 0.16, elev); // same edges as environment.js
  const rainAmt = wx && wx.type === 'rain' ? clamp(wx.intensity, 0, 1) : 0;
  const stormAmt = wx && wx.type === 'storm' ? clamp(wx.intensity, 0, 1) : 0;
  const gloom = Math.max(rainAmt * 0.6, stormAmt); // rain ~60% effect, storm full
  const { dayIntensity, nightFloor, weatherCut } = ART_DIRECTION.ibl;
  return dayIntensity * lerp(nightFloor, 1, day) * (1 - gloom * weatherCut);
}

/** Release the throwaway bake scene's GPU resources (no textures involved). */
function disposeSkyScene(skyScene) {
  skyScene.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
}

/**
 * Build the tiny procedural sky that gets baked into the PMREM cube:
 * gradient dome + haze + analytic sun glow/disc (shader terms copied from
 * environment.js's dome so the IBL colours match what players actually see),
 * plus one over-bright HDR sphere standing in for the sun core so metals get
 * a specular hotspot. Static snapshot of the CURRENT time-of-day phase -
 * day/night/weather are handled afterwards by intensity modulation, not by
 * rebaking.
 */
function buildSkyScene(timeOfDay) {
  // Blend the palette exactly like environment.js's per-frame lerp would at
  // this instant (fresh Color instances - runs once per boot).
  const elev = sunElevation(timeOfDay);
  const day = smoothstep(-0.04, 0.16, elev);
  const dusk = 1 - smoothstep(0.03, 0.32, Math.abs(elev));
  const top = new THREE.Color(SKY_PALETTE.nightTop).lerp(new THREE.Color(SKY_PALETTE.dayTop), day);
  const horizon = new THREE.Color(SKY_PALETTE.nightHorizon)
    .lerp(new THREE.Color(SKY_PALETTE.dayHorizon), day)
    .lerp(new THREE.Color(SKY_PALETTE.dusk), dusk * 0.85);
  const glowColor = new THREE.Color(SKY_PALETTE.dusk)
    .lerp(new THREE.Color(SKY_PALETTE.sunDay), smoothstep(0.08, 0.4, elev));
  const sunColor = new THREE.Color(SKY_PALETTE.sunDusk)
    .lerp(new THREE.Color(SKY_PALETTE.sunDay), smoothstep(0.06, 0.42, elev));
  const hazeColor = horizon.clone().lerp(new THREE.Color(0xffffff), 0.55);

  const sunDir = new THREE.Vector3();
  sunDirectionFromTime(timeOfDay, sunDir);

  const scene = new THREE.Scene();

  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: top },
      horizonColor: { value: horizon },
      glowColor: { value: glowColor },
      sunColor: { value: sunColor },
      sunDir: { value: sunDir },
      hazeColor: { value: hazeColor },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 glowColor;
      uniform vec3 sunColor;
      uniform vec3 sunDir;
      uniform vec3 hazeColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float t = smoothstep(-0.08, 0.42, d.y);
        vec3 col = mix(horizonColor, topColor, t);
        // Horizon haze band - grazing rays cross more atmosphere (env.js v6 term).
        float haze = pow(1.0 - clamp(t, 0.0, 1.0), 4.0);
        col = mix(col, hazeColor, haze * 0.6);   // env.js default hazeStrength
        float s = max(dot(d, normalize(sunDir)), 0.0);
        // Wide scatter halo + tight inner glow (env.js default glowStrength 0.85).
        col += glowColor * (pow(s, 20.0) * 0.5 + pow(s, 300.0) * 1.1) * 0.85;
        // Analytic sun disc; always-on here since PMREM bakes once.
        float disc = pow(s, 6000.0) * 0.7 + pow(s, 1800.0) * 0.35;
        col += sunColor * disc;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(BAKE_DOME_RADIUS, 32, 16),
    domeMat,
  );
  dome.frustumCulled = false;
  scene.add(dome);

  // Over-bright HDR sun sphere: gives the cubemap a genuine >1.0 hotspot so
  // metallic materials pick up a believable sun glint after the bake.
  const sunMat = new THREE.MeshBasicMaterial({
    color: sunColor.clone().multiplyScalar(ART_DIRECTION.ibl.sunBoost),
  });
  const sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BAKE_SUN_RADIUS, 12, 8),
    sunMat,
  );
  sunMesh.position.copy(sunDir).multiplyScalar(BAKE_SUN_DIST);
  scene.add(sunMesh);

  return scene;
}

// --- exports ----------------------------------------------------------------

/**
 * Bake + assign the PMREM environment. Idempotent; returns true when the
 * scene now has an environment, false when unsupported/bailed (boot must not
 * depend on it). Leaves scene.background untouched and adds no lights.
 */
export function initEnvironmentLighting() {
  if (inited) return true;
  const scene = G.scene;
  const renderer = G.renderer;
  if (!scene || !renderer) {
    console.error('[lighting] initEnvironmentLighting needs G.scene + G.renderer');
    return false;
  }

  let pmrem = null;
  let skyScene = null;
  try {
    // environment.js defaults to morning 0.35 when it has not run yet - match
    // that instead of assuming midnight.
    const t = typeof G.timeOfDay === 'number' ? G.timeOfDay : 0.35;

    skyScene = buildSkyScene(t);
    pmrem = new THREE.PMREMGenerator(renderer);
    envRT = pmrem.fromScene(skyScene, ART_DIRECTION.ibl.sigma);
    pmrem.dispose(); // generator internals go; the returned RT stays valid
    pmrem = null;
    disposeSkyScene(skyScene);
    skyScene = null;

    prevEnvironment = scene.environment; // usually null; restored on dispose
    scene.environment = envRT.texture;
    supportsEnvIntensity = 'environmentIntensity' in scene;
    curIntensity = computeTargetIntensity(t, G.weather);
    if (supportsEnvIntensity) {
      scene.environmentIntensity = curIntensity;
    } else {
      console.warn('[lighting] scene.environmentIntensity unsupported - IBL modulation inert');
    }
    inited = true;
    return true;
  } catch (err) {
    console.error('[lighting] initEnvironmentLighting failed:', err);
    if (pmrem) pmrem.dispose();
    if (skyScene) disposeSkyScene(skyScene);
    if (envRT) { envRT.dispose(); envRT = null; }
    return false;
  }
}

/**
 * Cheap per-frame IBL modulation: dims scene.environmentIntensity for night
 * and rain/storm so image-based lighting never blows out the moody scenes
 * environment.js builds with its own light rig. Inert when the renderer lacks
 * environmentIntensity support or init never ran.
 */
export function updateEnvironmentLighting(dt) {
  if (!inited || !G.scene || !supportsEnvIntensity) return;
  dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  curIntensity = damp(curIntensity, computeTargetIntensity(G.timeOfDay, G.weather),
    ART_DIRECTION.ibl.dampLambda, dt);
  G.scene.environmentIntensity = curIntensity;
}

/**
 * Clamp + apply renderer.toneMappingExposure. Returns the applied value, or
 * null when no renderer exists yet.
 */
export function applyExposure(v) {
  const renderer = G.renderer;
  if (!renderer) return null;
  const [min, max] = ART_DIRECTION.exposureRange;
  const x = clamp(optNum(v, ART_DIRECTION.exposureBaseline), min, max);
  renderer.toneMappingExposure = x;
  return x;
}

/**
 * Shape every existing shadow-casting DirectionalLight according to the
 * ART_DIRECTION shadow policy for `tier` (falls back to G.settings.quality,
 * then 'high'). Sizes maps (disposing stale GPU maps first, the same dance as
 * main.js), sets ortho lateral extent + biases.
 *
 * Deliberately NOT called automatically and deliberately does NOT flip
 * castShadow/renderer.shadowMap: main.js owns enabling/disabling shadows per
 * quality tier, and environment.js owns each light's orbit radius + near/far -
 * this only reshapes what already exists.
 */
export function applyShadowPolicy(tier) {
  const scene = G.scene;
  if (!scene) return false;
  const pol = ART_DIRECTION.shadow[tier]
    || ART_DIRECTION.shadow[G.settings && G.settings.quality]
    || ART_DIRECTION.shadow.high;
  scene.traverse((o) => {
    if (!o.isDirectionalLight || !o.castShadow) return;
    const sh = o.shadow;
    if (!sh) return;
    if (pol.mapSize > 0 && sh.mapSize.x !== pol.mapSize) {
      if (sh.map) {
        sh.map.dispose();
        sh.map = null; // three reallocates at the new size on next shadow pass
      }
      sh.mapSize.set(pol.mapSize, pol.mapSize);
    }
    const cam = sh.camera;
    if (cam && typeof cam.left === 'number') {
      cam.left = -pol.cameraExtent;
      cam.right = pol.cameraExtent;
      cam.top = pol.cameraExtent;
      cam.bottom = -pol.cameraExtent;
      cam.updateProjectionMatrix();
    }
    sh.bias = pol.bias;
    sh.normalBias = pol.normalBias;
    // near/far intentionally untouched: environment.js derives them from its
    // SUN_DIST orbit and moving them here would fight createEnvironment().
  });
  return true;
}

/**
 * Remove our environment, restore whatever scene.environment was before, and
 * release the PMREM target. Safe to call even after a failed init.
 */
export function disposeEnvironmentLighting() {
  if (!inited && !envRT) return;
  if (G.scene && envRT && G.scene.environment === envRT.texture) {
    G.scene.environment = prevEnvironment;
  }
  if (envRT) {
    envRT.dispose();
    envRT = null;
  }
  prevEnvironment = null;
  supportsEnvIntensity = false;
  inited = false;
}
