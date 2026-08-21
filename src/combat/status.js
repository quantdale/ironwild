// IRONWILD - machine status effects (v2): burn damage-over-time.
// Fire arrows apply burn via applyBurn(); main.js drives updateStatusFX(dt).
// State lives as flat scalars on the machine object (per-machine scalar timer,
// zero allocations in the update loop). Burn also raises the panic flag that
// machines/ai.js reads to make the victim flee briefly.

import * as THREE from 'three';
import { G } from '../core/state.js';

export const BURN_DPS = 12;   // burn damage per second
export const BURN_DURATION = 4; // seconds of burn per application (refreshed on re-hit)
const TICK_INTERVAL = 0.5;    // damage applied in discrete ticks
const TICK_DMG = BURN_DPS * TICK_INTERVAL;
const TICK_POOL = 16;         // concurrent burn tick numbers
const TICK_DUR = 0.7;         // tick number lifetime
const TICK_RISE = 1.0;        // world units a tick number climbs

const _pt = new THREE.Vector3();

let inited = false;
let ticks = [];
let tickCursor = 0;

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

/**
 * Ignite a machine: BURN_DPS for `seconds`, refreshed (timer restarted) on
 * every re-hit. Raises m.panic / m.panicT for the AI flee-briefly behavior.
 * Safe to call on dead or invalid machines (no-op).
 */
export function applyBurn(machine, seconds = BURN_DURATION) {
  if (!machine || !machine.alive || typeof machine.hit !== 'function') return false;
  const dur = seconds > 0 ? seconds : BURN_DURATION;
  if (machine.burnT === undefined) {
    machine.burnT = 0;   // scalar seconds of burn remaining
    machine.burnAcc = 0; // partial progress toward the next tick
  }
  machine.burnT = dur;   // refresh: restart the full timer
  machine.panicT = dur;  // consumed by machines/ai.js (flee briefly)
  machine.panic = true;
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
 * Advance burn on every machine + tick-number FX. dt is the scaled gameplay
 * delta from main.js. Damage routes through machine.hit so death/loot/events
 * stay identical to arrow kills.
 */
export function updateStatusFX(dt) {
  if (!inited) createStatusFX();
  if (inited && dt > 0) updateTickNumbers(dt);
  if (!(dt > 0) || !G.machines) return;

  for (let i = 0; i < G.machines.length; i++) {
    const m = G.machines[i];
    if (m.burnT === undefined || m.burnT <= 0) continue;
    if (!m.alive) { // corpses do not keep burning
      m.burnT = 0;
      m.panicT = 0;
      m.panic = false;
      continue;
    }
    m.burnT -= dt;
    m.burnAcc += dt;
    while (m.burnAcc >= TICK_INTERVAL && m.burnT > 0 && m.alive) {
      m.burnAcc -= TICK_INTERVAL;
      _pt.copy(m.group.position);
      _pt.y += 1.2 + m.radius * 0.5;
      // point=null: the exact-center tick point would land inside the bulwark's
      // front-cone test (machines.js isFrontConeHit) and deflect every tick.
      const landed = m.hit(TICK_DMG, null, null) !== false; // may kill the machine
      if (landed) spawnTickNumber(TICK_DMG, _pt);
    }
    if (m.burnT <= 0 || !m.alive) {
      m.burnT = Math.max(0, m.burnT);
      m.panicT = m.burnT;
      m.panic = m.burnT > 0 && m.alive;
    } else {
      m.panicT = m.burnT; // panic lasts exactly as long as the flames
      m.panic = true;
    }
  }
}
