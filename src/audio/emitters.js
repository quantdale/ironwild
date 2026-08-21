// IRONWILD - Wave I positional emitter pool.
// A fixed pool of PannerNodes shared by any system that wants to place a
// synthesized voice at a world position without building its own graph:
//   emitAt(pos, category, synthFn, { priority, ttl })
// synthFn({ dest, pos, category, priority }) builds its chain into `dest` (the
// pooled panner) and returns its longest-lived source node; the slot frees on
// source end or when ttl expires. The listener's POSITION stays owned by
// audio.js updateListener() (stable player-feet baseline, shake-free); this
// module only refines ORIENTATION from G.camera each frame when one exists,
// falling back to G.cam.forward — last writer within the frame wins, and
// updateAudio() calls updateListener() before updateEmitters().
// Everything guards nulls: before createEmitters() all calls are safe no-ops.

import { G } from '../core/state.js';

const POOL_SIZE = 12;

let E = null; // { ctx, dest, pool: [{panner,busy,until,prio,src}], stats }

/** Write a world position onto a PannerNode (modern params or legacy setter). */
function setPannerPos(p, x, y, z) {
  if (p.positionX) {
    p.positionX.value = x;
    p.positionY.value = y;
    p.positionZ.value = z;
  } else if (p.setPosition) {
    p.setPosition(x, y, z); // legacy fallback
  }
}

function makePoolPanner(ctx) {
  const p = ctx.createPanner();
  // inverse-distance model with a generous ref distance so nearby emitters
  // keep most of their level while far ones fade naturally (audio.js sfx()
  // panners stay linear/rolloff-0 by design — manual attn is authoritative
  // there; these pool panners let WebAudio do the work instead)
  p.panningModel = 'equalpower';
  p.distanceModel = 'inverse';
  p.refDistance = 6;
  p.rolloffFactor = 1.2;
  p.maxDistance = 10000; // effectively unclamped
  return p;
}

/** Build (or rebuild) the pool for an AudioContext. Idempotent per ctx. */
export function createEmitters({ ctx, destination } = {}) {
  if (!ctx || !destination) return;
  if (E && E.ctx === ctx) return;
  if (E) disposeEmitters();
  const pool = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    let panner = null;
    try {
      panner = makePoolPanner(ctx);
      panner.connect(destination);
    } catch (_err) {
      panner = null; // leave the slot dead rather than crash boot
    }
    pool.push({ panner, busy: false, until: 0, prio: 0, src: null });
  }
  E = {
    ctx,
    destination,
    pool,
    stats: { emitted: 0, rejected: 0 },
  };
}

function freeSlot(slot, hardStop) {
  if (hardStop && slot.src) {
    try { slot.src.onended = null; } catch (_e) { /* node gone */ }
    try { slot.src.stop(); } catch (_e) { /* already stopped */ }
  }
  slot.src = null;
  slot.busy = false;
}

/** Release slots whose ttl has elapsed. */
function reclaimExpired(now) {
  if (!E) return;
  for (const slot of E.pool) {
    if (slot.busy && now >= slot.until) freeSlot(slot, true);
  }
}

/** Steal ranking: expired first, then lowest priority, then oldest claim. */
function stealRank(slot, now) {
  const expired = now >= slot.until ? 0 : 1;
  return expired * 1e9 + slot.prio * 1e6 + slot.until;
}

const clampNum = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Emit a synthesized voice at a world position through a pooled panner.
 * pos: {x,y,z}; synthFn({ dest, pos, category, priority }) -> source|null.
 * opts.priority (default 2) protects against stealing; opts.ttl (default 3s)
 * bounds how long the slot is held when no end event ever fires.
 * Returns the source node, or null when unavailable/saturated.
 */
export function emitAt(pos, category, synthFn, opts = {}) {
  if (!E || !pos || typeof synthFn !== 'function') return null;
  const now = E.ctx.currentTime;
  reclaimExpired(now);
  const prio = typeof opts.priority === 'number' ? clampNum(opts.priority, 0, 9) : 2;
  let slot = null;
  for (const s of E.pool) {
    if (!s.busy && s.panner) { slot = s; break; }
  }
  if (!slot) {
    // saturated: steal the best-ranked busy slot only if it outranks us
    let victim = null;
    for (const s of E.pool) {
      if (!s.panner) continue;
      if (!victim || stealRank(s, now) < stealRank(victim, now)) victim = s;
    }
    if (!victim || (now < victim.until && victim.prio >= prio)) {
      E.stats.rejected++;
      return null;
    }
    freeSlot(victim, true);
    slot = victim;
  }
  slot.busy = true;
  slot.prio = prio;
  slot.until = now + (typeof opts.ttl === 'number' ? Math.max(0.05, opts.ttl) : 3);
  setPannerPos(slot.panner, pos.x, pos.y, pos.z);
  let src = null;
  try {
    src = synthFn({
      dest: slot.panner,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      category,
      priority: prio,
    });
  } catch (_err) {
    src = null; // a broken emitter voice must never break gameplay
  }
  slot.src = src && typeof src.addEventListener === 'function' ? src : null;
  if (slot.src) {
    slot.src.addEventListener('ended', () => {
      if (slot.src === src) freeSlot(slot, false);
    });
  }
  E.stats.emitted++;
  return src;
}

/**
 * Per-frame upkeep + listener orientation sync from G.camera (guarded).
 * Orientation only: position remains audio.js's stable player-feet baseline.
 */
export function updateEmitters(_dt) {
  if (!E) return;
  const now = E.ctx.currentTime;
  reclaimExpired(now);

  const L = E.ctx.listener;
  if (!L) return;
  const cam = G.camera;
  let fx = 0, fy = 0, fz = -1;
  let haveFwd = false;
  if (cam && cam.isCamera && cam.matrixWorld) {
    // camera forward = -Z column of matrixWorld; manual math avoids pulling
    // three.js Vector3 into this module
    const e = cam.matrixWorld.elements;
    fx = -e[8]; fy = -e[9]; fz = -e[10];
    const len = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    fx /= len; fy /= len; fz /= len;
    haveFwd = true;
  } else if (G.cam && G.cam.forward) {
    fx = G.cam.forward.x; fy = G.cam.forward.y; fz = G.cam.forward.z;
    haveFwd = true;
  }
  if (!haveFwd) return;
  try {
    if (L.forwardX) {
      L.forwardX.value = fx;
      L.forwardY.value = fy;
      L.forwardZ.value = fz;
      L.upX.value = 0;
      L.upY.value = 1;
      L.upZ.value = 0;
    } else if (L.setOrientation) {
      L.setOrientation(fx, fy, fz, 0, 1, 0); // legacy fallback
    }
  } catch (_err) { /* orientation is cosmetic; never fatal */ }

  let busy = 0;
  for (const s of E.pool) if (s.busy) busy++;
  E.stats.busy = busy;
}

/** Perf-HUD diagnostics (nested inside audio.js getVoiceStats too). */
export function getEmitterStats() {
  if (!E) return { ready: false, pool: POOL_SIZE, busy: 0, emitted: 0, rejected: 0 };
  return {
    ready: true,
    pool: POOL_SIZE,
    busy: E.stats.busy || 0,
    emitted: E.stats.emitted,
    rejected: E.stats.rejected,
  };
}

/** Drop every live emitter voice and detach the pool (ctx teardown path). */
export function disposeEmitters() {
  if (!E) return;
  for (const slot of E.pool) {
    freeSlot(slot, true);
    if (slot.panner) {
      try { slot.panner.disconnect(); } catch (_e) { /* already gone */ }
    }
  }
  E = null;
}
