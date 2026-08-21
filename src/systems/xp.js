// IRONWILD - XP / leveling (v3 progression row).
// Kill / gather / scan / kill-streak sources feed a single progress pool owned
// by G.xp { level, cur, next }. Fully event-driven through the bus; no DOM of
// its own (ui/hud.js renders the bar and pulses on 'xpGain'). Level-ups grant
// a skill point, toast 'LEVEL n' and emit 'levelUp' {level} for audio/menus.

import { bus } from '../core/events.js';
import { G } from '../core/state.js';

// XP granted per machine type on death (ARCHITECTURE_V3 progression row).
const KILL_XP = {
  skitter: 20,
  bramblehorn: 30,
  rendclaw: 45,
  ironmaw: 80,
  duskwing: 60,
  bulwark: 70,
  mirefang: 55,
  monarch: 500,
};
const ALPHA_MULT = 1.5; // machines whose name starts with 'Alpha'
const PICKUP_XP = 5;    // any resource collected
const SCAN_XP = 15;     // any machine focus-scanned
const STREAK_XP = 15;   // every 3rd consecutive kill (machines/ai.js window)

let inited = false;

/** XP needed to clear `level` (curve from the v3 doc, rounded). */
export function nextFor(level) {
  return Math.round(100 * Math.pow(level, 1.35));
}

function onMachineDied(e) {
  const m = e && e.machine;
  const base = m && KILL_XP[m.type];
  if (!base) return; // unknown / non-granting type (e.g. vantage)
  const alpha = typeof m.name === 'string' && m.name.startsWith('Alpha');
  grantXp(alpha ? base * ALPHA_MULT : base, `kill:${m.type}`);
}

function onPickup() {
  grantXp(PICKUP_XP, 'pickup');
}

function onMachineScanned() {
  grantXp(SCAN_XP, 'scan');
}

// ai.js counts consecutive kills inside its streak window and emits
// 'killStreak' {count} per kill from the 2nd onward; every 3rd link of the
// chain pays a small bonus through the normal grantXp flow (HUD/level react
// naturally). Streak reset rules stay owned by ai.js.
function onKillStreak(e) {
  const n = e && e.count;
  if (Number.isFinite(n) && n > 0 && n % 3 === 0) grantXp(STREAK_XP, 'streak');
}

/**
 * Add XP to the pool, carrying across every threshold the amount clears.
 * Each level-up: +1 skill point, 'LEVEL n' toast, 'levelUp' {level} event.
 * Amounts are rounded so G.xp.cur stays integral (alpha x1.5 can halve).
 */
export function grantXp(amount, reason) {
  const amt = Math.round(Number(amount) || 0);
  if (amt <= 0) return;
  G.xp.cur += amt;
  bus.emit('xpGain', { amount: amt, reason: String(reason || '') });
  while (G.xp.cur >= G.xp.next) {
    G.xp.cur -= G.xp.next;
    G.xp.level++;
    G.xp.next = nextFor(G.xp.level);
    G.inventory.skillPoints++;
    bus.emit('notify', { text: `LEVEL ${G.xp.level}`, tone: 'good' });
    bus.emit('levelUp', { level: G.xp.level });
  }
}

/** Subscribe the XP sources and normalize G.xp. Idempotent. */
export function createXp() {
  if (inited) return;
  inited = true;

  // Defensive defaults in case a future save restore leaves G.xp partial.
  if (!G.xp || typeof G.xp !== 'object') G.xp = { level: 1, cur: 0, next: 100 };
  if (!Number.isFinite(G.xp.level) || G.xp.level < 1) G.xp.level = 1;
  if (!Number.isFinite(G.xp.cur) || G.xp.cur < 0) G.xp.cur = 0;
  if (!Number.isFinite(G.xp.next) || G.xp.next <= 0) G.xp.next = nextFor(G.xp.level);

  bus.on('machineDied', onMachineDied);
  bus.on('pickup', onPickup);
  bus.on('machineScanned', onMachineScanned);
  bus.on('killStreak', onKillStreak);
}

/**
 * Per-frame step (contract symmetry with the other systems): XP progression
 * is fully event-driven, so there is no per-frame work; dt is validated
 * and ignored, exactly like the sibling systems guard their inputs.
 */
export function updateXp(_dt) {
  // XP progression is fully event-driven: no per-frame work.
}
