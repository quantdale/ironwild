// IRONWILD - machine status effects: minimal data-driven framework (Wave F)
// with burn as its first registered entry. Fire arrows apply burn via
// applyBurn(); main.js drives updateStatusFX(dt). Per-machine state lives as
// flat scalars under machine._stat[id] = { t, acc } - zero allocations in the
// update loop after first application. Burn also raises the panic flag that
// machines/ai.js reads to make the victim flee briefly.

import * as THREE from 'three';
import { G } from '../core/state.js';
import { checkDamageTiers } from './damage.js';

export const BURN_DPS = 12;   // burn damage per second
export const BURN_DURATION = 4; // seconds of burn per application (refreshed on re-hit)
const TICK_INTERVAL = 0.5;    // damage applied in discrete ticks
const TICK_DMG = BURN_DPS * TICK_INTERVAL;
const TICK_POOL = 16;         // concurrent burn tick numbers
const TICK_DUR = 0.7;         // tick number lifetime
const TICK_RISE = 1.0;        // world units a tick number climbs
const MAX_TICKS_PER_FRAME = 32; // defensive cap on catch-up ticks in one update

const _pt = new THREE.Vector3();

let inited = false;
let ticks = [];
let tickCursor = 0;

// ------------------------------------------------------------------ registry
// Minimal status-effect framework: id -> descriptor, iterated in registration
// order by updateStatusFX. New statuses (chill, shock, ...) register here and
// inherit the tick loop, catch-up guard and corpse cleanup for free.
//   tickInterval  seconds between application ticks
//   duration      default seconds when applied without an override
//   begin(m,dur)  called on start/refresh (re-arm side flags)
//   tick(m)       apply one tick; return false to stop ticking this machine
//   sustain(m,t)  per-frame follow-through while active (t = seconds left)
//   expire(m)     called when the timer runs out or the holder dies
const STATUSES = new Map();

/**
 * Register a status descriptor under `id`. Registration order == update
 * order; 'burn' registers first at module load. Descriptors must provide
 * tickInterval and tick(); the loop feature-detects the optional hooks.
 */
export function registerStatus(id, desc) {
  STATUSES.set(id, desc);
}

/** Lazily create the flat scalar store for one status on one machine. */
function statusStore(m, id) {
  if (!m._stat) m._stat = {};
  let st = m._stat[id];
  if (!st) {
    st = { t: 0, acc: 0 }; // t = seconds remaining, acc = progress to next tick
    m._stat[id] = st;
  }
  return st;
}

// ------------------------------------------------------------- tick numbers

function makeTickEntry() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 28; // under weak-point numbers (30), over machines
  sprite.visible = false;
  return { sprite, ctx, tex, t: 0, active: false, startY: 0 };
}

/** Small orange damage number for one burn tick. */
function spawnTickNumber(value, pos) {
  if (!inited) return;
  const n = ticks[tickCursor];
  tickCursor = (tickCursor + 1) % TICK_POOL;
  n.active = true;
  n.t = 0;
  n.startY = pos.y + 0.25;
  const ctx = n.ctx;
  ctx.clearRect(0, 0, 128, 48);
  ctx.font = 'bold 30px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(24,10,4,0.85)';
  ctx.strokeText(String(value), 64, 26);
  ctx.fillStyle = '#ff8c3b'; // fire orange
  ctx.fillText(String(value), 64, 26);
  n.tex.needsUpdate = true;
  n.sprite.material.opacity = 1;
  n.sprite.position.set(
    pos.x + (Math.random() - 0.5) * 0.4,
    n.startY,
    pos.z + (Math.random() - 0.5) * 0.4,
  );
  n.sprite.scale.set(0.95, 0.36, 1);
  n.sprite.visible = true;
}

function updateTickNumbers(dt) {
  for (let i = 0; i < ticks.length; i++) {
    const n = ticks[i];
    if (!n.active) continue;
    n.t += dt;
    const k = n.t / TICK_DUR;
    if (k >= 1) {
      n.active = false;
      n.sprite.visible = false;
      continue;
    }
    n.sprite.position.y = n.startY + TICK_RISE * k;
    n.sprite.material.opacity = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
  }
}

// ------------------------------------------------------------------ public

// First registered status: burn. Numbers and panic behavior are byte-for-byte
// the v2 values - only the storage/tick plumbing moved into the framework.
registerStatus('burn', {
  tickInterval: TICK_INTERVAL,
  duration: BURN_DURATION,
  begin(m, dur) {
    // AI flee flag lasts exactly as long as the flames (machines/ai.js reads it).
    m.panicT = dur;
    m.panic = true;
  },
  tick(m) {
    _pt.copy(m.group.position);
    _pt.y += 1.2 + m.radius * 0.5;
    // point=null: the exact-center tick point would land inside the bulwark's
    // front-cone test (machines.js isFrontConeHit) and deflect every tick.
    const landed = m.hit(TICK_DMG, null, null) !== false; // may kill the machine
    if (landed) {
      spawnTickNumber(TICK_DMG, _pt);
      checkDamageTiers(m); // burn ticks drive the 50%/25% 'machineDamaged' tiers too
    }
    return m.alive;
  },
  sustain(m, tLeft) {
    m.panicT = tLeft; // panic stays aligned with the remaining flames
    m.panic = true;
  },
  expire(m) {
    m.panicT = 0;
    m.panic = false;
  },
});

/**
 * Ignite a machine: BURN_DPS for `seconds`, refreshed (timer restarted) on
 * every re-hit. Raises m.panic / m.panicT for the AI flee-briefly behavior.
 * Safe to call on dead or invalid machines (no-op).
 */
export function applyBurn(machine, seconds = BURN_DURATION) {
  if (!machine || !machine.alive || typeof machine.hit !== 'function') return false;
  const dur = seconds > 0 ? seconds : BURN_DURATION;
  const st = statusStore(machine, 'burn');
  st.t = dur; // refresh: restart the full timer...
  st.acc = 0; // ...and the tick accumulator, so the next tick lands a full interval out
  const desc = STATUSES.get('burn');
  if (desc && typeof desc.begin === 'function') desc.begin(machine, dur);
  if (!inited && G.scene) createStatusFX();
  return true;
}

/** Build the tick-number pool and add it to the scene. Idempotent. */
export function createStatusFX() {
  if (inited || !G.scene) return;
  inited = true;
  for (let i = 0; i < TICK_POOL; i++) {
    const e = makeTickEntry();
    G.scene.add(e.sprite);
    ticks.push(e);
  }
}

/**
 * Advance every registered status on every machine + tick-number FX. dt is
 * the scaled gameplay delta from main.js. Damage routes through machine.hit
 * so death/loot/events stay identical to arrow kills.
 */
export function updateStatusFX(dt) {
  if (!inited) createStatusFX();
  if (inited && dt > 0) updateTickNumbers(dt);
  if (!(dt > 0) || !G.machines) return;

  for (const [id, desc] of STATUSES) {
    for (let i = 0; i < G.machines.length; i++) {
      const m = G.machines[i];
      const st = m._stat ? m._stat[id] : null;
      if (!st || st.t <= 0) continue;
      if (!m.alive) { // corpses do not keep status effects running
        st.t = 0;
        st.acc = 0;
        if (desc.expire) desc.expire(m);
        continue;
      }
      // Only time actually spent in the status accrues ticks, so a frame that
      // outlasts the remaining duration still lands every fully-elapsed
      // interval within it.
      const activeSeconds = Math.min(dt, st.t);
      st.t -= dt;
      st.acc += activeSeconds;
      let guard = MAX_TICKS_PER_FRAME; // cap catch-up work after huge frame gaps
      let ended = false;
      while (st.acc >= desc.tickInterval && typeof desc.tick === 'function' && m.alive && guard-- > 0) {
        st.acc -= desc.tickInterval;
        if (desc.tick(m) === false) ended = true; // descriptor dropped it early
      }
      if (ended || !m.alive || st.t <= 0) { // killed mid-tick or ran out: drop state now, not next pass
        st.t = Math.max(0, st.t);
        st.acc = 0;
        if (desc.expire) desc.expire(m);
      } else if (desc.sustain) {
        desc.sustain(m, st.t); // per-frame follow-through with the time left
      }
    }
  }
}
