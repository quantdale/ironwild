// IRONWILD - HUD overlay (DOM): vitals bars with delayed-damage ghost,
// stamina + focus meters, compass strip, crosshair/bow reticle, ammo and
// resource counters, toasts, interaction prompt, hit markers, low-hp vignette.
// v2: hit-direction arc around the crosshair, kill banner, kill-streak popup,
// low-hp desaturation ramp, static cinematic vignette + film grain, arrow-type
// tag next to the ammo counter.
// v3: slim XP bar pinned directly above the health bar (violet fill, 'LV n'
// badge), pulsing on 'xpGain'.
// v5 (gap 3B): consumes player/bow.js's 'bowState' FSM events as emphasis
// classes on the existing reticle (#iw-xh), and adopts the persisted uiScale
// setting by transform-scaling only the corner-pinned widgets (never the
// fullscreen vignette/grain layers or the screen-center crosshair), via the
// pure computeUiScale() resolver over window.__IW_A11Y / G.settings.
// Pure DOM + inline SVG; polls G each frame with raw dt for UI anims.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { clamp } from '../core/utils.js';
import { getFocusFraction } from './focus.js';

const RAD2DEG = 180 / Math.PI;
const COMPASS_W = 200;            // visible compass window (px)
const COMPASS_FOV = 120;          // degrees visible across the window
const PX_PER_DEG = COMPASS_W / COMPASS_FOV;
const RET_R = 30;                 // bow reticle radius (px)
const RET_C = 2 * Math.PI * RET_R;

// v2 tuning
const HITDIR_TIME = 0.6;          // hit-direction arc fade (s)
const HITDIR_SPAN = 40;           // arc angular span (deg)
const HITDIR_R = 36;              // arc radius inside the 96px svg (px)
const HITDIR_C = 2 * Math.PI * HITDIR_R;
const HITDIR_ARC = HITDIR_C * (HITDIR_SPAN / 360);
const KILL_BANNER_T = 1.4;        // kill banner lifetime (s)
const STREAK_T = 1.3;             // kill-streak popup lifetime (s)
const LOW_HP = 0.35;              // desaturation ramp kicks in below this hp fraction
const DESAT_MAX = 0.85;           // grayscale ceiling at 0 hp
const XP_PULSE_T = 0.45;          // v3 xp-bar pulse duration (s), matches CSS keyframes

// v5 uiScale band - mirrors a11y.js clampNum(G.settings.uiScale, 0.85, 1.3, 1)
// exactly so both consumers of the same setting can never disagree.
const UI_SCALE_MIN = 0.85;
const UI_SCALE_MAX = 1.3;
// Widgets that follow uiScale: [els key, inline transform prefix that preserves
// the stylesheet centering scale() would otherwise override, transform-origin].
// Only corner-pinned clusters are listed: the fullscreen layers (#iw-desat,
// #iw-cine, #iw-grain) must keep covering the viewport, and the screen-center
// widgets (#iw-xh/#iw-hitdir/#iw-hm/#iw-kb/#iw-streak) animate their own inline
// transforms every frame and must stay pixel-centered.
const SCALED_WIDGETS = [
  ['bars', '', 'left bottom'],
  ['ammo', '', 'right bottom'],
  ['res', '', 'right top'],
  ['obj', '', 'left top'],
  ['compass', 'translateX(-50%) ', 'center top'],
  ['toasts', 'translateX(-50%) ', 'center top'],
  ['prompt', 'translateX(-50%) ', 'center bottom'],
];

const CARDINALS = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };

let created = false;
let els = null;
let dotPool = [];

// UI animation state
let hudShown = false;
let ghostF = 1;                   // delayed damage ghost bar (hp fraction)
let sinceHit = 99;                // seconds since last playerHit
let hmTimer = 0;                  // hitmarker flash remaining
let objT = 0;                     // objective hint timer
let objFaded = false;
let releaseFlash = 0;             // reticle kick on arrow release
let xhAiming = false;
let ammoCache = '';
const resCache = {};
const toasts = [];                // { el, t }

// v2 animation state
let hdTimer = -1;                 // hit-direction arc age, -1 = hidden
let kbT = -1;                     // kill banner age, -1 = hidden
let ksT = -1;                     // kill-streak popup age, -1 = hidden
let desatCache = -1;              // applied grayscale quantum
let atypeCache = null;            // arrow-type tag visibility (null = never applied)

// v3 animation state
let xpPulseT = -1;                // xp-bar pulse age, -1 = idle
let xpFracCache = -1;             // applied xp fill percent (one decimal)
let lvCache = '';                 // applied 'LV n' badge text

// v5 animation state
let bowPhase = 'idle';            // mirror of player/bow.js's FSM, fed by 'bowState'
let uiScaleCache = null;          // last scale applied to SCALED_WIDGETS (null = never)

const _v = new THREE.Vector3();     // scratch, reused
const _hdPos = new THREE.Vector3(); // world pos of the last damage source

/**
 * Pure resolver for the effective HUD scale (v5 gap 3B; exported for units).
 * Priority follows the publishing chain: a11y.js's live window.__IW_A11Y
 * snapshot first (it holds the applied value every other consumer shares),
 * then the raw persisted setting, then 1. Non-finite counts as absent - the
 * ?? operator the publishing convention suggests would happily pass NaN/±Inf
 * through and poison style.scale() - and the result is re-clamped to a11y.js's
 * 0.85..1.3 band so a hand-edited save cannot blow up the layout. Kept
 * side-effect-free and DOM-free so it is unit-testable in plain node.
 * @param {{uiScale?:number}|null|undefined} settings G.settings-shaped input
 * @param {{uiScale?:number}|null|undefined} a11y window.__IW_A11Y-shaped input
 * @returns {number} scale clamped to [UI_SCALE_MIN, UI_SCALE_MAX]
 */
export function computeUiScale(settings, a11y) {
  let raw;
  if (a11y && Number.isFinite(a11y.uiScale)) raw = a11y.uiScale;
  else if (settings && Number.isFinite(settings.uiScale)) raw = settings.uiScale;
  else raw = 1;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, raw));
}

export function createHUD() {
  if (created) return;
  created = true;
  injectStyles();
  buildDom();
  bus.on('notify', spawnToast);
  bus.on('prompt', onPrompt);
  bus.on('hitMarker', onHitMarker);
  bus.on('playerHit', onPlayerHit);
  bus.on('arrowFired', () => { releaseFlash = 0.16; });
  bus.on('machineDied', onMachineDied);
  bus.on('killStreak', onKillStreak);
  bus.on('xpGain', onXpGain);
  // v5 gap 3B consumers: bow draw-state reticle emphasis + uiScale adoption.
  bus.on('bowState', onBowState);
  // settingsChanged gives instant feedback even while the frame loop is paused;
  // a11y.js republishes __IW_A11Y from its own listener, and because main.js
  // boots createHUD before createA11y our handler runs first - so instead of
  // racing it we re-read whatever is published now and let the per-frame guard
  // in updateHUD settle any ordering skew on the next tick.
  bus.on('settingsChanged', ({ key } = {}) => {
    if (key === 'uiScale') refreshUiScale();
  });
  refreshUiScale(); // persisted scale may already be in G.settings at boot
}

export function updateHUD(dt) {
  if (!created || !els) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;

  const show = !!G.started;
  if (show !== hudShown) {
    hudShown = show;
    els.root.classList.toggle('show', show);
  }

  // v5 uiScale guard: costs one pure clamp per frame and self-heals any
  // listener-ordering skew between our settingsChanged handler and a11y.js's
  // __IW_A11Y republish (createHUD boots before createA11y in main.js).
  refreshUiScale();

  // toast aging (raw dt)
  for (let i = toasts.length - 1; i >= 0; i--) {
    const t = toasts[i];
    t.t += dt;
    if (t.t >= 2.8) {
      t.el.remove();
      toasts.splice(i, 1);
    } else if (t.t > 2.3) {
      t.el.style.opacity = String(1 - (t.t - 2.3) / 0.5);
    }
  }

  // hitmarker decay
  if (hmTimer > 0) {
    hmTimer -= dt;
    els.hm.style.opacity = String(Math.max(0, hmTimer / 0.12));
  }

  // v2 popups (independent of player vitals)
  updateKillBanner(dt);
  updateStreak(dt);
  updateHitDir(dt);

  // v3 xp-bar pulse decay
  if (xpPulseT >= 0) {
    xpPulseT += dt;
    if (xpPulseT >= XP_PULSE_T) {
      xpPulseT = -1;
      els.xpBar.classList.remove('pulse');
    }
  }

  // objective hint fades after 20s of play
  if (G.started && !objFaded) {
    objT += dt;
    if (objT > 20) {
      objFaded = true;
      els.obj.classList.add('fade');
    }
  }

  // v3 xp bar: polled fill + level badge like the other meters
  const xp = G.xp;
  const frac = xp && xp.next > 0 ? clamp(xp.cur / xp.next, 0, 1) : 0;
  const fpct = Math.round(frac * 1000) / 10;
  if (fpct !== xpFracCache) {
    xpFracCache = fpct;
    els.xpFill.style.width = fpct.toFixed(1) + '%';
  }
  const lvTxt = 'LV ' + (xp && xp.level ? xp.level : 1);
  if (lvTxt !== lvCache) {
    lvCache = lvTxt;
    els.xpLv.textContent = lvTxt;
  }

  const p = G.player;
  if (!p || !p.maxHp) return;

  // vitals
  const hpF = clamp(p.hp / p.maxHp, 0, 1);
  sinceHit += dt;
  if (hpF >= ghostF) {
    ghostF = hpF;
  } else if (sinceHit > 0.45) {
    ghostF = Math.max(hpF, ghostF - dt * 0.4); // ghost bleeds down after a beat
  }
  els.hpFill.style.width = (hpF * 100).toFixed(1) + '%';
  els.hpGhost.style.width = (ghostF * 100).toFixed(1) + '%';
  els.stFill.style.width = (clamp(p.stamina / p.maxStamina, 0, 1) * 100).toFixed(1) + '%';
  els.foFill.style.width = (getFocusFraction() * 100).toFixed(1) + '%';
  els.vig.classList.toggle('on', hpF < 0.3);

  // low-hp desaturation ramp (backdrop grayscale below LOW_HP)
  const dg = hpF < LOW_HP ? ((LOW_HP - hpF) / LOW_HP) * DESAT_MAX : 0;
  const dq = Math.round(dg * 100) / 100;
  if (dq !== desatCache) {
    desatCache = dq;
    const val = dq > 0 ? `grayscale(${dq})` : 'none';
    els.desat.style.backdropFilter = val;
    els.desat.style.webkitBackdropFilter = val; // Safari
  }

  // ammo + arrow type tag
  const inv = G.inventory;
  const ammoTxt = `${inv.arrows} / ${inv.maxArrows}`;
  if (ammoTxt !== ammoCache) {
    ammoCache = ammoTxt;
    els.ammoText.textContent = ammoTxt;
    els.ammo.classList.toggle('empty', inv.arrows <= 0);
  }
  const fire = G.arrowType === 'fire';
  if (fire !== atypeCache) {
    atypeCache = fire;
    els.atype.style.display = fire ? 'inline-block' : 'none';
  }

  // resources
  setRes('wood', inv.wood);
  setRes('shards', inv.shards);
  setRes('oil', inv.oil);
  setRes('medicine', inv.medicine);
  setRes('hide', inv.hide);

  // compass: yaw=0 faces north (-Z); heading degrees clockwise from north
  const heading = ((-G.cam.yaw * RAD2DEG) % 360 + 360) % 360;
  els.strip.style.transform =
    `translateX(${(COMPASS_W / 2 - (heading + 90) * PX_PER_DEG).toFixed(2)}px)`;
  updateDots(heading);

  // crosshair / bow reticle
  const aiming = !!G.cam.aiming;
  if (aiming !== xhAiming) {
    xhAiming = aiming;
    els.xh.classList.toggle('aiming', aiming);
  }
  const drawT = typeof p.drawT === 'number' ? clamp(p.drawT, 0, 1) : 0;
  els.retArc.style.strokeDashoffset = String(RET_C * (1 - drawT));
  if (releaseFlash > 0) {
    releaseFlash -= dt;
    const s = 1 + Math.max(0, releaseFlash) * 1.4;
    els.ret.style.transform = `scale(${s.toFixed(3)})`;
  } else if (els.ret.style.transform) {
    els.ret.style.transform = '';
  }
}

// ---------------------------------------------------------------- internals

function setRes(type, value) {
  if (resCache[type] === value) return;
  resCache[type] = value;
  els.resCounts[type].textContent = String(value);
}

function updateDots(heading) {
  let di = 0;
  const pp = G.player && G.player.pos ? G.player.pos : null;
  if (pp) {
    for (let i = 0; i < G.machines.length && di < dotPool.length; i++) {
      const m = G.machines[i];
      if (!m || !m.alive || !m.aggro || !m.group) continue;
      _v.subVectors(m.group.position, pp);
      const bearing = Math.atan2(_v.x, -_v.z) * RAD2DEG;
      let rel = bearing - heading;
      rel = ((rel + 540) % 360) - 180; // wrap to [-180,180]
      const d = dotPool[di++];
      d.style.display = 'block';
      d.style.left = clamp(COMPASS_W / 2 + rel * PX_PER_DEG, 6, COMPASS_W - 6) + 'px';
    }
  }
  for (; di < dotPool.length; di++) dotPool[di].style.display = 'none';
}

function spawnToast(n) {
  const tone = n && (n.tone === 'good' || n.tone === 'bad') ? n.tone : 'info';
  const div = document.createElement('div');
  div.className = `iw-toast ${tone}`;
  div.textContent = String((n && n.text) || '');
  els.toasts.appendChild(div);
  if (toasts.length >= 5) {
    const old = toasts.shift();
    old.el.remove();
  }
  toasts.push({ el: div, t: 0 });
}

function onPrompt(p) {
  if (!els.prompt) return;
  if (p && p.text) {
    els.prompt.textContent = String(p.text);
    els.prompt.style.display = 'block';
  } else {
    els.prompt.style.display = 'none';
  }
}

function onHitMarker(h) {
  hmTimer = 0.12;
  els.hm.classList.toggle('weak', !!(h && h.weak));
}

/** playerHit: keep the ghost-bar beat, aim the direction arc at the source. */
function onPlayerHit(h) {
  sinceHit = 0;
  if (h && h.pos && typeof h.pos.x === 'number') {
    _hdPos.set(h.pos.x, h.pos.y || 0, h.pos.z);
    hdTimer = 0;
  }
}

function onMachineDied(d) {
  const m = d && d.machine;
  const nm = String((m && (m.name || m.type)) || 'MACHINE').toUpperCase();
  els.kb.textContent = `${nm} DOWN`;
  kbT = 0;
}

function onKillStreak(k) {
  const n = Math.max(2, Math.floor((k && k.count) || 2));
  els.streak.textContent = `×${n}`;
  els.streak.classList.toggle('t4', n >= 4);
  els.streak.classList.toggle('t6', n >= 6);
  ksT = 0;
}

/** v3: flash the xp bar on any gain (systems/xp.js emits 'xpGain'). */
function onXpGain() {
  els.xpBar.classList.remove('pulse');
  void els.xpBar.offsetWidth; // force reflow so rapid gains restart the animation
  els.xpBar.classList.add('pulse');
  xpPulseT = 0;
}

/**
 * v5 gap 3B 'bowState' consumer (player/bow.js emits {state,power} on every FSM
 * transition). Maps the state onto emphasis classes of the EXISTING reticle:
 * the arc fill itself stays polled from p.drawT in updateHUD because power
 * advances continuously while bowState only fires on transitions. Invalid or
 * malformed payloads keep the last known phase - a bad event must never blank
 * or corrupt the crosshair. Classes are static (no keyframes), so users with
 * reduceFlashing get no additional motion.
 */
function onBowState(b) {
  const s = b && typeof b.state === 'string' ? b.state : null;
  if (s !== 'idle' && s !== 'drawing' && s !== 'full' && s !== 'release') return;
  if (s === bowPhase) return; // bus may repeat a state; classList churn is waste
  bowPhase = s;
  els.xh.classList.toggle('drawing', s === 'drawing');
  els.xh.classList.toggle('full', s === 'full');
  els.xh.classList.toggle('release', s === 'release');
}

/**
 * v5 uiScale adoption: re-resolve the effective scale and restyle the pinned
 * widgets only on change (the cache keeps the per-frame call trivial). At
 * scale 1 inline transforms are cleared entirely, leaving the stylesheet -
 * and therefore the pre-campaign look - byte-identical. Centering prefixes
 * come from SCALED_WIDGETS because an inline transform would otherwise
 * override the stylesheet translateX(-50%) that keeps those widgets centered.
 * minimap.js anchors on #iw-res's getBoundingClientRect(), which reflects
 * transforms, so the scaled readout drags the minimap along for free.
 */
function refreshUiScale() {
  if (!els) return;
  const snap = typeof window === 'undefined' ? null : window.__IW_A11Y;
  const s = computeUiScale(G.settings, snap);
  if (s === uiScaleCache) return;
  uiScaleCache = s;
  for (const [key, prefix] of SCALED_WIDGETS) {
    els[key].style.transform = s === 1 ? '' : `${prefix}scale(${s})`;
  }
}

/** Thin red arc around the crosshair pointing at the last damage source. */
function updateHitDir(dt) {
  if (hdTimer < 0) return;
  hdTimer += dt;
  if (hdTimer >= HITDIR_TIME) {
    hdTimer = -1;
    els.hitdir.style.opacity = '0';
    return;
  }
  const p = G.player;
  if (p && p.pos) {
    const dx = _hdPos.x - p.pos.x;
    const dz = _hdPos.z - p.pos.z;
    if (dx * dx + dz * dz > 1e-6) {
      const bearing = Math.atan2(dx, -dz) * RAD2DEG;
      const heading = ((-G.cam.yaw * RAD2DEG) % 360 + 360) % 360;
      const rel = ((bearing - heading + 540) % 360) - 180;
      // svg circle stroke starts at 3 o'clock: rotate so the span centers on rel
      els.hdSvg.style.transform = `rotate(${(rel - 90 - HITDIR_SPAN / 2).toFixed(1)}deg)`;
    }
  }
  els.hitdir.style.opacity = (1 - hdTimer / HITDIR_TIME).toFixed(3);
}

function updateKillBanner(dt) {
  if (kbT < 0) return;
  kbT += dt;
  if (kbT >= KILL_BANNER_T) {
    kbT = -1;
    els.kb.style.opacity = '0';
    return;
  }
  let o;
  if (kbT < 0.12) o = kbT / 0.12;
  else if (kbT > KILL_BANNER_T - 0.45) o = (KILL_BANNER_T - kbT) / 0.45;
  else o = 1;
  els.kb.style.opacity = o.toFixed(3);
  const s = 1 + Math.max(0, 0.12 - kbT) * 0.8; // settle-in pop
  els.kb.style.transform = `translateX(-50%) scale(${s.toFixed(3)})`;
}

function updateStreak(dt) {
  if (ksT < 0) return;
  ksT += dt;
  if (ksT >= STREAK_T) {
    ksT = -1;
    els.streak.style.opacity = '0';
    return;
  }
  let o;
  if (ksT < 0.1) o = ksT / 0.1;
  else if (ksT > STREAK_T - 0.35) o = (STREAK_T - ksT) / 0.35;
  else o = 1;
  els.streak.style.opacity = o.toFixed(3);
  const s = 1 + Math.max(0, 0.18 - ksT) * 2.2; // punch-in pop
  els.streak.style.transform = `translate(-50%,-50%) scale(${s.toFixed(3)})`;
}

function div(cls, parent) {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
}

function buildDom() {
  const root = document.createElement('div');
  root.id = 'iw-hud';
  document.body.appendChild(root);

  // fullscreen overlays first so they paint behind every HUD widget:
  // low-hp desaturation, static cinematic vignette, film grain
  const desat = div('', root); desat.id = 'iw-desat';
  div('', root).id = 'iw-cine';
  div('', root).id = 'iw-grain';

  // vitals cluster, bottom-left
  const bars = div('', root);
  bars.id = 'iw-bars';
  // v3 xp bar first so it sits directly above the health bar
  const xpRow = div('', bars); xpRow.id = 'iw-xprow';
  const xpBar = div('iw-bar', xpRow); xpBar.id = 'iw-xpbar';
  const xpFill = div('iw-fill', xpBar); xpFill.id = 'iw-xpfill';
  const xpLv = document.createElement('span');
  xpLv.className = 'iw-xplv';
  xpLv.textContent = 'LV 1';
  xpBar.appendChild(xpLv);
  const hpBar = div('iw-bar', bars); hpBar.id = 'iw-hpbar';
  const hpGhost = div('iw-fill', hpBar); hpGhost.id = 'iw-hpghost';
  const hpFill = div('iw-fill', hpBar); hpFill.id = 'iw-hpfill';
  const stBar = div('iw-bar', bars); stBar.id = 'iw-stbar';
  const stFill = div('iw-fill', stBar); stFill.id = 'iw-stfill';
  const foBar = div('iw-bar', bars); foBar.id = 'iw-fobar';
  const foFill = div('iw-fill', foBar); foFill.id = 'iw-fofill';

  // ammo, bottom-right (+ v2 arrow-type tag)
  const ammo = div('', root); ammo.id = 'iw-ammo';
  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = '➶';
  const ammoText = document.createElement('span');
  ammoText.textContent = '0 / 0';
  const atype = document.createElement('span');
  atype.id = 'iw-atype';
  atype.textContent = 'FIRE';
  ammo.appendChild(glyph);
  ammo.appendChild(ammoText);
  ammo.appendChild(atype);

  // resource counters, top-right
  const res = div('', root); res.id = 'iw-res';
  const resCounts = {};
  for (const [type, label, color] of [
    ['wood', 'WOOD', '#6b4a2f'],
    ['shards', 'SHARDS', '#59e3ff'],
    ['oil', 'OIL', '#8a4b32'],
    ['medicine', 'MEDICINE', '#e06a5a'],
    ['hide', 'HIDE', '#b98a5e'],
  ]) {
    const row = div('iw-resrow', res);
    const name = document.createElement('span');
    name.className = 'iw-resname';
    name.textContent = label;
    const count = document.createElement('span');
    count.className = 'iw-rescount';
    count.textContent = '0';
    const sw = document.createElement('span');
    sw.className = 'iw-sw';
    sw.style.background = color;
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(sw);
    resCounts[type] = count;
  }

  // compass, top-center
  const compass = div('', root); compass.id = 'iw-compass';
  const strip = div('', compass); strip.id = 'iw-strip';
  for (let d = -90; d <= 450; d += 15) {
    const dd = ((d % 360) + 360) % 360;
    const x = (d + 90) * PX_PER_DEG;
    div('iw-tick', strip).style.left = x + 'px';
    if (dd % 45 === 0) {
      const lab = div(dd % 90 === 0 ? 'iw-card' : 'iw-card iw-subcard', strip);
      lab.style.left = x + 'px';
      lab.textContent = CARDINALS[dd];
    }
  }
  const notch = div('', compass); notch.id = 'iw-notch';
  const dotContainer = div('', compass); dotContainer.id = 'iw-dots';
  for (let i = 0; i < CONFIG.maxMachines; i++) {
    const d = div('iw-dot', dotContainer);
    d.style.display = 'none';
    dotPool.push(d);
  }

  // crosshair + bow reticle, center
  const xh = div('', root); xh.id = 'iw-xh';
  const xhdot = div('', xh); xhdot.id = 'iw-xhdot';
  const ret = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ret.id = 'iw-ret';
  ret.setAttribute('width', '72');
  ret.setAttribute('height', '72');
  ret.setAttribute('viewBox', '0 0 72 72');
  ret.innerHTML =
    `<circle cx="36" cy="36" r="${RET_R}" class="iw-retbg"/>` +
    `<circle cx="36" cy="36" r="${RET_R}" class="iw-retarc" id="iw-retarc"/>` +
    `<line x1="36" y1="1" x2="36" y2="10" class="iw-retick"/>`;
  xh.appendChild(ret);

  // hit-direction arc, center (rotates toward the damage source)
  const hitdir = div('', root); hitdir.id = 'iw-hitdir';
  const hdSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  hdSvg.setAttribute('width', '96');
  hdSvg.setAttribute('height', '96');
  hdSvg.setAttribute('viewBox', '0 0 96 96');
  const hdArc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hdArc.setAttribute('cx', '48');
  hdArc.setAttribute('cy', '48');
  hdArc.setAttribute('r', String(HITDIR_R));
  hdArc.setAttribute('class', 'iw-hdarc');
  hdArc.setAttribute('stroke-dasharray', `${HITDIR_ARC.toFixed(2)} ${HITDIR_C.toFixed(2)}`);
  hdSvg.appendChild(hdArc);
  hitdir.appendChild(hdSvg);

  // hitmarker, center
  const hm = div('', root); hm.id = 'iw-hm';
  for (const ang of [45, 135, 225, 315]) {
    const line = div('iw-hmline', hm);
    line.style.transform = `translate(-50%,-50%) rotate(${ang}deg) translateY(-8px)`;
  }

  // kill banner + kill-streak popup, center-screen
  const kb = div('', root); kb.id = 'iw-kb';
  const streak = div('', root); streak.id = 'iw-streak';

  // toasts under the compass
  const toastsEl = div('', root); toastsEl.id = 'iw-toasts';

  // interaction prompt, bottom-center
  const prompt = div('', root); prompt.id = 'iw-prompt';

  // damage vignette + objective hint
  const vig = div('', root); vig.id = 'iw-vig';
  const obj = div('', root); obj.id = 'iw-obj';
  obj.textContent = 'Hunt machines • Gather resources';

  els = {
    root, hpFill, hpGhost, stFill, foFill, ammo, ammoText, atype, resCounts,
    strip, xh, ret, retArc: ret.querySelector('#iw-retarc'),
    hm, toasts: toastsEl, prompt, vig, obj,
    desat, hitdir, hdSvg, kb, streak,
    xpBar, xpFill, xpLv,
    // v5: widgets scaled by refreshUiScale must be reachable here -
    // SCALED_WIDGETS iterates these keys (boot crashed when bars/res/compass
    // were only locals).
    bars, res, compass,
  };

  // v5: anchor each scalable widget at the corner it is pinned to so
  // refreshUiScale's scale() grows it inward/outward from its own anchor
  // instead of drifting across the screen.
  for (const [key, , origin] of SCALED_WIDGETS) els[key].style.transformOrigin = origin;
}

function injectStyles() {
  if (document.getElementById('iw-hud-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-hud-style';
  st.textContent = `
#iw-hud{position:fixed;inset:0;z-index:20;pointer-events:none;
  font-family:'Segoe UI',system-ui,sans-serif;color:#dfe7ea;
  opacity:0;transition:opacity .5s;}
#iw-hud.show{opacity:1;}

/* v2 cinematic layers: desaturation ramp, static vignette, film grain */
#iw-desat{position:absolute;inset:0;}
#iw-cine{position:absolute;inset:0;
  background:radial-gradient(ellipse at center,transparent 58%,rgba(4,8,12,.30) 100%);}
#iw-grain{position:absolute;inset:-40px;opacity:.05;background-size:180px 180px;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0.6 0.6 0.6 0 0'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
  animation:iwgrain .7s steps(5) infinite;}
@keyframes iwgrain{
  0%{transform:translate(0,0);}20%{transform:translate(-14px,8px);}
  40%{transform:translate(10px,-12px);}60%{transform:translate(-6px,-16px);}
  80%{transform:translate(12px,10px);}100%{transform:translate(0,0);}}

#iw-bars{position:absolute;left:22px;bottom:22px;display:flex;flex-direction:column;gap:5px;}
.iw-bar{position:relative;background:rgba(8,12,16,.62);border:1px solid rgba(255,255,255,.15);}
#iw-hpbar{width:250px;height:15px;}
#iw-stbar{width:250px;height:6px;}
#iw-fobar{width:250px;height:4px;}
.iw-fill{position:absolute;left:0;top:0;bottom:0;width:100%;}
#iw-hpghost{background:rgba(255,214,214,.5);}
#iw-hpfill{background:#7e2f2f;}
#iw-stfill{background:#d8a03a;}
#iw-fofill{background:#59e3ff;}

/* v3 xp bar: slim violet meter directly above the health bar */
#iw-xpbar{width:250px;height:10px;}
#iw-xpfill{background:#b48cff;}
.iw-xplv{position:absolute;left:5px;top:50%;transform:translateY(-50%);z-index:2;
  font-size:8px;font-weight:700;letter-spacing:1px;color:#e9ddff;line-height:1;
  text-shadow:0 1px 2px rgba(0,0,0,.9);pointer-events:none;}
#iw-xpbar.pulse{animation:iwxppulse ${XP_PULSE_T}s ease-out;}
@keyframes iwxppulse{
  0%{box-shadow:0 0 0 rgba(180,140,255,0);}
  25%{box-shadow:0 0 12px rgba(180,140,255,.85);border-color:rgba(180,140,255,.8);}
  100%{box-shadow:0 0 0 rgba(180,140,255,0);}}

#iw-ammo{position:absolute;right:22px;bottom:22px;font-size:20px;letter-spacing:1px;
  text-shadow:0 1px 3px rgba(0,0,0,.8);}
#iw-ammo .glyph{color:#59e3ff;margin-right:7px;font-size:22px;}
#iw-ammo.empty{color:#ff8f7a;}
#iw-atype{display:none;margin-left:10px;padding:1px 7px;font-size:11px;font-weight:700;
  letter-spacing:2px;color:#ff8c42;border:1px solid rgba(255,140,66,.55);
  background:rgba(40,20,8,.55);vertical-align:3px;}

#iw-res{position:absolute;top:16px;right:18px;display:flex;flex-direction:column;gap:4px;
  font-size:12px;letter-spacing:.5px;text-shadow:0 1px 2px rgba(0,0,0,.8);}
.iw-resrow{display:flex;align-items:center;justify-content:flex-end;gap:7px;}
.iw-resname{color:rgba(223,231,234,.75);}
.iw-rescount{min-width:18px;text-align:right;font-weight:600;}
.iw-sw{width:10px;height:10px;border:1px solid rgba(255,255,255,.25);}

#iw-compass{position:absolute;top:14px;left:50%;transform:translateX(-50%);
  width:${COMPASS_W}px;height:30px;overflow:hidden;background:rgba(8,12,16,.45);
  border:1px solid rgba(255,255,255,.15);}
#iw-strip{position:absolute;top:0;left:0;height:100%;will-change:transform;}
.iw-tick{position:absolute;bottom:4px;width:1px;height:6px;background:rgba(255,255,255,.4);}
.iw-card{position:absolute;top:2px;transform:translateX(-50%);font-size:12px;
  font-weight:600;letter-spacing:1px;color:#eef6f8;}
.iw-subcard{font-size:9px;top:5px;color:rgba(230,240,245,.55);font-weight:400;}
#iw-notch{position:absolute;left:50%;top:0;width:2px;height:100%;
  transform:translateX(-50%);background:#59e3ff;opacity:.85;}
.iw-dot{position:absolute;bottom:5px;width:6px;height:6px;border-radius:50%;
  background:#ff4d3d;box-shadow:0 0 5px #ff4d3d;transform:translateX(-50%);}

#iw-xh{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:72px;height:72px;}
#iw-xhdot{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;
  border-radius:50%;background:#eef6f8;box-shadow:0 0 4px rgba(0,0,0,.7);
  transition:transform .12s;}
#iw-ret{position:absolute;inset:0;opacity:0;transition:opacity .12s;}
#iw-xh.aiming #iw-ret{opacity:1;}
#iw-xh.aiming #iw-xhdot{transform:scale(.55);}
.iw-retbg{fill:none;stroke:rgba(255,255,255,.22);stroke-width:2;}
.iw-retarc{fill:none;stroke:#59e3ff;stroke-width:3;stroke-linecap:round;
  stroke-dasharray:${RET_C.toFixed(1)};stroke-dashoffset:${RET_C.toFixed(1)};
  transform:rotate(-90deg);transform-origin:36px 36px;}
.iw-retick{stroke:#59e3ff;stroke-width:2;}

/* v5 gap 3B: 'bowState' emphasis classes on #iw-xh, driven by hud.js's bus
   consumer. Static styles only - no keyframes - so reduceFlashing gains no
   extra motion; high-contrast mode swaps the hue cue for a thicker achromatic
   outline per the a11y publishing contract. */
#iw-xh.drawing .iw-retick{stroke:#aef0ff;}
#iw-xh.full .iw-retarc{stroke:#8ff2ff;}
#iw-xh.full .iw-retick{stroke:#ffffff;}
#iw-xh.release .iw-retarc{stroke:#d7fbff;}
body.iw-high-contrast #iw-xh.drawing .iw-retarc,
body.iw-high-contrast #iw-xh.full .iw-retarc{stroke:#ffffff;stroke-width:5;}
body.iw-high-contrast #iw-xh.full .iw-retbg{stroke:rgba(255,255,255,.55);}

/* v2 hit-direction arc around the crosshair */
#iw-hitdir{position:absolute;left:50%;top:50%;width:96px;height:96px;
  transform:translate(-50%,-50%);opacity:0;}
#iw-hitdir svg{display:block;will-change:transform;}
.iw-hdarc{fill:none;stroke:#ff5a45;stroke-width:3;stroke-linecap:round;
  filter:drop-shadow(0 0 4px rgba(255,90,69,.7));}

#iw-hm{position:absolute;left:50%;top:50%;width:26px;height:26px;
  transform:translate(-50%,-50%);opacity:0;}
.iw-hmline{position:absolute;left:50%;top:50%;width:2px;height:11px;background:#eef6f8;
  box-shadow:0 0 4px rgba(0,0,0,.8);}
#iw-hm.weak .iw-hmline{background:#59e3ff;}

/* v2 kill banner + kill-streak popup */
#iw-kb{position:absolute;left:50%;top:34%;transform:translateX(-50%);
  font-size:30px;font-weight:700;letter-spacing:6px;color:#ffe9c9;white-space:nowrap;
  text-shadow:0 2px 10px rgba(0,0,0,.85),0 0 24px rgba(255,120,60,.35);opacity:0;}
#iw-streak{position:absolute;left:50%;top:58%;font-size:26px;font-weight:800;
  font-style:italic;color:#ffb03a;opacity:0;transform:translate(-50%,-50%);
  text-shadow:0 0 14px rgba(255,150,50,.55),0 2px 6px rgba(0,0,0,.8);}
#iw-streak.t4{color:#ff7a3d;}
#iw-streak.t6{color:#ff4d3d;
  text-shadow:0 0 18px rgba(255,70,50,.65),0 2px 6px rgba(0,0,0,.8);}

#iw-toasts{position:absolute;top:56px;left:50%;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:5px;}
.iw-toast{background:rgba(8,12,16,.78);border:1px solid rgba(255,255,255,.15);
  border-left:3px solid #9fb4bd;padding:5px 14px;font-size:13px;letter-spacing:.4px;
  white-space:nowrap;}
.iw-toast.info{border-left-color:#59e3ff;}
.iw-toast.good{border-left-color:#7ed67e;color:#cfeeda;}
.iw-toast.bad{border-left-color:#ff6b5e;color:#ffd9d2;}

#iw-prompt{position:absolute;left:50%;bottom:118px;transform:translateX(-50%);
  background:rgba(8,12,16,.72);border:1px solid rgba(255,255,255,.15);
  padding:6px 16px;font-size:14px;letter-spacing:.5px;display:none;white-space:nowrap;}

#iw-vig{position:absolute;inset:0;opacity:0;
  background:radial-gradient(ellipse at center,transparent 52%,rgba(160,20,20,.55) 100%);}
#iw-vig.on{animation:iwvig 1.15s ease-in-out infinite;}
@keyframes iwvig{0%,100%{opacity:.25;}50%{opacity:.85;}}

#iw-obj{position:absolute;top:16px;left:20px;font-size:12px;letter-spacing:1.5px;
  text-transform:uppercase;color:rgba(230,240,245,.75);transition:opacity 2.5s;}
#iw-obj.fade{opacity:0;}
`;
  document.head.appendChild(st);
}
