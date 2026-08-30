// IRONWILD - hunt contracts: three slots of deterministic contracts, refreshed
// as they complete. Types: hunt N of a machine · gather N of a resource ·
// focus-scan the Vantage. Owns G.quests and the self-contained tracker block
// (top-left, below the objective hint; pointer-events none). Quest records are
// plain data so systems/save.js can serialize them verbatim.

import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { makeRng, randRange } from '../core/utils.js';

const REFILL_DELAY = 20; // seconds a completed slot lingers before a new contract
const HUNT_TYPES = ['skitter', 'bramblehorn', 'rendclaw', 'ironmaw'];
const GATHER_TYPES = ['wood', 'shards', 'oil'];

const MACHINE_NAMES = {
  skitter: 'Skitter',
  bramblehorn: 'Bramblehorn',
  rendclaw: 'Rendclaw',
  ironmaw: 'Ironmaw',
};
const ICONS = { hunt: '\u2694', gather: '\u2726', scanVantage: '\u25CE' };
// Reward granted on completion, by quest kind.
const REWARDS = {
  hunt: { kind: 'skillPoints', amount: 1, label: '+1 skill point' },
  gather: { kind: 'shards', amount: 6, label: '+6 shards' },
  scanVantage: { kind: 'medicine', amount: 1, label: '+1 medicine' },
};

let inited = false;
let rng = null;
let nextId = 1;
// Contracts generated so far lives on G.quests.genCount (defaulted in
// createQuests) so systems/save.js can persist it alongside the slots -
// otherwise Continue would replay the forced opening trio every session.
let els = null;      // { root, slots:[{el,icon,name,count,fill, caches...}] }
let shown = false;

// ---------------------------------------------------------------- creation --

/** True while at least one scannable Vantage exists in the world. */
function hasLiveVantage() {
  return G.machines.some((m) => m.type === 'vantage' && m.alive);
}

/** Draw one fresh contract from the deterministic stream. Pure data record.
 *  The first three of a run are forced to one of each type so the opening
 *  hour showcases every contract kind; later ones roll freely. genCount
 *  persists through saves, so "first three" really means the first three. */
function makeQuest() {
  const q = {
    id: nextId++,
    type: '',
    target: '',
    targetName: '',
    title: '',
    need: 1,
    progress: 0,
    rewardLabel: '',
    done: false,
    refillT: 0,
  };
  // scanVantage needs a live Vantage; the world spawns exactly one and it
  // never respawns (ai.js drops it from the respawn queue), so once it is
  // dead any scan draw - forced or rolled - falls through to gather instead
  // of dealing a contract that can never complete.
  const canScan = hasLiveVantage();
  const forced = G.quests.genCount < 3 ? ['hunt', 'gather', 'scanVantage'][G.quests.genCount] : null;
  const effForced = forced === 'scanVantage' && !canScan ? 'gather' : forced;
  const roll = effForced ? -1 : rng();
  G.quests.genCount++;
  if (effForced === 'hunt' || (!effForced && roll < 0.45)) {
    q.type = 'hunt';
    q.target = HUNT_TYPES[Math.floor(rng() * HUNT_TYPES.length)];
    q.targetName = MACHINE_NAMES[q.target];
    q.need = Math.floor(randRange(rng, 2, 5)); // 2..4
    q.title = `Hunt ${q.need} \u00D7 ${q.targetName}`;
  } else if (effForced === 'gather' || (!effForced && (roll < 0.85 || !canScan))) {
    q.type = 'gather';
    q.target = GATHER_TYPES[Math.floor(rng() * GATHER_TYPES.length)];
    q.targetName = q.target;
    q.need = Math.floor(randRange(rng, 4, 9)); // 4..8
    q.title = `Gather ${q.need} ${q.targetName}`;
  } else {
    q.type = 'scanVantage';
    q.target = 'vantage';
    q.targetName = 'Vantage';
    q.need = 1;
    q.title = 'Focus-scan a Vantage';
  }
  q.rewardLabel = REWARDS[q.type].label;
  return q;
}

function completeQuest(q) {
  q.progress = q.need;
  q.done = true;
  q.refillT = REFILL_DELAY;
  const rw = REWARDS[q.type];
  // Heavy hunts (ironmaw) carry disproportionate risk for the same flat
  // reward as a skitter cull - kick in a bonus skill point.
  const bonus = q.type === 'hunt' && q.target === 'ironmaw' ? 1 : 0;
  const amt = rw.amount + bonus;
  G.inventory[rw.kind] += amt;
  G.quests.completed++;
  const label = bonus ? `${rw.label} +${bonus} bonus SP` : rw.label;
  bus.emit('notify', { text: `Contract complete \u2014 ${q.title} (${label})`, tone: 'good' });
  bus.emit('questUpdate', { quest: q });
}

// --------------------------------------------------------------- progress ----

function onMachineDied(e) {
  const type = e && e.machine && e.machine.type;
  if (!type) return;
  for (let i = 0; i < 3; i++) {
    const q = G.quests.slots[i];
    if (!q || q.done || q.type !== 'hunt' || q.target !== type) continue;
    q.progress++;
    if (q.progress >= q.need) completeQuest(q);
    else bus.emit('questUpdate', { quest: q });
  }
}

function onPickup(e) {
  const type = e && e.type;
  const amount = e && e.amount > 0 ? e.amount : 1;
  if (!type) return;
  for (let i = 0; i < 3; i++) {
    const q = G.quests.slots[i];
    if (!q || q.done || q.type !== 'gather' || q.target !== type) continue;
    q.progress = Math.min(q.need, q.progress + amount);
    if (q.progress >= q.need) completeQuest(q);
    else bus.emit('questUpdate', { quest: q });
  }
}

function onMachineScanned(e) {
  const m = e && e.machine;
  if (!m || m.type !== 'vantage') return;
  for (let i = 0; i < 3; i++) {
    const q = G.quests.slots[i];
    if (!q || q.done || q.type !== 'scanVantage') continue;
    q.progress = q.need;
    completeQuest(q);
  }
}

// ------------------------------------------------------------------ dom -----

function buildDom() {
  const root = document.createElement('div');
  root.id = 'iw-quests';
  const title = document.createElement('div');
  title.className = 'iw-qtitle';
  title.textContent = 'CONTRACTS';
  root.appendChild(title);

  const slots = [];
  for (let i = 0; i < 3; i++) {
    const el = document.createElement('div');
    el.className = 'iw-qslot';
    el.innerHTML =
      '<span class="iw-qicon"></span>' +
      '<div class="iw-qbody">' +
        '<div class="iw-qrow"><span class="iw-qname"></span>' +
        '<span class="iw-qcount"></span></div>' +
        '<div class="iw-qbar"><div class="iw-qfill"></div></div>' +
      '</div>';
    root.appendChild(el);
    slots.push({
      el,
      icon: el.querySelector('.iw-qicon'),
      name: el.querySelector('.iw-qname'),
      count: el.querySelector('.iw-qcount'),
      fill: el.querySelector('.iw-qfill'),
      cType: '', cTitle: '', cCount: '', cPct: -1, cDone: false, cNull: true,
    });
  }
  document.body.appendChild(root);
  els = { root, slots };
}

/** Diff one slot against its render cache; touches DOM only on change. */
function renderSlot(i) {
  const s = els.slots[i];
  const q = G.quests.slots[i];
  const isNull = !q;
  if (s.cNull !== isNull) {
    s.cNull = isNull;
    s.el.style.display = isNull ? 'none' : 'flex';
  }
  if (isNull) return;

  if (s.cType !== q.type) {
    s.cType = q.type;
    s.icon.textContent = ICONS[q.type] || '\u2022';
  }
  if (s.cTitle !== q.title) {
    s.cTitle = q.title;
    s.name.textContent = q.title;
  }
  const count = `${Math.min(q.progress, q.need)} / ${q.need}`;
  if (s.cCount !== count) {
    s.cCount = count;
    s.count.textContent = count;
  }
  const pct = Math.round((Math.min(q.progress / q.need, 1)) * 100);
  if (s.cPct !== pct) {
    s.cPct = pct;
    s.fill.style.width = pct + '%';
  }
  if (s.cDone !== q.done) {
    s.cDone = q.done;
    s.el.classList.toggle('done', q.done); // completed slots flash green
  }
}

function refreshAll() {
  for (let i = 0; i < 3; i++) renderSlot(i);
}

function injectStyles() {
  if (document.getElementById('iw-quest-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-quest-style';
  st.textContent = `
#iw-quests{position:fixed;top:44px;left:20px;z-index:20;pointer-events:none;
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;display:flex;
  flex-direction:column;gap:5px;opacity:0;transition:opacity .5s;}
#iw-quests.show{opacity:1;}
.iw-qtitle{font-size:10px;letter-spacing:2px;color:rgba(230,240,245,.55);
  margin-bottom:2px;text-shadow:0 1px 2px rgba(0,0,0,.8);}
.iw-qslot{display:flex;align-items:center;gap:8px;background:rgba(8,12,16,.55);
  border:1px solid rgba(255,255,255,.12);padding:5px 9px;min-width:216px;}
.iw-qicon{width:16px;text-align:center;color:#59e3ff;font-size:13px;}
.iw-qbody{flex:1;}
.iw-qrow{display:flex;justify-content:space-between;gap:12px;font-size:11px;
  letter-spacing:.4px;margin-bottom:3px;text-shadow:0 1px 2px rgba(0,0,0,.8);}
.iw-qcount{color:rgba(223,231,234,.65);}
.iw-qbar{height:3px;background:rgba(255,255,255,.14);}
.iw-qfill{height:100%;width:0%;background:#59e3ff;transition:width .25s;}
.iw-qslot.done{border-color:rgba(126,214,126,.7);
  animation:iwqflash .5s ease-in-out 3;}
.iw-qslot.done .iw-qfill{background:#7ed67e;}
.iw-qslot.done .iw-qicon,.iw-qslot.done .iw-qname{color:#7ed67e;}
@keyframes iwqflash{0%,100%{background:rgba(8,12,16,.55);}
  50%{background:rgba(46,84,50,.75);}}
`;
  st.textContent += `
@media (max-width:700px) {
  #iw-quests { top:calc(42px + env(safe-area-inset-top, 0px)); left:max(10px,env(safe-area-inset-left, 0px)); right:calc(140px + env(safe-area-inset-right, 0px)); width:min(216px,calc(100vw - 160px - env(safe-area-inset-right, 0px))); gap:3px; }
  .iw-qslot { min-width:0; width:100%; box-sizing:border-box; gap:5px; padding:4px 6px; }
  .iw-qicon { width:14px; flex:0 0 14px; font-size:12px; }
  .iw-qrow { gap:5px; font-size:10px; letter-spacing:.2px; }
  .iw-qname { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
}`;
  document.head.appendChild(st);
}

// ---------------------------------------------------------------- public ----

/**
 * Shape check for records restored from a save (systems/save.js): an unknown
 * type, non-finite number, or a target the live game can never progress
 * (hand-edited/legacy record) would wedge the slot forever, so invalid
 * records are dropped and re-dealt instead.
 */
export function isValidQuest(q) {
  if (!q || typeof q !== 'object' || !REWARDS[q.type]) return false;
  // Target-per-type against live data: hunts draw from the dealable species
  // table, gathers must name a real inventory field; scanVantage's target is
  // fixed ('vantage'), so any record of that type is progressable.
  if (q.type === 'hunt') {
    if (!HUNT_TYPES.includes(q.target)) return false;
  } else if (q.type === 'gather') {
    if (!GATHER_TYPES.includes(q.target) || typeof G.inventory[q.target] !== 'number') return false;
  }
  return Number.isFinite(q.progress) && Number.isFinite(q.need) && q.need > 0 &&
    Number.isFinite(q.refillT);
}

/**
 * Build the tracker and deal a contract into every empty slot. At boot all
 * three are empty (loadGame runs later, on Continue, and then replaces slots
 * and genCount wholesale). Subscribes progress events.
 */
export function createQuests() {
  if (inited) return;
  inited = true;
  rng = makeRng((CONFIG.seed + 4242) >>> 0);
  // Fresh boots start the stream at 0; Continue's loadGame overwrites it
  // from the save alongside the slots.
  if (!Number.isFinite(G.quests.genCount)) G.quests.genCount = 0;
  injectStyles();
  buildDom();

  for (let i = 0; i < 3; i++) {
    if (!G.quests.slots[i]) G.quests.slots[i] = makeQuest();
  }
  refreshAll();

  bus.on('machineDied', onMachineDied);
  bus.on('pickup', onPickup);
  bus.on('machineScanned', onMachineScanned);
  // Redraw whenever any slot changes (progress, completion, save-load restore).
  bus.on('questUpdate', (e) => {
    const q = e && e.quest;
    if (q && q.id >= nextId) nextId = q.id + 1; // keep ids unique after a restore
    refreshAll();
  });
}

/** Deal a fresh contract into slot i and announce it. */
function replaceSlot(i) {
  const nq = makeQuest();
  G.quests.slots[i] = nq;
  bus.emit('questUpdate', { quest: nq });
}

/**
 * Per-frame (scaled dt): tracker visibility + refill timers for completed
 * slots. DOM updates are event-driven; this only ages timers.
 */
export function updateQuests(dt) {
  if (!inited || !els) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;

  const show = !!G.started;
  if (show !== shown) {
    shown = show;
    els.root.classList.toggle('show', show);
  }
  if (!show) return;

  for (let i = 0; i < 3; i++) {
    const q = G.quests.slots[i];
    if (!q) {
      replaceSlot(i); // dropped by load-time validation -> deal a replacement
    } else if (!q.done) {
      // An open scan contract outlives its Vantage only as a deadlock (the
      // single world Vantage never respawns) - swap it for a fresh roll.
      if (q.type === 'scanVantage' && !hasLiveVantage()) replaceSlot(i);
    } else {
      q.refillT -= dt;
      if (q.refillT <= 0) replaceSlot(i);
    }
  }
}
