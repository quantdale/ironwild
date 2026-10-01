// IRONWILD - application entry point (integrator).
// Owns renderer/scene/camera boot, system initialization order, and the frame loop.
// Game modules are imported as namespaces and bound at boot: primary export names follow
// ARCHITECTURE.md / ARCHITECTURE_V2.md, with the documented alternate shapes
// (method-on-object vs module-level update fn) accepted so parallel-developed modules
// integrate without editing their files.
// Anything missing is reported loudly on console instead of crashing the whole boot.
// v2 duties: settings persistence loads first; weather/status/quests/save/settings/
// minimap slot into the contract positions; G.settings.quality drives pixel ratio +
// sun shadow map size here (the only place allowed to touch renderer/shadow state).

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

import { G } from "./core/state.js";
import { bus } from "./core/events.js";
import { Input } from "./core/input.js";
import { clamp } from "./core/utils.js";

import * as terrainMod from "./world/terrain.js";
import * as environmentMod from "./world/environment.js";
import * as weatherMod from "./world/weather.js";
import * as propsMod from "./world/props.js";
import * as landmarkMod from "./world/landmark.js";
import * as playerMod from "./player/player.js";
import * as cameraMod from "./player/camera.js";
import * as bowMod from "./player/bow.js";
import * as spearMod from "./player/spear.js";
import * as hunterViewMod from "./player/hunterView.js";
import * as projectilesMod from "./combat/projectiles.js";
import * as damageMod from "./combat/damage.js";
import * as statusMod from "./combat/status.js";
import * as aiMod from "./machines/ai.js";
import * as saveMod from "./systems/save.js";
import * as questsMod from "./systems/quests.js";
import * as xpMod from "./systems/xp.js";
import * as expeditionMod from "./systems/expedition.js";
import * as bestiaryMod from "./systems/bestiary.js";
import * as hudMod from "./ui/hud.js";
import * as menusMod from "./ui/menus.js";
import * as settingsMod from "./ui/settings.js";
import * as minimapMod from "./ui/minimap.js";
import * as focusMod from "./ui/focus.js";
import * as tipsMod from "./ui/tips.js";
import * as weakCueMod from "./ui/weakcue.js";
import * as audioMod from "./audio/audio.js";
// v5 upgrade-campaign systems (waves A-H,J): telemetry, dynamic resolution,
// asset pipeline, environment lighting, VFX, machine animators, accessibility.
import * as perfMod from "./systems/perf.js";
import * as dynresMod from "./systems/dynres.js";
import * as assetsMod from "./systems/assets.js";
import * as lightingMod from "./render/lighting.js";
import * as vfxMod from "./vfx/library.js";
import * as animMod from "./anim/machineAnim.js";
import * as a11yMod from "./ui/a11y.js";

// ------------------------------------------------------------------ glue helpers

/** Fetch a required function export; report clearly and return a no-op if absent. */
function requireFn(ns, name, file) {
  const fn = ns[name];
  if (typeof fn === "function") return fn;
  console.error(`[main] missing export "${name}" in ${file}`);
  return () => {};
}

/**
 * Resolve a per-frame update step. Prefers the module-level `modName` export,
 * falls back to an `.update` method on the object returned by the create call.
 */
function resolveStep(ns, modName, api, file) {
  if (typeof ns[modName] === "function") return ns[modName];
  if (api && typeof api.update === "function") return (dt) => api.update(dt);
  console.error(
    `[main] no update step for ${file} (tried "${modName}" and api.update)`,
  );
  return null;
}

// ------------------------------------------------------------------ quality

// G.settings.quality -> renderer/shadow preset (ARCHITECTURE_V2 ui-v2b row).
// v4: also gates the post-processing pipeline (bloom resolution/strength,
// SMAA anti-aliasing) since those are the priciest full-screen passes.
// v6: also gates the god-ray pass (a second full-screen radial sample, cut
// below high) and the cinematic grade's grain/aberration intensity (cheap
// either way, just dialed down on low for a cleaner low-end look).
const QUALITY_PRESETS = {
  high: {
    pixelRatio: 1.5,
    shadows: true,
    mapSize: 2048,
    bloom: 0.55,
    bloomScale: 1,
    smaa: true,
    ao: true,
    godrays: true,
    cinematic: 1,
  },
  medium: {
    pixelRatio: 1.25,
    shadows: true,
    mapSize: 1024,
    bloom: 0.4,
    bloomScale: 0.75,
    smaa: false,
    ao: false,
    godrays: false,
    cinematic: 0.7,
  },
  low: {
    pixelRatio: 1,
    shadows: false,
    mapSize: 0,
    bloom: 0,
    bloomScale: 0.5,
    smaa: false,
    ao: false,
    godrays: false,
    cinematic: 0,
  },
};

let sunLight = null; // shadow-casting key light, found once via scene traverse
let composer = null,
  bloomPass = null,
  smaaPass = null,
  aoPass = null; // v4 post-processing (set in boot)
// SMAA + GTAO are HIGH-TIER-ONLY full-screen passes (~96 kB rendered with
// their shaders). They load lazily on the first tier that asks for them, so
// low/medium users never download them and high-tier boot doesn't block on
// their parse. Until arrival the passes are simply absent (disabled), then
// inserted at their contract positions and enabled.
let smaaPassPromise = null;
let aoPassPromise = null;
let godrayPass = null; // v6 volumetric light shaft pass (set in boot)
let gradePass = null; // v6: grade/vignette/grain/aberration pass (set in boot; needs per-frame uTime)
let bloomScale = 1; // current quality tier's bloom render-target scale vs. full res
let cinematicAmt = 1; // current quality tier's grain/aberration multiplier
let godraysEnabled = true; // mirrors godrayPass.enabled; skip its per-frame calc when off

// v6: classic screen-space radial-sample light shafts (the "Crysis god ray"
// trick) - repeatedly samples the frame toward the sun's screen position,
// so anywhere bright sky is partly occluded (tree canopies, ruins, the
// mountain ring) reads as a genuine shaft instead of a flat glow. Cheap
// relative to a real volumetric march since it is one extra full-screen
// pass with a fixed sample count - gated to high quality only.
const GODRAY_SAMPLES = 32;
const GODRAY_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    lightPos: { value: new THREE.Vector2(0.5, 0.5) },
    strength: { value: 0 }, // 0..~0.6, computed per-frame (behind-camera + elevation fade)
    exposure: { value: 0.4 },
    decay: { value: 0.965 },
    density: { value: 0.88 },
    weight: { value: 0.28 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 lightPos;
    uniform float strength;
    uniform float exposure;
    uniform float decay;
    uniform float density;
    uniform float weight;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (strength <= 0.001) { gl_FragColor = base; return; }
      vec2 deltaCoord = (vUv - lightPos) * (density / float(${GODRAY_SAMPLES}));
      vec2 coord = vUv;
      float illum = 1.0;
      vec3 accum = vec3(0.0);
      for (int i = 0; i < ${GODRAY_SAMPLES}; i++) {
        coord -= deltaCoord;
        accum += texture2D(tDiffuse, coord).rgb * illum * weight;
        illum *= decay;
      }
      gl_FragColor = vec4(base.rgb + accum * exposure * strength, base.a);
    }`,
};

// v4: final cheap full-screen pass - subtle contrast/saturation lift (a
// "filmic" look bloom alone doesn't give) plus an edge vignette. v6 adds
// animated film grain and a touch of edge chromatic aberration - one
// combined shader since all four are trivial per-pixel math.
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    contrast: { value: 1.11 },
    saturation: { value: 1.17 },
    vignette: { value: 0.32 },
    uTime: { value: 0 },
    grain: { value: 0.028 },
    aberration: { value: 0.0005 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    uniform float uTime;
    uniform float grain;
    uniform float aberration;
    varying vec2 vUv;
    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    void main() {
      vec2 d = vUv - 0.5;
      // Edge chromatic aberration: red/blue split growing toward the frame edge.
      vec2 off = d * dot(d, d) * aberration;
      vec4 texel = texture2D(tDiffuse, vUv);
      texel.r = texture2D(tDiffuse, vUv + off).r;
      texel.b = texture2D(tDiffuse, vUv - off).b;
      vec3 color = (texel.rgb - 0.5) * contrast + 0.5;
      float luma = dot(color, vec3(0.299, 0.587, 0.114));
      color = mix(vec3(luma), color, saturation);
      // Filmic split-tone: nudge shadows cool, highlights warm - the subtle
      // teal/amber balance that reads "cinematic" without a full LUT.
      vec3 shadowTint = vec3(0.96, 0.99, 1.05);
      vec3 highTint = vec3(1.05, 1.005, 0.93);
      color *= mix(shadowTint, highTint, smoothstep(0.15, 0.85, luma));
      // Gentle S-curve lift so midtones gain punch without crushing blacks.
      // The curve is only monotonic on [0,1]; clamp its input or HDR sun/sky
      // values (>1) invert brightness into colored rings around the sun.
      vec3 s = clamp(color, 0.0, 1.0);
      color = color * 0.72 + s * s * (3.0 - 2.0 * s) * 0.28;
      color *= 1.0 - dot(d, d) * vignette;
      // Animated film grain, subtle and luma-weighted (less visible in bright skies).
      float n = hash(vUv * 800.0 + uTime * 37.0) - 0.5;
      color += n * grain * (1.0 - luma * 0.6);
      gl_FragColor = vec4(color, texel.a);
    }`,
};

/** Locate environment.js's sun (the only DirectionalLight with castShadow). */
function findSunLight() {
  if (sunLight) return sunLight;
  let found = null;
  if (G.scene) {
    G.scene.traverse((o) => {
      if (!found && o.isDirectionalLight && o.castShadow) found = o;
    });
  }
  sunLight = found;
  return found;
}

/**
 * Resize a light's shadow map at runtime. The old GPU texture must be disposed
 * and dropped first; three.js reallocates it at the new mapSize on next use.
 */
function setShadowMapSize(light, size) {
  const s = light.shadow;
  if (!s || s.mapSize.x === size) return;
  if (s.map) {
    s.map.dispose();
    s.map = null;
  }
  s.mapSize.set(size, size);
}

/** Apply G.settings.quality to pixel ratio + sun shadow map. Idempotent. */
function applyQuality() {
  const q = G.settings && G.settings.quality;
  const preset = QUALITY_PRESETS[q] || QUALITY_PRESETS.high;
  const renderer = G.renderer;
  if (!renderer) return;

  renderer.setPixelRatio(preset.pixelRatio);
  // EffectComposer caches _pixelRatio at construction; without this a tier
  // switch leaves composer buffers at the old resolution until the next
  // window resize (setPixelRatio internally re-runs setSize on every pass).
  if (composer) composer.setPixelRatio(preset.pixelRatio);

  const light = findSunLight();
  if (!light) {
    console.error(
      "[main] applyQuality: no shadow-casting DirectionalLight in scene",
    );
    return;
  }
  if (preset.shadows) {
    setShadowMapSize(light, preset.mapSize);
    light.castShadow = true;
  } else if (light.castShadow) {
    // Disabling: drop the map too so its GPU memory is freed while unused.
    light.castShadow = false;
    if (light.shadow && light.shadow.map) {
      light.shadow.map.dispose();
      light.shadow.map = null;
    }
  }

  // Toggling castShadow changes the lights hash, so affected programs are
  // recompiled by three.js itself; this flag just gates the shadow pass.
  renderer.shadowMap.enabled = preset.shadows;

  // v4: post-processing cost scales with quality. Bloom's internal mip chain
  // is resized (not just strength) on low/medium so it actually costs less,
  // not just blends less; SMAA is a full extra full-screen pass, so it is
  // the first thing cut.
  if (bloomPass) {
    bloomPass.enabled = preset.bloom > 0;
    bloomPass.strength = preset.bloom;
    bloomScale = preset.bloomScale;
    resizeBloom();
  }
  if (smaaPass) smaaPass.enabled = preset.smaa;
  // GTAO's G-buffer pre-pass (normals + depth) is the priciest single item
  // here - contact shadows are a real "looks expensive" signal, but only
  // worth it once the rest of the budget (shadows, bloom res, SMAA) is spent.
  if (aoPass) aoPass.enabled = preset.ao;
  // First high-tier request pulls the pass modules lazily; until they land
  // the passes are absent (visually: no AO/SMAA for a few frames at most).
  if (!smaaPass && preset.smaa) ensureSmaaPass();
  if (!aoPass && preset.ao) ensureAoPass();
  // v6: god rays are a second full-screen radial-sample pass - gated off
  // below high. When disabled its per-frame strength calc is also skipped.
  godraysEnabled = preset.godrays;
  if (godrayPass) godrayPass.enabled = preset.godrays;
  cinematicAmt = preset.cinematic;
  // v5: the dynamic-resolution controller re-reads base pixel ratio + bounds
  // for the new tier (it owns renderer/composer pixel ratio from here on).
  if (dynresMod && typeof dynresMod.onQualityChanged === "function") {
    dynresMod.onQualityChanged();
  }
}

/**
 * Lazy high-tier passes. Each builds once (memoized), inserts at its contract
 * position in the chain, and adopts whatever the CURRENT quality preset wants
 * - applyQuality may have run while the chunk was still downloading.
 */
function ensureAoPass() {
  if (aoPassPromise) return aoPassPromise;
  aoPassPromise = import("three/addons/postprocessing/GTAOPass.js")
    .then(({ GTAOPass }) => {
      const pass = new GTAOPass(
        G.scene,
        G.camera,
        window.innerWidth,
        window.innerHeight,
      );
      pass.output = GTAOPass.OUTPUT.Default;
      // Full-strength GTAO blacks out thin distant silhouettes (duskwings in
      // flight, tree canopies at range) - a known screen-space AO weakness on
      // small/thin geometry. Blending partway toward "no darkening" keeps a
      // visible contact-shadow effect up close without that artifact at range.
      pass.blendIntensity = 0.5;
      composer.insertPass(pass, 1); // contract slot: right after RenderPass
      aoPass = pass;
      pass.enabled = !!QUALITY_PRESETS[G.settings.quality]?.ao;
      return pass;
    })
    .catch((err) => {
      console.error("[main] GTAO pass unavailable:", err);
      return null;
    });
  return aoPassPromise;
}

function ensureSmaaPass() {
  if (smaaPassPromise) return smaaPassPromise;
  smaaPassPromise = import("three/addons/postprocessing/SMAAPass.js")
    .then(({ SMAAPass }) => {
      const pass = new SMAAPass(window.innerWidth, window.innerHeight);
      const at = composer.passes.indexOf(gradePass);
      composer.insertPass(pass, at >= 0 ? at : composer.passes.length);
      smaaPass = pass;
      pass.enabled = !!QUALITY_PRESETS[G.settings.quality]?.smaa;
      return pass;
    })
    .catch((err) => {
      console.error("[main] SMAA pass unavailable:", err);
      return null;
    });
  return smaaPassPromise;
}

/**
 * EffectComposer.setSize() sizes every pass at renderer.getPixelRatio() x
 * CSS pixels (see EffectComposer's _pixelRatio-scaled setSize calls) - match
 * that base resolution here, then apply bloomScale on top so low/medium
 * quality genuinely render bloom at a smaller, cheaper target.
 */
function resizeBloom() {
  if (!bloomPass || !G.renderer) return;
  const pr = G.renderer.getPixelRatio();
  bloomPass.setSize(
    Math.round(window.innerWidth * pr * bloomScale),
    Math.round(window.innerHeight * pr * bloomScale),
  );
}

// v6: scratch + real (unscaled) clock for grain animation + god-ray aim,
// so neither freezes/slows during focus-scan's timeScale dilation.
const _sunPoint = new THREE.Vector3();
let realTime = 0;

/** Per-frame: advance grain time and aim the god-ray pass at the sun. */
function updatePostFX(rawDt) {
  realTime += rawDt;
  if (gradePass) {
    // Wrap grain time: past ~2^24 the hash's float32 ULP exceeds 1 and the
    // grain stops animating (white noise - the wrap itself is invisible).
    gradePass.uniforms.uTime.value = realTime % 256;
    gradePass.uniforms.grain.value = 0.028 * cinematicAmt;
    gradePass.uniforms.aberration.value = 0.0005 * cinematicAmt;
  }
  if (!godrayPass) return;
  if (!godraysEnabled || !G.camera) {
    godrayPass.uniforms.strength.value = 0;
    return;
  }
  const sunDir = environmentMod.getSunDirection();
  const fwd = G.cam.forward;
  const facing = fwd.x * sunDir.x + fwd.y * sunDir.y + fwd.z * sunDir.z;
  // Fade out as the sun swings behind the camera (a raw screen-space
  // projection of a behind-camera point wraps to the wrong side).
  const behindFade = clamp((facing + 0.1) / 0.25, 0, 1);
  // Shafts read strongest near the horizon (long, low-angle light through
  // canopy/ruins) but stay faintly present at noon for a hazy-forest look.
  const elevFade = 1 - clamp((sunDir.y - 0.05) / 0.85, 0, 1) * 0.7;
  let strength = behindFade * elevFade * 0.55;
  if (strength <= 0.002) {
    godrayPass.uniforms.strength.value = 0;
    return;
  }
  _sunPoint
    .copy(G.camera.position)
    .addScaledVector(sunDir, 400)
    .project(G.camera);
  const ux = _sunPoint.x * 0.5 + 0.5;
  const uy = _sunPoint.y * 0.5 + 0.5;
  // Fade out as the projected light position moves far outside the visible
  // frame: the radial sampler's UV clamps to the nearest edge pixel once its
  // walk leaves [0,1], and repeatedly re-sampling a single clamped edge
  // pixel ~30 times washes the whole frame in that edge's flat colour (seen
  // as a solid green tint when the edge pixel happened to be grass). A
  // little off-screen margin still lets shafts stream in from the edge.
  const EDGE_MARGIN = 0.35;
  const edgeFadeX = 1 - clamp((Math.abs(ux - 0.5) - 0.5) / EDGE_MARGIN, 0, 1);
  const edgeFadeY = 1 - clamp((Math.abs(uy - 0.5) - 0.5) / EDGE_MARGIN, 0, 1);
  strength *= edgeFadeX * edgeFadeY;
  if (strength <= 0.002) {
    godrayPass.uniforms.strength.value = 0;
    return;
  }
  godrayPass.uniforms.lightPos.value.set(ux, uy);
  godrayPass.uniforms.strength.value = strength;
}

// ------------------------------------------------------------------ boot

function boot() {
  // Renderer: antialiased, pixel ratio capped, soft shadows. Canvas goes into #app.
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Telemetry owns the info-counter cadence: autoReset would zero the draw
  // call/triangle counters around each render, so frame-start sampling in
  // systems/perf.js only ever saw zeros. We reset explicitly right before
  // composer.render() every frame instead (see the frame loop below).
  renderer.info.autoReset = false;
  // v3: filmic tone mapping for richer highlights/contrast (ARCHITECTURE_V3 integrator row).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  document.getElementById("app").appendChild(renderer.domElement);

  // Scene + camera. Environment owns sky/fog from here on; these are safe first-frame
  // defaults in the day palette so frame 0 is never black.
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5d9);
  scene.fog = new THREE.Fog(0xc4d3de, 60, 520);

  const camera = new THREE.PerspectiveCamera(
    62,
    window.innerWidth / window.innerHeight,
    0.1,
    900,
  );
  camera.position.set(0, 6, 20);

  G.scene = scene;
  G.camera = camera;
  G.renderer = renderer;
  G.canvas = renderer.domElement;

  // v4: post-processing pipeline. Order: render -> GTAO contact shadows
  // (high quality only, lazily loaded) -> bloom (emissive weak points/fire/
  // lightning/sun-glow pop without touching any material) -> SMAA (quality-
  // gated, lazily loaded) -> grade/vignette (cheap, always on) -> output
  // (applies the renderer's ACES tone mapping + color space exactly once,
  // per three.js's documented EffectComposer contract). The high-tier-only
  // passes register themselves via ensureAoPass/ensureSmaaPass when a preset
  // first asks for them.
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.55,
    0.45,
    0.82,
  );
  composer.addPass(bloomPass);
  // v6: god rays sample the bloomed frame radially toward the sun, so the
  // shafts themselves pick up bloom's glow instead of looking flat.
  godrayPass = new ShaderPass(GODRAY_SHADER);
  composer.addPass(godrayPass);
  gradePass = new ShaderPass(GRADE_SHADER);
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());

  // Settings persistence loads FIRST: saved quality/sens/volumes must be on
  // G.settings before any system (camera, audio, this file) reads them.
  requireFn(settingsMod, "loadSettings", "ui/settings.js")();

  // --- systems, in contract order -------------------------------------------------

  requireFn(terrainMod, "createTerrain", "world/terrain.js")();
  requireFn(environmentMod, "createEnvironment", "world/environment.js")();

  // v5 (wave C): PMREM/IBL environment lighting built from a procedural sky
  // matched to environment.js's palette. Idempotent, never throws, never
  // replaces existing lights/background; per-frame intensity modulation is
  // ticked in the frame loop below.
  try {
    if (typeof lightingMod.initEnvironmentLighting === "function") {
      lightingMod.initEnvironmentLighting();
    }
  } catch (err) {
    console.error("[main] initEnvironmentLighting failed:", err);
  }

  // Weather owns G.weather; environment/terrain/props only read it. Lights now
  // exist, so apply the persisted quality preset once at boot.
  requireFn(weatherMod, "createWeather", "world/weather.js")();
  applyQuality();

  // v5 (wave B): asset pipeline loaders (GLTF/KTX2/meshopt; Draco on demand).
  // Authored GLB content is optional and loads through the asset pipeline;
  // procedural machines and world props remain the immediate fallback.
  // instantiate bridge in the GLTF-style shape anim/machineAnim.js expects
  // ({scene, animations}) lets authored machines upgrade themselves later
  // without touching this file again.
  try {
    if (typeof assetsMod.initAssets === "function") {
      const summary = assetsMod.initAssets({ renderer });
      console.info("[main] asset pipeline:", summary);
    }
    if (
      typeof window !== "undefined" &&
      typeof assetsMod.instantiate === "function"
    ) {
      window.__IW_ASSETS = {
        instantiate: (id, opts) =>
          assetsMod.instantiate(id, opts).then((obj) => ({
            scene: obj,
            animations:
              obj && obj.userData && obj.userData.clips
                ? Object.values(obj.userData.clips)
                : [],
          })),
        load: assetsMod.load,
      };
    }
  } catch (err) {
    console.error("[main] asset pipeline init failed:", err);
  }

  requireFn(propsMod, "createProps", "world/props.js")();
  // Authored landmarks load async through the asset pipeline (decorative:
  // a failed fetch never blocks or breaks the procedural world).
  try {
    if (typeof landmarkMod.createLandmarks === "function") {
      landmarkMod.createLandmarks();
    }
  } catch (err) {
    console.error("[main] createLandmarks failed:", err);
  }
  requireFn(playerMod, "createPlayer", "player/player.js")();

  // Spawn on the shore at (0, ?, 8), looking north (-Z, yaw 0) across the lake basin.
  if (G.player && G.player.pos) {
    const groundY =
      typeof terrainMod.heightAt === "function" ? terrainMod.heightAt(0, 8) : 0;
    G.player.pos.set(0, groundY + 0.1, 8);
    if (typeof G.player.yaw === "number") G.player.yaw = 0;
  }

  const cameraRig = requireFn(
    cameraMod,
    "createCameraRig",
    "player/camera.js",
  )();
  const bowApi = requireFn(bowMod, "createBow", "player/bow.js")();
  requireFn(spearMod, "createSpear", "player/spear.js")();

  // Authored hunter rig: async swap once the GLB decodes (procedural body
  // stays live until - and in case of any failure after - the swap).
  try {
    if (typeof hunterViewMod.createHunterView === "function") {
      hunterViewMod.createHunterView();
    }
  } catch (err) {
    console.error("[main] createHunterView failed:", err);
  }

  requireFn(damageMod, "createDamageFX", "combat/damage.js")();

  // Burn tick numbers (combat/status.js); projectiles call applyBurn on fire hits.
  requireFn(statusMod, "createStatusFX", "combat/status.js")();

  // World population lives in machines/ai.js; a partial AI module must not kill boot.
  try {
    requireFn(aiMod, "populateWorld", "machines/ai.js")();
  } catch (err) {
    console.error("[main] populateWorld failed:", err);
  }

  // Hunt contracts track spawned machines/pickups; save hooks subscribe last so
  // a snapshot always serializes fully-initialized quest slots.
  requireFn(questsMod, "createQuests", "systems/quests.js")();
  requireFn(xpMod, "createXp", "systems/xp.js")();
  requireFn(expeditionMod, "createExpedition", "systems/expedition.js")();
  requireFn(bestiaryMod, "createBestiary", "systems/bestiary.js")();
  requireFn(saveMod, "initSave", "systems/save.js")();

  requireFn(hudMod, "createHUD", "ui/hud.js")();
  requireFn(menusMod, "createMenus", "ui/menus.js")();
  // Settings modal after menus: menus' gear buttons call settings.openSettings().
  requireFn(settingsMod, "createSettings", "ui/settings.js")();
  // Minimap canvas after HUD; it positions itself under the resources readout.
  requireFn(minimapMod, "createMinimap", "ui/minimap.js")();
  requireFn(focusMod, "createFocus", "ui/focus.js")();
  requireFn(weakCueMod, "createWeakCue", "ui/weakcue.js")();
  // Tips stack anchors above the minimap/resources cluster; create after both.
  requireFn(tipsMod, "createTips", "ui/tips.js")();
  requireFn(audioMod, "initAudio", "audio/audio.js")();

  // v5: accessibility applier (Wave J) - reads persisted a11y settings and
  // publishes window.__IW_A11Y for consumers (camera shake lives there now).
  requireFn(a11yMod, "createA11y", "ui/a11y.js")();
  // v5 (wave H): pooled VFX engine + named effect library; bus-driven, so
  // boot order only matters for G.scene (it lazy-inits until the scene exists).
  try {
    requireFn(vfxMod, "createVfx", "vfx/library.js")();
  } catch (err) {
    console.error("[main] createVfx failed:", err);
  }
  // v5 (wave A): telemetry HUD (F3) + bounded dynamic-resolution controller.
  requireFn(perfMod, "createPerf", "systems/perf.js")();
  requireFn(dynresMod, "createDynRes", "systems/dynres.js")();
  if (typeof dynresMod.setContext === "function") {
    dynresMod.setContext({ renderer, composer });
  }

  // --- per-frame steps ------------------------------------------------------------

  // Player/bow/camera accept either documented shape: module-level update fn or
  // .update method on the created object.
  const cameraStep = resolveStep(
    cameraMod,
    "updateCamera",
    cameraRig,
    "player/camera.js",
  );
  const playerStep = resolveStep(
    playerMod,
    "updatePlayer",
    G.player,
    "player/player.js",
  );
  const bowStep = resolveStep(bowMod, "updateBow", bowApi, "player/bow.js");
  const spearStep = requireFn(spearMod, "updateSpear", "player/spear.js");

  const machinesStep = requireFn(aiMod, "updateMachines", "machines/ai.js");
  const projectilesStep = requireFn(
    projectilesMod,
    "updateProjectiles",
    "combat/projectiles.js",
  );
  // Hit sparks / damage numbers / smoke pools from combat/damage.js (scaled dt).
  const damageStep = requireFn(damageMod, "updateDamageFX", "combat/damage.js");
  // Burn DoT + orange tick numbers (scaled dt), then the rain/storm cycle.
  const statusStep = requireFn(statusMod, "updateStatusFX", "combat/status.js");
  const weatherStep = requireFn(
    weatherMod,
    "updateWeather",
    "world/weather.js",
  );
  const propsStep = requireFn(propsMod, "updateProps", "world/props.js");
  const landmarksStep = requireFn(landmarkMod, "updateLandmarks", "world/landmark.js");
  const envStep = requireFn(
    environmentMod,
    "updateEnvironment",
    "world/environment.js",
  );
  const focusStep = requireFn(focusMod, "updateFocus", "ui/focus.js");
  const weakCueStep = requireFn(weakCueMod, "updateWeakCue", "ui/weakcue.js");
  const hudStep = requireFn(hudMod, "updateHUD", "ui/hud.js");
  const menusStep = requireFn(menusMod, "updateMenus", "ui/menus.js");
  const minimapStep = requireFn(minimapMod, "updateMinimap", "ui/minimap.js");
  const tipsStep = requireFn(tipsMod, "updateTips", "ui/tips.js");
  const questsStep = requireFn(questsMod, "updateQuests", "systems/quests.js");
  const xpStep = requireFn(xpMod, "updateXp", "systems/xp.js");
  const expeditionStep = requireFn(expeditionMod, "updateExpedition", "systems/expedition.js");
  // save.js exports updateSave plus the documented `tick` alias - accept either.
  const saveStep =
    typeof saveMod.tick === "function"
      ? saveMod.tick
      : typeof saveMod.updateSave === "function"
        ? saveMod.updateSave
        : null;
  if (!saveStep) {
    console.error(
      '[main] no save tick (tried "tick" and "updateSave" in systems/save.js)',
    );
  }
  // Audio is bus-driven; a per-frame hook is optional.
  const audioStep =
    typeof audioMod.updateAudio === "function" ? audioMod.updateAudio : null;

  // v5 campaign steps. perf/dynres tick every frame (telemetry + resolution
  // control run even on the start screen); envLight modulates IBL intensity
  // from weather; vfx/animators tick with scaled gameplay dt.
  const perfStep = requireFn(perfMod, "updatePerf", "systems/perf.js");
  const dynresStep = requireFn(dynresMod, "updateDynRes", "systems/dynres.js");
  const envLightStep =
    typeof lightingMod.updateEnvironmentLighting === "function"
      ? lightingMod.updateEnvironmentLighting
      : null;
  const vfxStep = requireFn(vfxMod, "updateVfx", "vfx/library.js");
  // Machine animators (wave E): one line after the machines tick, as designed.
  const animatorsStep = requireFn(
    animMod,
    "updateMachineAnimators",
    "anim/machineAnim.js",
  );

  // --- frame loop -----------------------------------------------------------------

  // v5: spear/combat hitstop (wave F emits 'hitstop'; main owns time). The dip
  // MULTIPLIES G.timeScale instead of overwriting it, so focus-scan dilation
  // composes and nothing fights over ownership of G.timeScale. Short cap so a
  // burst of events cannot freeze the frame for long.
  let _hitstopLeft = 0;
  let _hitstopScale = 1;
  bus.on("hitstop", (e) => {
    const dur = e && typeof e.duration === "number" ? e.duration : 0.06;
    _hitstopLeft = Math.min(Math.max(dur, 0), 0.35);
    const sc = e && typeof e.scale === "number" ? e.scale : 0.25;
    _hitstopScale = Math.min(Math.max(sc, 0), 1);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    // Telemetry honesty: perfStep gets the UNCLAMPED delta (its own 250ms
    // gap-cap handles tab resumes), so real hitches >=50ms are recorded at
    // their true length instead of piling up as exact-50.0ms percentiles.
    // Everything downstream keeps the sim-stability clamp.
    const unclampedDelta = clock.getDelta();
    const rawDt = clamp(unclampedDelta, 0, 0.05);
    Input.beginFrame();
    perfStep(unclampedDelta); // telemetry first: this frame's dt is the sample
    dynresStep(rawDt); // bounded render-scale control (3D only)
    if (envLightStep) envLightStep(rawDt);
    updatePostFX(rawDt);
    // Hitstop countdown runs on raw time so it always recovers.
    let hsScale = 1;
    if (_hitstopLeft > 0) {
      _hitstopLeft -= rawDt;
      hsScale = _hitstopScale;
    }
    perfMod.beginMark("sim");
    if (G.started && !G.paused && !G.gameOver) {
      const dt = rawDt * G.timeScale * hsScale;
      G.elapsed += dt;
      if (cameraStep) cameraStep(dt);
      if (playerStep) playerStep(dt);
      if (bowStep) bowStep(dt);
      spearStep(dt);
      machinesStep(dt);
      animatorsStep(dt); // v5: tick attached machine animators (procedural-safe)
      projectilesStep(dt);
      damageStep(dt);
      statusStep(dt); // burn DoT after damage FX, before AI reads panic flags
      vfxStep(dt); // v5: pooled VFX after combat FX, same scaled clock
      propsStep(dt);
      if (landmarksStep) landmarksStep(dt);
      weatherStep(dt);
      envStep(dt);
      focusStep(dt);
      weakCueStep(dt);
      hudStep(rawDt);
      menusStep(dt);
      minimapStep(dt);
      tipsStep(dt);
      questsStep(dt);
      xpStep(dt);
      expeditionStep(dt);
    } else {
      // Start screen / paused / dead: keep the world breathing, skip gameplay.
      if (cameraStep) cameraStep(rawDt);
      envStep(rawDt * 0.2);
      hudStep(rawDt);
      menusStep(rawDt);
    }
    perfMod.endMark("sim");

    // Audio expects a tick every frame (it gates its audible layers on game
    // state itself). The save tick keeps running through pause so updateSave's
    // rising-edge-of-pause snapshot fires on ESC/tab-hide; its KeyP quicksave
    // poll is only reachable while unpaused. Both take raw dt.
    if (audioStep) audioStep(rawDt);
    if (saveStep && G.started && !G.gameOver) saveStep(rawDt);

    // One-shot key presses were polled by the systems above; clear them now.
    Input.endFrame();

    perfMod.beginMark("render-submit");
    // renderer.info.autoReset is disabled at boot (below) so the F3/telemetry
    // capture - which samples at frame START, before this render - always sees
    // the LAST COMPLETED frame's draw-call/triangle totals. Reset here, right
    // before submitting, so the upcoming render accumulates from zero.
    renderer.info.reset();
    composer.render();
    perfMod.endMark("render-submit");
  });

  // --- global handlers ------------------------------------------------------------

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    // composer.setSize() re-sizes EVERY pass (incl. bloom) at full
    // resolution; re-apply the quality tier's reduced bloom target right
    // after so low/medium keep their cheaper bloom cost on resize too.
    composer.setSize(window.innerWidth, window.innerHeight);
    resizeBloom();
  });

  // Right mouse is aim-hold; never show the browser context menu.
  window.addEventListener("contextmenu", (e) => e.preventDefault());

  // Page teardown: stop weather loops and release its GPU/DOM resources
  // (bfcache entry, SPA-style embeds). A normal restart is a full reload,
  // but an explicit dispose keeps the module's contract honest.
  window.addEventListener("pagehide", () => {
    if (weatherMod.disposeWeather) weatherMod.disposeWeather();
    if (landmarkMod.disposeLandmarks) landmarkMod.disposeLandmarks();
    if (expeditionMod.disposeExpedition) expeditionMod.disposeExpedition();
    if (hunterViewMod.disposeHunterView) hunterViewMod.disposeHunterView();
  });

  // Tab hidden -> force pause; menus own the resume flow.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) G.paused = true;
  });

  // Quality changes re-apply pixel ratio + sun shadow map live; volume/sens/
  // invert-Y are applied by audio.js and camera.js from the same event.
  bus.on("settingsChanged", (e) => {
    if (e && e.key === "quality") applyQuality();
  });

  // Dev/test hook: lets tooling and console inspection reach live game state
  // and the render objects (quality-tier assertions, perf sampling). The
  // dynres/perf module refs let E2E drive deterministic frame-time sequences
  // while G.paused keeps the real loop's own updateDynRes calls inert.
  window.__IW = {
    G,
    Input,
    bus,
    renderer,
    composer,
    dynres: dynresMod,
    perf: perfMod,
  };
}

boot();
