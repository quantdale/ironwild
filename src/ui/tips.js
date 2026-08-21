// IRONWILD - contextual one-time hint stack (v3).
// Six teaching moments (first machine within 40u, hp below half, stealth-grass
// concealment, first fire arrow, first storm, first finished contract), each
// displayed at most once per browser: shown ids persist as a JSON array in
// localStorage 'ironwild-tips'. One card, bottom-right above the ammo counter;
// its offset is measured at runtime against #iw-res / the minimap canvas so the
// stack never covers the top-right cluster. Max 1 visible, extras queue. Fades
// are CSS transitions - per-frame work is a few compares plus the 40u machine
// scan, and DOM is touched only on state changes.

import { bus } from '../core/events.js';
import { G } from '../core/state.js';

const LS_KEY = 'ironwild-tips';
const SCAN_DIST2 = 40 * 40; // hint when any alive machine is within 40u
const TIP_TIME = 5.0;       // total card lifetime: fade-in + hold + fade-out (s)
const FADE = 0.4;           // css transition time for both fades (s)
const BASE_BOTTOM = 64;     // idle anchor: just above the ammo counter
const MIN_BOTTOM = 56;      // never slide down into the ammo readout
const CLUSTER_GAP = 12;     // clearance kept below the resources/minimap cluster

// Trigger order doubles as queue priority when several fire the same frame.
const TEXTS = {
  scan: '[Q] Focus scan reveals weak points',
  medicine: '[H] Use medicine',
  conceal: 'Concealed \u2014 machines barely see you',
  firearrow: '[X] Switch arrow type',
  storm: 'Storms pass. Machines hunt by sound.',
  contract: 'New contracts appear over time',
};

let created = false;
let root = null;
let card = null;
let shown = new Set(); // ids already displayed (mirrors localStorage)
let queue = [];        // triggered but not yet displayed ids
let cur = null;        // id currently on screen
let curT = 0;          // age of the current card
let fading = false;    // fade-out class already removed
let placed = false;
let placedBottom = -1;

// ---------------------------------------------------------------- public ----

export function createTips() {
  if (created) return;
  created = true;
  injectStyles();

  shown = loadShown();
  root = document.createElement('div');
  root.id = 'iw-tips';
  card = document.createElement('div');
  card.className = 'iw-tip';
  root.appendChild(card);
  document.body.appendChild(root);

  bus.on('questUpdate', onQuestUpdate);
  window.addEventListener('resize', () => { placed = false; });
  tryPlace();
}

/**
 * Per-frame (scaled dt): poll triggers, drain the queue, age the visible
 * card. No allocations beyond string compares; DOM writes only on change.
 */
export function updateTips(dt) {
  if (!created || !root || G.paused) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;
  if (!placed) tryPlace();

  if (G.started && !G.gameOver) pollTriggers();

  if (!cur && queue.length > 0) showNext(queue.shift());

  if (cur) {
    curT += dt;
    if (!fading && curT >= TIP_TIME - FADE) {
      fading = true;
      card.classList.remove('show');
    }
    if (curT >= TIP_TIME) {
      cur = null;
      fading = false;
      if (queue.length > 0) showNext(queue.shift());
    }
  }
}

// ------------------------------------------------------------- internals ----

/** Arm a tip; deduped against shown/queued/displayed so it fires once. */
function trigger(id) {
  if (shown.has(id) || cur === id || queue.indexOf(id) >= 0) return;
  queue.push(id);
}

function onQuestUpdate(e) {
  const q = e && e.quest;
  if (q && q.done && G.started && !G.gameOver) trigger('contract');
}

/** Cheap per-frame polls; every check is a compare, trigger() dedupes. */
function pollTriggers() {
  const p = G.player;
  if (!p || p.dead || !p.pos) return;
  const pp = p.pos;

  const machines = G.machines;
  for (let i = 0; i < machines.length; i++) {
    const m = machines[i];
    if (!m || !m.alive || !m.group) continue;
    const mp = m.group.position;
    const dx = mp.x - pp.x, dz = mp.z - pp.z;
    if (dx * dx + dz * dz <= SCAN_DIST2) {
      trigger('scan');
      break;
    }
  }

  if (p.maxHp > 0 && p.hp < p.maxHp * 0.5) trigger('medicine');
  if (p.concealed === true) trigger('conceal');
  if (G.inventory.fireArrows > 0) trigger('firearrow');
  if (G.weather.type === 'storm') trigger('storm');
}

/** Swap the card's text and fade it in; the id counts as shown from here. */
function showNext(id) {
  cur = id;
  curT = 0;
  fading = false;
  shown.add(id);
  saveShown();
  card.textContent = TEXTS[id] || '';
  card.classList.add('show');
  tryPlace(); // card height changed; re-check cluster clearance
}

function loadShown() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch (err) {
    return new Set(); // private mode / corrupted entry: replay every tip
  }
}

function saveShown() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify([...shown]));
  } catch (err) { /* storage unavailable: tips may repeat next session */ }
}

/**
 * Anchor above the ammo counter, right-aligned with the HUD column; pushed
 * downward when the measured resources/minimap cluster would be overlapped
 * (short windows give up the gap before covering the ammo readout).
 */
function tryPlace() {
  if (!root) return;
  placed = true;

  // Lowest edge of the top-right cluster: minimap canvas if positioned,
  // otherwise the resource counters it hangs below.
  let limitY = 0;
  const mm = document.getElementById('iw-minimap');
  if (mm) {
    const r = mm.getBoundingClientRect();
    if (r.height > 0) limitY = r.bottom;
  }
  if (!limitY) {
    const res = document.getElementById('iw-res');
    if (res) {
      const r = res.getBoundingClientRect();
      if (r.height > 0) limitY = r.bottom;
    }
  }

  let bottom = BASE_BOTTOM;
  if (limitY > 0) {
    const maxBottom = window.innerHeight - (limitY + CLUSTER_GAP) - root.offsetHeight;
    if (maxBottom < bottom) bottom = Math.max(MIN_BOTTOM, maxBottom);
  }
  const b = Math.round(bottom);
  if (b !== placedBottom) {
    placedBottom = b;
    root.style.bottom = b + 'px';
  }
}

function injectStyles() {
  if (document.getElementById('iw-tips-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-tips-style';
  st.textContent = `
#iw-tips{position:fixed;right:18px;z-index:20;pointer-events:none;}
.iw-tip{max-width:300px;background:rgba(8,12,16,.78);border:1px solid rgba(255,255,255,.15);
  border-left:3px solid #59e3ff;padding:7px 14px;font-size:13px;letter-spacing:.4px;
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;text-shadow:0 1px 2px rgba(0,0,0,.8);
  opacity:0;transform:translateY(8px);transition:opacity ${FADE}s,transform ${FADE}s;}
.iw-tip.show{opacity:1;transform:translateY(0);}
`;
  document.head.appendChild(st);
}
