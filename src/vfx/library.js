// IRONWILD - named VFX + bus wiring (Wave H). Thin, tuned recipes over the
// pooled engine in ./vfx.js (spawnEffect), plus the bus subscriptions that
// make combat feedback zero-edit for callers: damage sources just emit the
// canonical events and this module paints them.
//
// Integration contract: import createVfx/updateVfx/disposeVfx (+ anything
// else) from THIS file - it re-exports the engine surface so integrators need
// exactly one module. window.__IW_VFX_STATS is published here (perf HUD).
//
// Readability rule (mirrors vfx.js): effects reveal events, never hide
// targets - sparks stay small/additive, smoke stays alpha-low and depth-tested.

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { bus } from '../core/events.js';
import { clamp } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';
import {
  initVfxEngine,
  spawnEffect,
  updateVfx as updateVfxEngine,
  disposeVfx as disposeVfxEngine,
  getVfxStats,
} from './vfx.js';

// Scratch - reused across calls, never reallocated per effect.
const _wp = new THREE.Vector3();        // world-space part position resolver
const _at = { x: 0, y: 0, z: 0 };       // plain xyz pos for spawnEffect opts

const MATERIALS = new Set(['metal', 'stone', 'soil', 'wood', 'water']); // impact contract

// --- named effects ----------------------------------------------------------

/**
 * Material-classified arrow impact. `material` is one of the 'impact' bus
 * contract values; unknown/missing materials fall back to a generic spark
 * burst so a mis-typed payload still gets feedback.
 * opts: { pos: {x,y,z} (required), strength?: number (~0.25..2) }
 */
export function fxArrowImpact(material, opts = {}) {
  const pos = opts.pos;
  if (!pos || typeof pos.x !== 'number') return;
  const s = clamp(Number(opts.strength) || 1, 0.25, 2);
  switch (material) {
    case 'metal': // bright ricochet spray + pop of light
      spawnEffect('spark', { pos, count: Math.round(12 * s), speed: 7.5, spread: Math.PI * 0.8, ttl: 0.35, size: 0.12, color: 0xffe9b0, priority: 0.6 });
      spawnEffect('flash', { pos, size: 0.9 * s, ttl: 0.1, color: 0xfff3d8 });
      break;
    case 'stone': // gray chips with a little dust
      spawnEffect('debris', { pos, count: Math.round(7 * s), speed: 6, spin: 10, color: 0x9a948a, priority: 0.55 });
      spawnEffect('smoke', { pos, count: 2, size: 0.5, color: 0x8d867a, alpha: 0.26, ttl: 0.7, priority: 0.35 });
      break;
    case 'soil': // dirt puff, no hard debris
      spawnEffect('smoke', { pos, count: Math.round(4 * s), size: 0.7, color: 0x6b5638, alpha: 0.3, ttl: 0.9, grow: 1.5, priority: 0.4 });
      break;
    case 'water': // pale splash droplets + thin mist
      spawnEffect('spark', { pos, count: Math.round(9 * s), speed: 7, spread: Math.PI * 0.7, gravity: 1.15, ttl: 0.5, size: 0.09, color: 0xcfe6f2, priority: 0.45 });
      spawnEffect('smoke', { pos, count: 2, size: 0.45, color: 0xbfd2dc, alpha: 0.22, ttl: 0.6, priority: 0.25 });
      break;
    case 'wood': // splinter shards + faint dust
      spawnEffect('debris', { pos, count: Math.round(6 * s), speed: 6.5, spin: 12, color: 0x7c5a36, priority: 0.55 });
      spawnEffect('smoke', { pos, count: 1, size: 0.4, color: 0x8a7a5e, alpha: 0.22, ttl: 0.6, priority: 0.3 });
      break;
    default: // generic fallback - neutral sparks read on any surface
      spawnEffect('spark', { pos, count: Math.round(8 * s), speed: 6, ttl: 0.35, size: 0.11, color: 0xbfc8cf, priority: 0.5 });
      break;
  }
}

/** Weak-point hit: tight, bright cyan burst + short glow pop (readable focus). */
export function fxWeakPointHit(point) {
  if (!point || typeof point.x !== 'number') return;
  spawnEffect('spark', { pos: point, count: 12, speed: 9, spread: 0.85, ttl: 0.38, size: 0.13, color: 0xbdf3ff, priority: 0.8 });
  spawnEffect('flash', { pos: point, size: 1.15, ttl: 0.12, color: 0xdff6ff });
}

/** Weak-point break: large burst + shockwave ring + metal debris. */
export function fxWeakPointBreak(point) {
  if (!point || typeof point.x !== 'number') return;
  spawnEffect('spark', { pos: point, count: 42, speed: 10.5, ttl: 0.5, size: 0.15, color: 0xaefcff, priority: 0.95 });
  spawnEffect('ring', { pos: point, size: 6, ttl: 0.55, color: 0x9fe8ff, priority: 0.7 });
  spawnEffect('debris', { pos: point, count: 12, speed: 8, spin: 14, color: 0xb9c2c9, priority: 0.7 });
}

/** Armor break: heavy metal shards + dense gray puff. */
export function fxArmorBreak(point) {
  if (!point || typeof point.x !== 'number') return;
  spawnEffect('debris', { pos: point, count: 15, speed: 7.5, spin: 12, color: 0x878e94, priority: 0.65 });
  spawnEffect('smoke', { pos: point, count: 5, size: 0.8, color: 0x565b60, alpha: 0.3, ttl: 1.2, grow: 1.7, priority: 0.45 });
}

/**
 * Attach a continuous plume emitter that follows `machine.group.position`
 * until detached (handle.detach(), machine death, or engine dispose).
 * Re-attaching to the same machine restyles instead of stacking emitters.
 * styles: 'smoke-light' | 'smoke-heavy' | 'steam'
 */
const PLUME_CAP = 24; // concurrent emitters; overflow steals the oldest
const PLUME_STYLES = {
  'smoke-light': { interval: 0.22, lift: 1.6, jitter: 0.5,
    puff: { count: 1, ttl: 1.1, size: 0.65, color: 0x6f7478, alpha: 0.26, speed: 1.0, grow: 1.4, priority: 0.3 } },
  'smoke-heavy': { interval: 0.12, lift: 1.2, jitter: 0.7,
    puff: { count: 1, ttl: 1.5, size: 0.95, color: 0x4c5054, alpha: 0.34, speed: 1.6, grow: 2.0, priority: 0.4 } },
  'steam': { interval: 0.09, lift: 0.8, jitter: 0.3,
    puff: { count: 1, ttl: 0.8, size: 0.5, color: 0xdfe8ec, alpha: 0.3, speed: 2.4, grow: 1.8, gravity: -0.15, priority: 0.3 } },
};
const plumes = [];                 // {machine, cfg, at, opts, acc, detached, handle}
const plumeByMachine = new WeakMap();

export function fxAttachPlume(machine, style = 'smoke-light') {
  if (!machine || !machine.group || !machine.group.position) return null;
  const key = PLUME_STYLES[style] ? style : 'smoke-light';
  const existing = plumeByMachine.get(machine);
  if (existing) { // upgrade path ('machineDamaged' tier escalation) - no dupes
    existing.cfg = PLUME_STYLES[key];
    existing.opts = { ...existing.cfg.puff, pos: existing.at };
    if (!plumes.includes(existing)) plumes.push(existing); // revive stolen slot
    existing.detached = false;
    return existing.handle;
  }
  if (plumes.length >= PLUME_CAP) plumes.shift().detached = true; // steal oldest
  const rec = {
    machine,
    cfg: PLUME_STYLES[key],
    at: { x: 0, y: 0, z: 0 },                    // per-rec scratch pos
    opts: null,
    acc: 0,
    detached: false,
    handle: null,
  };
  rec.opts = { ...rec.cfg.puff, pos: rec.at };   // one-time alloc per attach
  rec.handle = { detach() { rec.detached = true; } };
  plumes.push(rec);
  plumeByMachine.set(machine, rec);
  return rec.handle;
}

function detachPlume(machine) {
  const rec = machine ? plumeByMachine.get(machine) : null;
  if (rec) rec.detached = true;
}

/** Dark oil drips falling from a breach point. */
export function fxFluidLeak(point) {
  if (!point || typeof point.x !== 'number') return;
  // Smoke class doubles as drips: dark tint reads because blending is normal.
  spawnEffect('smoke', { pos: point, dir: { x: 0, y: -1, z: 0 }, count: 3, speed: 1.5, spread: 0.5, ttl: 0.8, size: 0.16, grow: 0.3, color: 0x14181b, alpha: 0.32, gravity: 0.55, priority: 0.3 });
  spawnEffect('smoke', { pos: point, count: 1, size: 0.3, color: 0x1c2125, alpha: 0.26, ttl: 1.2, priority: 0.28 });
}

/** Single burn DoT tick: small orange lick + wisp. Cheap enough per-frame. */
export function fxBurnTick(point) {
  if (!point || typeof point.x !== 'number') return;
  spawnEffect('spark', { pos: point, count: 4, speed: 3, spread: Math.PI * 0.6, ttl: 0.28, size: 0.09, color: 0xff8c3c, priority: 0.25 });
  spawnEffect('smoke', { pos: point, count: 1, size: 0.3, color: 0x33302c, alpha: 0.24, ttl: 0.8, priority: 0.2 });
}

/** Footfall / sprint dust puff; strength ~0..2 scales density and size. */
export function fxMovementDust(pos, strength = 1) {
  if (!pos || typeof pos.x !== 'number') return;
  const s = clamp(strength, 0, 2);
  if (s < 0.05) return;
  spawnEffect('smoke', {
    pos, count: Math.max(1, Math.round(2 * s)), speed: 1.1, spread: Math.PI * 0.5,
    ttl: 0.7, size: 0.45 + 0.25 * s, color: 0x8a7a5e, alpha: 0.22, grow: 1.2, priority: 0.2,
  });
}

/** Machine death: the one moment allowed to be loud. scale ~0.5..2.5. */
export function fxDeathExplosion(pos, scale = 1) {
  if (!pos || typeof pos.x !== 'number') return;
  const s = clamp(scale, 0.5, 2.5);
  spawnEffect('flash', { pos, size: 3.2 * s, ttl: 0.18, color: 0xffe2b0, priority: 0.9 });
  spawnEffect('ring', { pos, size: 8 * s, ttl: 0.6, color: 0xffd9a8, priority: 0.8 });
  spawnEffect('spark', { pos, count: Math.round(60 * s), speed: 12, ttl: 0.6, size: 0.16, color: 0xfff0d8, priority: 1.0 });
  spawnEffect('debris', { pos, count: Math.round(16 * s), speed: 9, spin: 16, priority: 0.85 });
  spawnEffect('smoke', { pos, count: Math.round(7 * s), speed: 1.8, size: 1.3, color: 0x3a3f44, alpha: 0.34, ttl: 1.7, grow: 1.9, priority: 0.5 });
}

/**
 * One thin rain splash mist near the player (ground height via terrain).
 * The capped ground-plane CYCLE runs internally in updateLibrary; this is the
 * single-splash primitive it drains through (also exported for manual use).
 */
export function fxRainSplash() {
  const w = G.weather;
  if (!w || w.type === 'clear' || !(w.intensity > 0)) return false;
  const anchor = (G.player && G.player.pos) ? G.player.pos : null;
  if (!anchor) return false;
  const ang = Math.random() * Math.PI * 2;
  const rad = 2 + Math.random() * 9;
  _at.x = anchor.x + Math.cos(ang) * rad;
  _at.z = anchor.z + Math.sin(ang) * rad;
  _at.y = Math.max(heightAt(_at.x, _at.z), CONFIG.waterLevel) + 0.06;
  return spawnEffect('smoke', { pos: _at, count: 1, speed: 0.5, ttl: 0.45, size: 0.28, color: 0xaebfd4, alpha: 0.2, grow: 1.2, priority: 0.15 }) > 0;
}

// --- internal tickers -------------------------------------------------------

function updatePlumes(dt) {
  for (let i = plumes.length - 1; i >= 0; i--) {
    const rec = plumes[i];
    const m = rec.machine;
    // Auto-detach on death/dispose - corpses do not smoke forever.
    if (rec.detached || !m || !m.alive || !m.group || !m.group.position) {
      plumes.splice(i, 1);
      if (m) plumeByMachine.delete(m);
      continue;
    }
    const gp = m.group.position;
    rec.acc += dt;
    let guard = 0; // hitch clamp: at most 4 catch-up puffs per frame
    while (rec.acc >= rec.cfg.interval && guard++ < 4) {
      rec.acc -= rec.cfg.interval;
      rec.at.x = gp.x + (Math.random() - 0.5) * rec.cfg.jitter;
      rec.at.y = gp.y + rec.cfg.lift + Math.random() * rec.cfg.jitter * 0.5;
      rec.at.z = gp.z + (Math.random() - 0.5) * rec.cfg.jitter;
      spawnEffect('smoke', rec.opts); // LOD/budget gating happens inside
    }
  }
}

let splashAcc = 0;

function updateRainSplashCycle(dt) {
  const w = G.weather;
  if (!w || w.type === 'clear') { splashAcc = 0; return; }
  // Thin cycle: <=~5 splashes/s even in storms; each is one tiny puff.
  splashAcc += dt * (1.2 + w.intensity * 3.8);
  if (splashAcc > 2) splashAcc = 2; // backlog clamp after hitches
  let budget = 3;
  while (splashAcc >= 1 && budget-- > 0) {
    splashAcc -= 1;
    fxRainSplash();
  }
}

function updateLibrary(dt) {
  updatePlumes(dt);
  updateRainSplashCycle(dt);
}

// --- bus handlers -----------------------------------------------------------

// Severity heuristic: weak hits get their dedicated cue; body hits are metal
// (machines are metal by contract) scaled by resolved damage.
function onMachineHit(p) {
  if (!p || !p.point) return;
  if (p.weak) { fxWeakPointHit(p.point); return; }
  const dmg = Number(p.damage) || 0;
  fxArrowImpact('metal', { pos: p.point, strength: clamp(dmg / 40, 0.6, 1.6) });
}

// Part class by name/multiplier heuristic (same spirit as damage.js rules):
// armor-ish names or zero-multiplier parts shatter as armor, everything else
// pops as a weak-point break. Position resolves like combat/damage.js does.
function onPartBroken(p) {
  if (!p || !p.machine) return;
  const m = p.machine;
  const wp = (p.partName != null && m.weakPoints)
    ? m.weakPoints.find((w) => w.name === p.partName)
    : null;
  let at = null;
  if (wp && wp.mesh && wp.mesh.getWorldPosition) {
    wp.mesh.getWorldPosition(_wp);
    at = _wp;
  } else if (m.group && m.group.position) {
    at = m.group.position;
  }
  if (!at) return;
  const nm = typeof p.partName === 'string' ? p.partName : '';
  const isArmor = /armor|plate|shield/i.test(nm) || (wp && wp.multiplier === 0);
  if (isArmor) fxArmorBreak(at);
  else fxWeakPointBreak(at);
}

function onMachineDamaged(p) {
  if (!p || !p.machine) return;
  // Tier 1 (<=50% hp) lights a small fire; tier 2 (<=25%) escalates it.
  fxAttachPlume(p.machine, p.tier >= 2 ? 'smoke-heavy' : 'smoke-light');
}

// 'impact' contract from combat/projectiles.js: material-classified hit.
// Unknown or absent material -> generic spark fallback inside fxArrowImpact.
function onImpact(p) {
  if (!p || !p.pos) return;
  const known = p.material && MATERIALS.has(p.material);
  const strength = Number.isFinite(p.strength) ? p.strength : 1;
  fxArrowImpact(known ? p.material : undefined, { pos: p.pos, strength });
}

function onMachineDied(p) {
  const m = p && p.machine;
  const pos = (p && p.pos) ? p.pos
    : (m && m.group && m.group.position) ? m.group.position : null;
  if (!pos) return;
  fxDeathExplosion(pos, 1);
  detachPlume(m); // death explosion replaces the damage plume
}

// Subtle red cue at the player - feedback without screen clutter.
function onPlayerHit(p) {
  const pos = (p && p.pos) ? p.pos : (G.player && G.player.pos);
  if (!pos || typeof pos.x !== 'number') return;
  _at.x = pos.x; _at.y = pos.y + 1.2; _at.z = pos.z;
  spawnEffect('flash', { pos: _at, size: 0.9, ttl: 0.12, color: 0xff5a4a, alpha: 0.35, priority: 0.2 });
  spawnEffect('spark', { pos, count: 3, speed: 2.5, ttl: 0.3, size: 0.08, color: 0xff7a66, alpha: 0.6, priority: 0.2 });
}

// --- lifecycle --------------------------------------------------------------

let wired = false;
let offs = [];

/**
 * Build the engine (idempotent, tolerated to fail pre-scene: updateVfx lazily
 * retries) and wire all combat-feedback bus subscriptions. Publishes the
 * perf-HUD getter window.__IW_VFX_STATS (absence must be tolerated elsewhere).
 */
export function createVfx() {
  initVfxEngine();
  if (wired) return;
  wired = true;
  offs.push(bus.on('machineHit', onMachineHit));
  offs.push(bus.on('partBroken', onPartBroken));
  offs.push(bus.on('machineDamaged', onMachineDamaged));
  offs.push(bus.on('impact', onImpact));
  offs.push(bus.on('machineDied', onMachineDied));
  offs.push(bus.on('playerHit', onPlayerHit));
  try {
    if (typeof window !== 'undefined') window.__IW_VFX_STATS = getVfxStats;
  } catch { /* non-browser context - HUD tolerates absence */ }
}

/** Engine pools + library tickers (plumes, rain-splash cycle) in one step. */
export function updateVfx(dt) {
  updateVfxEngine(dt);
  updateLibrary(dt);
}

/** Unwire bus listeners, drop emitters, free every GPU resource. */
export function disposeVfx() {
  for (const off of offs) off();
  offs = [];
  wired = false;
  plumes.length = 0;
  splashAcc = 0;
  disposeVfxEngine();
  // window.__IW_VFX_STATS intentionally left assigned: a stale getter reading
  // zeros is valid perf-HUD input and avoids touching foreign teardown order.
}
