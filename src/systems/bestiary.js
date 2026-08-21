// IRONWILD - bestiary / kill-journal (v4). Tracks two states per machine
// species: 'seen' (focus-scanned or fought at least once) and 'killed' (at
// least one confirmed kill). Pure data lives on G.bestiary[type]; ui/menus.js
// renders the [B] panel from it, systems/save.js persists it. Lore blurbs are
// revealed on first kill, matching the "the machines remember" framing - the
// player is the one doing the remembering.

import { bus } from '../core/events.js';
import { G } from '../core/state.js';

// Every huntable/scannable species. Vantage is included for completeness -
// it can be "seen" and even "killed" (F11 in docs/BALANCE.md), just never
// aggros first.
export const SPECIES = [
  'skitter', 'bramblehorn', 'rendclaw', 'ironmaw', 'duskwing',
  'bulwark', 'vantage', 'mirefang', 'monarch',
];

const NAMES = {
  skitter: 'Skitter', bramblehorn: 'Bramblehorn', rendclaw: 'Rendclaw',
  ironmaw: 'Ironmaw', duskwing: 'Duskwing', bulwark: 'Bulwark',
  vantage: 'Vantage', mirefang: 'Mirefang', monarch: 'the Monarch',
};

// One line, revealed only after the first kill - a small reward for closing
// the loop on a fight rather than just fleeing or scanning from a distance.
const LORE = {
  skitter: 'Recovered vocal core: a chittering alarm cry, looped by design. It was built to see you long before you see it.',
  bramblehorn: 'Its hide is scarred with claw marks not its own — bramblehorns fought something before hunters ever came.',
  rendclaw: 'The neck-cable housing is the only soft point on an otherwise perfect killing shape.',
  ironmaw: 'Older frames like this were built to clear forests, not hunt them. The valley remembers which came first.',
  duskwing: 'Every dive ends the same way: wings folded, a hard landing, and a few seconds of stillness it cannot explain.',
  bulwark: 'The frontal plate deflects everything but memory. It still turns to face threats that stopped existing decades ago.',
  vantage: 'It never harmed a living thing. It only watched, and reported what it saw to no one left alive to hear it.',
  mirefang: 'The lake keeps its ambushes patient. It has waited longer than the valley has had a name.',
  monarch: 'Before it was a monster, someone called it something else. The valley does not remember what.',
};

let inited = false;

function ensureEntry(type) {
  if (!G.bestiary[type]) G.bestiary[type] = { seen: false, killed: false };
  return G.bestiary[type];
}

function markSeen(type) {
  if (!NAMES[type]) return;
  const e = ensureEntry(type);
  if (e.seen) return;
  e.seen = true;
  bus.emit('notify', { text: `Bestiary: ${NAMES[type]} observed`, tone: 'good' });
  bus.emit('bestiaryUnlock', { type, kind: 'seen' });
}

function markKilled(type) {
  if (!NAMES[type]) return;
  const e = ensureEntry(type);
  e.seen = true;
  if (e.killed) return;
  e.killed = true;
  bus.emit('notify', { text: `Bestiary: ${NAMES[type]} entry complete`, tone: 'good' });
  bus.emit('bestiaryUnlock', { type, kind: 'killed' });
}

function onScanned(e) {
  const m = e && e.machine;
  if (m) markSeen(m.type);
}

function onDied(e) {
  const m = e && e.machine;
  if (m) markKilled(m.type);
}

/** Display name for a species key (menus.js). */
export function speciesName(type) {
  return NAMES[type] || type;
}

/** Lore line for a species, or '' if not yet killed / unknown type. */
export function speciesLore(type) {
  const e = G.bestiary[type];
  return e && e.killed ? LORE[type] || '' : '';
}

/** Subscribe scan/kill tracking and seed every species as undiscovered. */
export function createBestiary() {
  if (inited) return;
  inited = true;
  for (const type of SPECIES) ensureEntry(type);
  bus.on('machineScanned', onScanned);
  bus.on('machineDied', onDied);
}
