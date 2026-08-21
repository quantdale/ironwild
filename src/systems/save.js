// IRONWILD - persistence: single save slot in localStorage ('ironwild-save').
// Serializes player pos/vitals, inventory (incl. fire arrows), skills, time of
// day, map reveal, quest slots, XP/level and the bestiary; machines are never
// saved (they respawn fresh on load). initSave() wires the panel-open save
// hook; updateSave(dt) polls KeyP quicksave + the 90 s autosave timer and
// snapshots on pause. loadGame() accepts any save version >= 2 - newer fields
// are additive and simply fall back to the fresh-boot defaults when absent.

import { bus } from '../core/events.js';
import { G } from '../core/state.js';
import { Input } from '../core/input.js';
import { clamp } from '../core/utils.js';

const SAVE_KEY = 'ironwild-save';
const SAVE_VERSION = 3; // v3->v4: added bestiary (loader tolerates the old shape)
const AUTOSAVE_INTERVAL = 90; // seconds between autosaves

let inited = false;
let autosaveT = 0;      // seconds since last save (counts while playing)
let wasPaused = false;  // rising edge of G.paused -> snapshot progress

/** True when a save exists in localStorage (storage errors count as "no"). */
export function hasSave() {
  try {
    return !!localStorage.getItem(SAVE_KEY);
  } catch (err) {
    return false;
  }
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
    quests: { completed: G.quests.completed, slots },
    xp: Object.assign({}, G.xp),           // v4: level progress used to reset on every load
    bestiary: Object.assign({}, G.bestiary), // v4: discovered/killed species
  };
}

/**
 * Write the current run to localStorage. No-ops before start / after death.
 * Emits 'gameSaved' {manual}; a manual save also toasts. Returns success.
 */
export function saveGame(manual = false) {
  if (!G.started || G.gameOver || !G.player) return false;
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
 * Restore pos/hp/stamina/inventory/skills/timeOfDay/mapRevealed/quests from
 * localStorage onto G. Machines are left alone - the world respawns fresh.
 * Re-emits 'questUpdate' per restored slot so live UI (tracker/minimap)
 * refreshes. Returns true on success, false on missing/corrupt data.
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
  // Accept any prior save shape (2 or 3): fields absent from older saves are
  // additive and simply keep whatever createXxx() already defaulted on G.
  if (!data || !Number.isInteger(data.v) || data.v < 2 || data.v > SAVE_VERSION ||
    !Array.isArray(data.pos)) return false;
  if (!G.player || !G.player.pos) return false;

  G.player.pos.set(data.pos[0], data.pos[1], data.pos[2]);
  G.player.hp = clamp(Number(data.hp) || 1, 1, G.player.maxHp); // never load back dead
  G.player.stamina = clamp(Number(data.stamina) || 0, 0, G.player.maxStamina);

  if (data.inventory && typeof data.inventory === 'object') {
    for (const k in G.inventory) {
      const v = data.inventory[k];
      if (typeof v === 'number' && isFinite(v)) G.inventory[k] = v;
    }
  }
  if (data.skills && typeof data.skills === 'object') {
    for (const k in G.skills) {
      const v = data.skills[k];
      if (v === 0 || v === 1) G.skills[k] = v;
    }
  }
  if (typeof data.timeOfDay === 'number' && isFinite(data.timeOfDay)) {
    let t = data.timeOfDay % 1;
    if (t < 0) t += 1;
    G.timeOfDay = t;
  }
  G.mapRevealed = !!data.mapRevealed;

  if (data.quests && Array.isArray(data.quests.slots)) {
    G.quests.completed = data.quests.completed | 0;
    for (let i = 0; i < 3; i++) {
      const q = data.quests.slots[i];
      G.quests.slots[i] = q && typeof q === 'object' ? q : null;
      if (G.quests.slots[i]) bus.emit('questUpdate', { quest: G.quests.slots[i] });
    }
  }

  // v4: absent on saves from before the bestiary/xp-persist update - the
  // xp.js/bestiary.js create() defaults already on G stand in for those runs.
  if (data.xp && typeof data.xp === 'object') {
    if (Number.isFinite(data.xp.level) && data.xp.level >= 1) G.xp.level = data.xp.level;
    if (Number.isFinite(data.xp.cur) && data.xp.cur >= 0) G.xp.cur = data.xp.cur;
    if (Number.isFinite(data.xp.next) && data.xp.next > 0) G.xp.next = data.xp.next;
  }
  if (data.bestiary && typeof data.bestiary === 'object') {
    for (const type in data.bestiary) {
      const e = data.bestiary[type];
      if (!e || typeof e !== 'object') continue;
      G.bestiary[type] = { seen: !!e.seen, killed: !!e.killed };
    }
  }
  return true;
}

/** Drop the save slot (used by fresh-start flows). Safe to call anytime. */
export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (err) { /* storage unavailable */ }
}

/** Subscribe persistence hooks. Call once during boot. */
export function initSave() {
  if (inited) return;
  inited = true;
  // Opening a panel (inventory/skills/settings) snapshots progress. v1 menus
  // emit action 'open'; v2 panels may use 'open-panel' - accept both.
  bus.on('ui', (e) => {
    const a = e && e.action;
    if (a === 'open' || a === 'open-panel') saveGame(false);
  });
}

/**
 * Per-frame tick (raw dt). Polls KeyP manual quicksave, saves once when a
 * pause/panel opens, and autosaves every AUTOSAVE_INTERVAL of played time -
 * all only while started && !paused && !gameOver.
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

  if (Input.pressed('KeyP')) saveGame(true);

  autosaveT += dt;
  if (autosaveT >= AUTOSAVE_INTERVAL) saveGame(false);
}

// Integrator-facing alias (ARCHITECTURE_V2 loop order calls save.tick(rawDt)).
export { updateSave as tick };
