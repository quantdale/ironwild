// IRONWILD - persistence: single save slot in localStorage ('ironwild-save').
// Serializes player pos/vitals, inventory (incl. fire arrows), skills, time of
// day, map reveal, quest slots, XP/level and the bestiary; machines are never
// saved (they respawn fresh on load). initSave() wires the panel-open save
// hook and the run-lifecycle transition; updateSave(dt) polls KeyP quicksave
// + the 90 s autosave timer and snapshots on pause. loadGame() accepts any
// save version >= 2 - newer fields are additive and simply fall back to the
// fresh-boot defaults when absent.
//
// Run lifecycle (permadeath): a run is LIVE while the player is alive and
// ENDED once they die. Death writes the run's final snapshot with an additive
// marker - run: { ended: true, endedAt } - directly to the slot (not through
// saveGame(), which refuses to write after death). The marker is the source
// of truth: hasSave() answers only "is a slot present", while
// hasRestorableRun() answers "may this run be restored" (slot exists, parses,
// and does not carry run.ended === true). loadGame() refuses ended runs too,
// so the permadeath rule holds even if the title-screen gate is bypassed.
// Saves from before this marker have no `run` field and stay restorable; any
// malformed `run` value is treated as "not ended" so a corrupt field can
// never brick a live run. If the mark write fails (storage unavailable /
// unparsable slot), clearSave() is the fallback so a finished run is never
// left restorable - the death flow itself must never throw.

import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { clamp } from '../core/utils.js';
import { isValidQuest } from './quests.js';
import { nextFor } from './xp.js';
import { normalizeExpeditionState } from './expedition.js';

const SAVE_KEY = 'ironwild-save';
const SAVE_VERSION = 4; // v4: persists the bounded expedition objective
const AUTOSAVE_INTERVAL = 90; // seconds between autosaves
const MAX_RESOURCE = 9999;
const MAX_MEDICINE = 99;
const MAX_LEVEL = 100;
const KNOWN_BESTIARY_TYPES = new Set([
  'skitter', 'bramblehorn', 'rendclaw', 'ironmaw', 'duskwing',
  'bulwark', 'vantage', 'mirefang', 'monarch',
]);

let inited = false;
let autosaveT = 0;      // seconds since last save (counts while playing)
let wasPaused = false;  // rising edge of G.paused -> snapshot progress
let runEnded = false;   // session-local: true once this run's death was marked

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function bounded(value, min, max, fallback = min) {
  return clamp(finiteNumber(value, fallback), min, max);
}

function restoreInventory(saved) {
  if (!saved || typeof saved !== 'object') return;
  const caps = {
    shards: MAX_RESOURCE,
    wood: MAX_RESOURCE,
    oil: MAX_RESOURCE,
    hide: MAX_RESOURCE,
    medicine: MAX_MEDICINE,
    arrows: G.inventory.maxArrows,
    fireArrows: G.inventory.maxFireArrows,
    skillPoints: MAX_RESOURCE,
    armor: 2,
  };
  for (const [key, cap] of Object.entries(caps)) {
    if (typeof saved[key] !== 'number' || !Number.isFinite(saved[key])) continue;
    G.inventory[key] = Math.floor(clamp(saved[key], 0, cap));
  }
}

/** True when a save exists in localStorage (storage errors count as "no"). */
export function hasSave() {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch (err) {
    return false;
  }
}

/**
 * True only when the slot holds a run that may be restored: it exists, parses,
 * and does not carry run.ended === true. Any missing, non-boolean, or malformed
 * `run` value counts as "not ended" - a corrupt marker must never brick a live
 * run. Distinct from hasSave() on purpose: hasSave() is slot presence only.
 */
export function hasRestorableRun() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    return !!data && typeof data === 'object' && !isRunEnded(data);
  } catch (err) {
    return false;
  }
}

/**
 * Strict end check: only run.ended === true ends a run. Missing, partial, or
 * malformed `run` values (string/number/null/...) are treated as not ended.
 */
function isRunEnded(data) {
  const run = data && typeof data === 'object' ? data.run : null;
  return !!run && typeof run === 'object' && run.ended === true;
}

/** Plain-data snapshot of everything we persist. Quest slots are pure data. */
function serialize() {
  const p = G.player;
  const slots = [];
  for (let i = 0; i < G.quests.slots.length; i++) {
    const q = G.quests.slots[i];
    slots.push(q ? Object.assign({}, q) : null);
  }
  return {
    v: SAVE_VERSION,
    pos: p ? [p.pos.x, p.pos.y, p.pos.z] : [0, 0, 8],
    hp: p ? p.hp : 100,
    stamina: p ? p.stamina : 100,
    inventory: Object.assign({}, G.inventory),
    skills: Object.assign({}, G.skills),
    timeOfDay: typeof G.timeOfDay === 'number' ? G.timeOfDay : 0.35,
    mapRevealed: !!G.mapRevealed,
    quests: { completed: G.quests.completed, genCount: G.quests.genCount | 0, slots },
    xp: Object.assign({}, G.xp),           // v4: level progress used to reset on every load
    bestiary: Object.assign({}, G.bestiary), // v4: discovered/killed species
    expedition: normalizeExpeditionState(G.expedition),
  };
}

/**
 * Write the current run to localStorage. No-ops before start / after death.
 * Emits 'gameSaved' {manual}; a manual save also toasts. Returns success.
 */
export function saveGame(manual = false) {
  if (!G.started || G.gameOver || !G.player || runEnded) return false;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(serialize()));
  } catch (err) {
    console.error('[save] write failed:', err);
    return false;
  }
  autosaveT = 0; // any save resets the autosave clock
  bus.emit('gameSaved', { manual: !!manual });
  if (manual) bus.emit('notify', { text: 'Game saved', tone: 'good' });
  return true;
}

/**
 * Restore pos/hp/stamina/inventory/skills/timeOfDay/mapRevealed/quests plus
 * xp/level and bestiary state from localStorage onto G. Machines are left
 * alone - the world respawns fresh. Re-emits 'questUpdate' per restored slot
 * so live UI (tracker/minimap) refreshes. Returns true on success, false on
 * missing/corrupt data.
 */
export function loadGame() {
  let data = null;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) data = JSON.parse(raw);
  } catch (err) {
    console.error('[save] read failed:', err);
    return false;
  }
  // Run lifecycle: a finished run is never restorable. Checked before any G
  // mutation, and strictly on run.ended === true (malformed markers are
  // treated as "not ended" so a corrupt field cannot brick a live run).
  if (isRunEnded(data)) return false;
  // Accept any prior save shape (2 or 3): fields absent from older saves are
  // additive and simply keep whatever createXxx() already defaulted on G.
  // pos needs length/finiteness/magnitude checks - Vector3.set would happily
  // inject NaN/huge values, poisoning physics and every later autosave.
  if (!data || !Number.isInteger(data.v) || data.v < 2 || data.v > SAVE_VERSION ||
    !Array.isArray(data.pos) || data.pos.length < 3 ||
    !data.pos.every(Number.isFinite) ||
    Math.hypot(data.pos[0], data.pos[2]) > CONFIG.playRadius + 12 ||
    data.pos[1] < -48 || data.pos[1] > 220) return false;
  if (!G.player || !G.player.pos) return false;

  G.player.pos.set(data.pos[0], data.pos[1], data.pos[2]);

  // Skills restore before vitals: Heartier Frame adds +30 max hp, so a saved
  // hp can legitimately sit above the unskilled cap. player.js re-derives
  // maxHp from G.skills on its next update and caps hp there - only the
  // "never load back dead" floor is enforced here.
  if (data.skills && typeof data.skills === 'object') {
    for (const k in G.skills) {
      const v = data.skills[k];
      if (v === 0 || v === 1) G.skills[k] = v;
    }
  }
  G.player.hp = bounded(data.hp, 1, 1000, G.player.maxHp || 100); // never load back dead
  G.player.stamina = bounded(data.stamina, 0, G.player.maxStamina || 100, 0);

  restoreInventory(data.inventory);
  if (typeof data.timeOfDay === 'number' && isFinite(data.timeOfDay)) {
    let t = data.timeOfDay % 1;
    if (t < 0) t += 1;
    G.timeOfDay = t;
  }
  G.mapRevealed = !!data.mapRevealed;

  if (data.quests && Array.isArray(data.quests.slots)) {
    G.quests.completed = Math.floor(bounded(data.quests.completed, 0, 9999, 0));
    // Contracts generated so far (drives the forced opening trio); absent on
    // v3 saves -> 0, which replays the trio exactly like those boots did.
    G.quests.genCount = Math.floor(bounded(data.quests.genCount, 0, 9999, 0));
    for (let i = 0; i < 3; i++) {
      const q = data.quests.slots[i];
      // Malformed records (NaN refillT etc.) would wedge their slot forever -
      // drop them; quests.js's refill path deals a replacement.
      G.quests.slots[i] = isValidQuest(q) ? q : null;
      if (G.quests.slots[i]) bus.emit('questUpdate', { quest: G.quests.slots[i] });
    }
  }

  // v4: absent on saves from before the bestiary/xp-persist update - the
  // xp.js/bestiary.js create() defaults already on G stand in for those runs.
  if (data.xp && typeof data.xp === 'object') {
    G.xp.level = Math.floor(bounded(data.xp.level, 1, MAX_LEVEL, G.xp.level || 1));
    G.xp.next = nextFor(G.xp.level);
    G.xp.cur = Math.floor(bounded(data.xp.cur, 0, G.xp.next - 1, G.xp.cur || 0));
  }
  if (data.bestiary && typeof data.bestiary === 'object') {
    for (const type in data.bestiary) {
      if (!KNOWN_BESTIARY_TYPES.has(type)) continue;
      const e = data.bestiary[type];
      if (!e || typeof e !== 'object') continue;
      G.bestiary[type] = { seen: !!e.seen, killed: !!e.killed };
    }
  }
  G.expedition = normalizeExpeditionState(data.expedition);
  // A successful restore means the run is live (ended runs were rejected
  // above), so re-arm the session's save triggers for it.
  runEnded = false;
  return true;
}

/** Drop the save slot (used by fresh-start flows). Safe to call anytime. */
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (err) { /* storage unavailable */ }
}

/**
 * Mark the current run as ended and write the final snapshot to the slot.
 * Composes the payload itself (serialize() + the run marker) rather than
 * calling saveGame(), which refuses to write once G.gameOver is set - so this
 * write cannot be skipped by that guard. Failure-safe: a throwing write or an
 * unparsable slot falls back to clearSave() so a finished run is never left
 * restorable, and nothing is ever thrown into the death flow.
 */
function markRunEnded() {
  // Exactly once per session: further emissions must neither rewrite the slot
  // (a later snapshot would carry live state) nor throw. The reload after
  // death boots a fresh module, so a new run re-arms this naturally.
  if (runEnded) return;
  runEnded = true;
  let payload;
  try {
    payload = serialize();
    payload.run = { ended: true, endedAt: finiteNumber(G.elapsed, 0) };
  } catch (err) {
    console.error('[save] run-end snapshot failed:', err);
    clearSave();
    return;
  }
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.error('[save] run-end write failed:', err);
    clearSave();
    return;
  }
  // The slot must now PARSE as an ended run. If it does not (storage silently
  // dropped/changed the write), a pre-death snapshot could still be sitting
  // there restorable - clear instead so death always ends the run's save.
  try {
    const check = JSON.parse(localStorage.getItem(SAVE_KEY) || '');
    if (!isRunEnded(check)) clearSave();
  } catch (err) {
    clearSave();
  }
}

/** Subscribe persistence hooks. Call once during boot. */
export function initSave() {
  if (inited) return;
  inited = true;
  // Opening a panel (inventory/skills/settings) snapshots progress. v1 menus
  // emit action 'open'; v2 panels may use 'open-panel' - accept both. After
  // death, saveGame() itself no-ops (G.gameOver), so this stays harmless.
  bus.on('ui', (e) => {
    const a = e && e.action;
    if (a === 'open' || a === 'open-panel') saveGame(false);
  });
  // Run lifecycle: death permanently ends the run's save. Ordering dependency
  // (src/main.js frame loop): playerDied is emitted synchronously during the
  // sim step (player.takeDamage) while the per-frame save tick runs later in
  // the same frame, gated on !G.gameOver - so this mark is written before any
  // later save could occur, and no save trigger rewrites the ended run. Task
  // 2.3: keep this handler before any save-tick work in the frame.
  bus.on('playerDied', markRunEnded);
}

/**
 * Per-frame tick (raw dt), driven by main.js while started && !gameOver -
 * including through pause, so the rising-edge snapshot below actually fires.
 * KeyP quicksave and the autosave clock stay gated on being unpaused.
 */
export function updateSave(dt) {
  if (!inited) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;

  // Rising edge of pause: snapshot now, then idle until play resumes.
  if (G.paused) {
    if (!wasPaused && G.started && !G.gameOver) saveGame(false);
    wasPaused = G.paused;
    return;
  }
  wasPaused = false;

  if (!G.started || G.gameOver) return;

  if (Input.wasActionPressed('quicksave')) saveGame(true); // v5: action layer

  autosaveT += dt;
  if (autosaveT >= AUTOSAVE_INTERVAL) {
    autosaveT = 0; // reset even if the write fails: retry next interval, not next frame
    saveGame(false);
  }
}

// Integrator-facing alias (ARCHITECTURE_V2 loop order calls save.tick(rawDt)).
export { updateSave as tick };
