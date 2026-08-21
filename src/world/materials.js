// IRONWILD - centralized PBR material library (Wave C art-direction infra).
// One place to author the game's metallic/roughness surface language so later
// systems (machine variants, props v2, gear tiers) stop hand-rolling materials.
//
// Art direction - "industrial wilderness":
//   * weathered steel + oxidized accents carry the machine identity; raw metal
//     reads cold and slightly blue, weathering drags it toward brown-grey oxide
//     while killing metalness (the oxide layer itself is dielectric),
//   * ceramic armor panels stay pale, matte and faintly warm against steel,
//   * rubber/cloth/soil are pure dielectrics with high roughness - they exist
//     to absorb light so emissives can pop,
//   * emissives are RESERVED for gameplay-readable energy: weak points, loot,
//     projectiles. Nothing decorative gets emissive > 0. The canonical gameplay
//     glow is weak-point cyan 0x59e3ff @ ~1.6 (machines.js parity).
//
// Contract notes for consumers:
//   * Every factory accepts optional normalMap / aoMap / emissiveMap slots
//     (default null) so dropping real textures in later needs zero code change
//     here. Texture-bearing variants cache under the same rules (keyed by the
//     texture's uuid), so repeated calls share one GPU program per combo.
//   * Instances are SHARED - never mutate a returned material (tint flashes,
//     opacity fades): call .clone() at the call site for animated variants.
//   * Quality-aware: bus 'settingsChanged' {key:'quality'} re-tunes every
//     cached material - on 'low' anisotropy is disabled and envMapIntensity is
//     scaled down; medium keeps full env response at reduced mip filtering.
//   * This module never touches the scene graph; it only builds materials.

import * as THREE from 'three';
import { G } from '../core/state.js';
import { bus } from '../core/events.js';
import { clamp, lerp } from '../core/utils.js';

// --- tuning -----------------------------------------------------------------

// Per-quality multipliers applied over each material's own base envMapIntensity
// (stored in userData.iwBaseEnv at creation). 'low' deliberately dulls IBL -
// without it a future environment map would wash out the dimmed night/storm
// scenes that environment.js works to keep moody.
const ENV_BY_QUALITY = { high: 1.0, medium: 0.85, low: 0.55 };

// Mip-map anisotropic sampling budget per tier (capped by the renderer's max).
// 'low' clamps to 1 = plain trilinear, the cheapest correct setting.
const TEX_ANISO_BY_QUALITY = { high: 8, medium: 4, low: 1 };

const SLOT_KEYS = ['normalMap', 'aoMap', 'emissiveMap'];

// Canonical gameplay hues (keep in sync with machines.js / ui/weakcue.js).
const WEAK_CYAN = 0x59e3ff;       // default weak-point / energy glow
const WEAK_CB_SAFE = 0xe14fff;    // colorblind-safe violet-magenta alternative

// Steel endpoints for the weathering ramp.
const STEEL_RAW = 0xa7b0b7;       // cold-rolled, faintly blue
const STEEL_WEATHERED = 0x6e6055; // brown-grey oxidized drift target

// Foliage palette lifted straight from world/props.js so library foliage and
// instanced flora read as one biome (source of truth lives there).
const FOLIAGE_VARIANTS = {
  lush: 0x6a8f4f,   // meadow grass / leaf (props.js flora pair)
  forest: 0x3f6234, // darker canopy tint (props.js _FOREST_LEAF)
  dry: 0x9a8f6e,    // highland grey-brown blades (props.js _HIGHLAND_BLADE)
  reed: 0x6d7c42,   // lakeside reed green (props.js reeds)
};

// --- module state -----------------------------------------------------------

const cache = new Map(); // cache key -> shared MeshStandardMaterial
let busBound = false;    // settingsChanged subscription lives until disposeLibrary()
const warnedVariants = new Set(); // unknown makeFoliage variants warn exactly once

// --- helpers ----------------------------------------------------------------

/** Normalize the quality setting defensively (unknown/missing -> 'high'). */
function qualityTier() {
  const q = G.settings && G.settings.quality;
  return q === 'medium' || q === 'low' ? q : 'high';
}

/** Numeric option with fallback; NaN/garbage falls back instead of poisoning. */
function optNum(v, fallback) {
  const n = +v;
  return Number.isFinite(n) ? n : fallback;
}

/** 0..1 option with fallback (weathering/wear-style parameters). */
function pct(v, fallback) {
  return clamp(optNum(v, fallback), 0, 1);
}

/** Coerce a hex number / css string / Color into a canonical hex int. */
function normHex(v, fallback) {
  if (v === undefined || v === null) return fallback;
  const c = new THREE.Color();
  c.set(v);
  return c.getHex();
}

/** Pull the optional texture slots off any options object (null-defaulted). */
function takeSlots(opts) {
  return {
    normalMap: opts.normalMap || null,
    aoMap: opts.aoMap || null,
    emissiveMap: opts.emissiveMap || null,
  };
}

/** Stable fragment of the cache key describing the texture slot combo. */
function slotKey(slots) {
  const id = (tex) => (tex ? tex.uuid : '-');
  return `n:${id(slots.normalMap)}|ao:${id(slots.aoMap)}|em:${id(slots.emissiveMap)}`;
}

/** Stable fragment of the cache key describing domain parameters. */
function paramKey(params) {
  const parts = [];
  for (const k of Object.keys(params).sort()) parts.push(`${k}=${String(params[k])}`);
  return parts.join(',');
}

/** Renderer's max supported texture anisotropy, or null when unavailable. */
function rendererMaxAniso() {
  const caps = G.renderer && G.renderer.capabilities;
  return caps && typeof caps.getMaxAnisotropy === 'function'
    ? caps.getMaxAnisotropy()
    : null;
}

/**
 * Apply the current quality tier to one material: scale envMapIntensity over
 * its stored base and retune anisotropy. Material-level `anisotropy` only
 * exists on physical materials today (MeshStandardMaterial never has it), so
 * it is feature-detected - swapping a factory to MeshPhysicalMaterial later
 * keeps working without edits here.
 */
function tuneQuality(mat) {
  const q = qualityTier();
  const base = typeof mat.userData.iwBaseEnv === 'number' ? mat.userData.iwBaseEnv : 1;
  mat.envMapIntensity = base * ENV_BY_QUALITY[q];
  if ('anisotropy' in mat) {
    mat.anisotropy = q === 'low' ? 0 : (mat.userData.iwBaseAnisotropy || 0);
  }
  const cap = rendererMaxAniso();
  const want = TEX_ANISO_BY_QUALITY[q];
  for (const k of SLOT_KEYS) {
    const tex = mat[k];
    if (!tex) continue;
    tex.anisotropy = cap === null ? want : Math.min(want, cap);
  }
}

/** Assign provided texture slots. Callers own texture lifecycle/encoding; we
 * only bind + flag a program rebuild (adding maps post-construction needs it). */
function applySlots(mat, slots) {
  let any = false;
  for (const k of SLOT_KEYS) {
    const tex = slots[k];
    if (!tex) continue;
    any = true;
    mat[k] = tex;
  }
  if (any) mat.needsUpdate = true;
}

/**
 * Shared tail of every factory: dedupe by key (disposing the just-built
 * duplicate - it never reached the GPU), otherwise register + configure.
 */
function finalize(mat, kind, params, slots) {
  ensureBus();
  const key = `${kind}|${paramKey(params)}|${slotKey(slots)}`;
  const hit = cache.get(key);
  if (hit) {
    mat.dispose();
    return hit;
  }
  mat.userData.iwKind = kind;
  mat.userData.iwBaseEnv = mat.envMapIntensity;
  applySlots(mat, slots);
  tuneQuality(mat);
  cache.set(key, mat);
  return mat;
}

function onSettingsChanged(e) {
  if (e && e.key === 'quality') {
    for (const mat of cache.values()) tuneQuality(mat);
  }
}

/** Bind the quality listener lazily on first library use. */
function ensureBus() {
  if (!busBound) {
    busBound = true;
    bus.on('settingsChanged', onSettingsChanged);
  }
}

// --- factories --------------------------------------------------------------

/**
 * Structural steel. `weathering` 0..1 ramps colour toward oxidized brown-grey
 * and trades metalness for roughness (oxide is dielectric), so heavily
 * weathered plates catch a soft sheen instead of a sharp specular.
 * Slots: normalMap (pitting/dents), aoMap (crevice grime), emissiveMap (none -
 * steel never glows in this art direction).
 */
export function makeSteel(opts = {}) {
  const slots = takeSlots(opts);
  const w = pct(opts.weathering, 0.35);
  const color = new THREE.Color(STEEL_RAW).lerp(new THREE.Color(STEEL_WEATHERED), w * 0.85);
  const mat = new THREE.MeshStandardMaterial({
    color,
    flatShading: true, // house style: faceted low-poly reads as hammered plate
    metalness: 0.85 - w * 0.38,
    roughness: 0.36 + w * 0.44,
    envMapIntensity: 1.0, // metal is the main beneficiary of a future env probe
  });
  return finalize(mat, 'steel', { w: w.toFixed(4) }, slots);
}

/**
 * Ceramic armor panel (machine plating / ruin cladding). Pale bone tone,
 * matte-dielectric with just enough gloss to read "kiln-fired", deliberately
 * cooler-lighter than steel so silhouettes separate at distance.
 * `tint` accepts hex number / css string / Color.
 */
export function makeCeramicArmor(opts = {}) {
  const slots = takeSlots(opts);
  const tint = normHex(opts.tint, 0xcfd3c2);
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    flatShading: true,
    metalness: 0.04,
    roughness: 0.52,
    envMapIntensity: 0.8,
  });
  return finalize(mat, 'ceramic', { tint }, slots);
}

/**
 * Hydrated ferric oxide. Nearly a pure dielectric (barely glints), extremely
 * rough, dark enough to sit under paint/chrome accents. Reserved for rust
 * streak decals on ruins and old machine carcasses - never large surfaces.
 */
export function makeRust(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7c4526,
    flatShading: true,
    metalness: 0.12,
    roughness: 0.96,
    envMapIntensity: 0.5,
  });
  return finalize(mat, 'rust', {}, slots);
}

/**
 * Braided rubber sheath for cables/hoses: near-black dielectric, broad soft
 * highlight (roughness well under cloth so the braid catches rim light).
 */
export function makeRubberCable(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x191b1e,
    flatShading: true, // matches the faceted machine look on tube geometry
    metalness: 0.0,
    roughness: 0.82,
    envMapIntensity: 0.45,
  });
  return finalize(mat, 'rubber', {}, slots);
}

/**
 * Fieldstone. Exact base of props.js rock instances (0x7d7f82) so library
 * stone and instanced ruins match; pure matte dielectric.
 */
export function makeStone(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7d7f82,
    flatShading: true,
    metalness: 0.0,
    roughness: 0.95,
    envMapIntensity: 0.6,
  });
  return finalize(mat, 'stone', {}, slots);
}

/**
 * Packed soil / loam. Darkest dielectric in the library - ground contact
 * points, burrow mounds, dirt kick-up decals. Fully rough, zero reflectance
 * beyond diffuse so terrain vertex-colour blending stays dominant.
 */
export function makeSoil(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x4a3b2a,
    flatShading: true,
    metalness: 0.0,
    roughness: 1.0,
    envMapIntensity: 0.4,
  });
  return finalize(mat, 'soil', {}, slots);
}

/**
 * Foliage surface. `variant` keys into the props.js flora palette (lush |
 * forest | dry | reed); unknown names fall back to lush with a one-time warn
 * (a typo'd variant is a real bug worth surfacing, not silent). DoubleSide:
 * foliage is expected on thin cards/blades visible from both faces.
 */
export function makeFoliage(opts = {}) {
  const slots = takeSlots(opts);
  const name = opts.variant === undefined ? 'lush' : String(opts.variant);
  let hex = FOLIAGE_VARIANTS[name];
  if (hex === undefined) {
    if (!warnedVariants.has(name)) {
      warnedVariants.add(name);
      console.warn(`[materials] makeFoliage: unknown variant "${name}", using "lush"`);
    }
    hex = FOLIAGE_VARIANTS.lush;
  }
  const mat = new THREE.MeshStandardMaterial({
    color: hex,
    flatShading: true,
    side: THREE.DoubleSide,
    metalness: 0.0,
    roughness: 0.92,
    envMapIntensity: 0.5,
  });
  return finalize(mat, 'foliage', { variant: name }, slots);
}

/**
 * Inland water surface for future streams/puddles (the lake itself stays
 * owned by terrain.js/environment.js). Uses the contract water colour
 * (terrain.js 0x3d6f7d) but runs tighter roughness + higher env weight than
 * the lake sheet: small water bodies sell "wet" through sharp reflections.
 */
export function makeWaterSurface(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x3d6f7d,
    transparent: true,
    opacity: 0.78,
    metalness: 0.15,
    roughness: 0.18,
    envMapIntensity: 1.15,
  });
  return finalize(mat, 'water', {}, slots);
}

/**
 * Boiled-leather gear (player straps, quiver, spear grips). Matches
 * player.js leather tones; slight metalness residue mimics waxed finish.
 * Doubles as the cloth profile - both are matte dielectrics in this palette.
 */
export function makeLeatherCloth(opts = {}) {
  const slots = takeSlots(opts);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7d573a,
    flatShading: true,
    metalness: 0.02,
    roughness: 0.78,
    envMapIntensity: 0.55,
  });
  return finalize(mat, 'leather', {}, slots);
}

/**
 * Machine shell armor. `hue` (THREE convention 0..1) tints the gunmetal base
 * so machine types keep distinct silhouettes in colour; `wear` 0..1 desaturates
 * + darkens toward bare gunmetal and raises roughness (chipped/faded paint).
 * Defaults echo machines.js panels: teal-leaning hue, moderate wear.
 */
export function makeMachineShell(opts = {}) {
  const slots = takeSlots(opts);
  const hue = clamp(optNum(opts.hue, 0.55), 0, 1);
  const wear = pct(opts.wear, 0.25);
  const color = new THREE.Color().setHSL(
    hue,
    lerp(0.16, 0.05, wear), // paint loses saturation as it wears
    lerp(0.33, 0.24, wear), // and darkens toward bare metal
  );
  color.lerp(new THREE.Color(0x2b3036), wear * 0.35); // oxidized gunmetal pull
  const mat = new THREE.MeshStandardMaterial({
    color,
    flatShading: true, // machines.js hull/panel convention
    metalness: 0.62,
    roughness: 0.42 + wear * 0.34,
    envMapIntensity: 0.95,
  });
  return finalize(mat, 'shell', { hue: hue.toFixed(4), wear: wear.toFixed(4) }, slots);
}

/**
 * Gameplay energy emitter (cores, charge nodes, projectile heads). The base
 * colour is the energy colour crushed toward black so the emissive term alone
 * carries hue through bloom (main.js bloom exists exactly for this). Default
 * intensity 1.6 = machines.js weak-point glow level.
 * NOTE: restrained by policy - every emissive in the game must trace back to a
 * gameplay meaning; ask before using this for decoration.
 */
export function makeMachineEmissive(opts = {}) {
  const slots = takeSlots(opts);
  const energy = new THREE.Color(normHex(opts.color, WEAK_CYAN));
  const intensity = optNum(opts.intensity, 1.6);
  const mat = new THREE.MeshStandardMaterial({
    color: energy.clone().multiplyScalar(0.16),
    emissive: energy,
    emissiveIntensity: intensity,
    flatShading: true,
    metalness: 0.1,
    roughness: 0.35,
    envMapIntensity: 0.3, // emitters read by their own light, not the sky's
  });
  return finalize(
    mat,
    'emissive',
    { color: energy.getHex(), intensity: intensity.toFixed(4) },
    slots,
  );
}

/**
 * Weak-point indicator surface. Canonical case is byte-for-byte machines.js
 * parity (base 0x10333c, cyan 0x59e3ff @ 1.6). With `colorblind: true` the
 * glow swaps to violet-magenta - chosen because it is unused elsewhere in the
 * palette (energy=cyan, fire=orange, damage flash=red, pickups=green/brown),
 * so it stays distinguishable under red-green deficiency AND doesn't collide
 * with existing cues. ui/weakcue.js draws the shape-based half of that cue;
 * this material provides the alternate colour half.
 */
export function makeWeakPointMaterial(opts = {}) {
  const slots = takeSlots(opts);
  const cb = !!opts.colorblind;
  const emissive = cb ? WEAK_CB_SAFE : WEAK_CYAN;
  const mat = new THREE.MeshStandardMaterial({
    color: cb
      ? new THREE.Color(emissive).multiplyScalar(0.16)
      : 0x10333c, // exact machines.js weak-point base
    emissive,
    emissiveIntensity: 1.6,
    flatShading: true,
    metalness: 0.1,
    roughness: 0.35,
    envMapIntensity: 0.3,
  });
  return finalize(mat, 'weakpoint', { cb }, slots);
}

// --- library management -----------------------------------------------------

/**
 * Dispose every cached material and unbind the quality listener. Materials
 * passed in as texture slots are caller-owned and are NOT disposed here
 * (material.dispose() never disposes its textures). After this, factories
 * rebuild fresh state lazily - safe for debug/teardown flows.
 */
export function disposeLibrary() {
  for (const mat of cache.values()) mat.dispose();
  cache.clear();
  if (busBound) {
    bus.off('settingsChanged', onSettingsChanged);
    busBound = false;
  }
}

/**
 * Telemetry snapshot (debug HUD / perf tooling). Shape:
 * { entries:number, byKind:{kind:count}, quality:string, busBound:boolean }.
 */
export function libraryStats() {
  const byKind = {};
  for (const mat of cache.values()) {
    const k = mat.userData.iwKind || 'unknown';
    byKind[k] = (byKind[k] || 0) + 1;
  }
  return { entries: cache.size, byKind, quality: qualityTier(), busBound };
}
