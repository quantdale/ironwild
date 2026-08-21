// IRONWILD - focus scan (hold Q): slows world time, draws cyan edge outlines
// over machines, floating weak-point labels and diamond markers on nearby
// pickups. Owns G.timeScale while active; restores it to 1 on deactivate.
// v2: on release the outlines/labels persist as faint "tags" for 8 s per
// machine (depthTest off, visible through walls), then fade out; scanning a
// Vantage emits 'machineScanned' (per-machine cooldown).

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { clamp } from '../core/utils.js';

const REGEN_RATE = 0.14;        // fraction per second
const REGEN_DELAY = 1.2;        // seconds before regen starts after scanning
const MIN_ACTIVATE = 0.05;      // need at least this much meter to start a scan
const PICKUP_RANGE_SQ = 40 * 40;
const MAX_MARKERS = 24;

// v2 tag persistence + vantage scanning
const TAG_HOLD = 8;             // seconds a tag stays after Q is released
const TAG_FADE = 1.0;           // fade-out duration at the end of the hold
const TAG_EDGE_OP = 0.38;       // faint outline opacity while tagged
const TAG_LABEL_OP = 0.55;      // faint label opacity while tagged
const VANTAGE_RANGE_SQ = 50 * 50; // must be this close to scan a Vantage
const VANTAGE_RESCAN_CD = 15;   // seconds before the same Vantage re-emits

let created = false;
let scanning = false;
let fraction = 1;
let regenDelay = 0;

let overlayRoot = null;
let edgeMat = null;
const entries = [];             // { machine, wrap, labels:[{spr,wp}] }
let markerPool = [];            // persistent diamond sprites (shared material)
let markerMat = null;
let diamondTex = null;

// v2 persistent tag layer
let tagRoot = null;             // scene child holding all live tags
const tags = [];                // { machine, wrap, labels, mat, t }

// v2 per-machine scan cooldowns. machine._scanCd (number, seconds remaining)
// is respected when present; otherwise a local Map keeps the timer.
const scanCdFallback = new Map(); // machine -> seconds remaining
const cdOwned = [];               // machines whose _scanCd we tick down

let hintEl = null;
let hintShown = false;

// scratch objects - reused every frame, never reallocated
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

export function createFocus() {
  if (created) return;
  created = true;
  injectStyles();
  hintEl = document.createElement('div');
  hintEl.id = 'iw-focus-hint';
  hintEl.textContent = '[Q] FOCUS';
  document.body.appendChild(hintEl);
  ensureTagRoot();
}

/** Current focus meter in [0,1]. Read by the HUD focus bar. */
export function getFocusFraction() {
  return clamp(fraction, 0, 1);
}

export function updateFocus(dt) {
  if (!created) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;
  ensureTagRoot();

  const can = G.started && !G.paused && !G.gameOver && G.player && !G.player.dead;

  if (scanning) {
    // Edge case: pause/gameOver/death mid-scan or key released -> force off.
    if (!can || !Input.down('KeyQ')) {
      deactivate();
    } else {
      fraction -= dt / (CONFIG.focusDuration * (G.skills.deepFocus ? 1.5 : 1));
      if (fraction <= 0) {
        fraction = 0;
        deactivate();
      } else {
        syncOverlays();
        checkVantageScan();
      }
    }
  } else {
    if (can && Input.down('KeyQ') && fraction > MIN_ACTIVATE) {
      activate();
    } else {
      if (regenDelay > 0) regenDelay -= dt;
      else fraction = Math.min(1, fraction + REGEN_RATE * dt);
    }
  }

  tickScanCds(dt);
  updateTags(dt);

  const show = can && !scanning && fraction > MIN_ACTIVATE;
  if (show !== hintShown) {
    hintShown = show;
    hintEl.classList.toggle('show', show);
  }
}

// ---------------------------------------------------------------- internals

function activate() {
  scanning = true;
  G.timeScale = CONFIG.focusTimeScale;
  regenDelay = REGEN_DELAY;
  clearTags(); // fresh bright overlays supersede any lingering tags
  ensureMarkers();

  overlayRoot = new THREE.Group();
  G.scene.add(overlayRoot);
  edgeMat = new THREE.LineBasicMaterial({
    color: 0x59e3ff, transparent: true, opacity: 0.9, depthTest: false,
  });

  // Build overlays ONCE per activation: edge lines per mesh + weak-point labels.
  for (const m of G.machines) {
    if (!m || !m.group) continue;
    const wrap = new THREE.Group();
    const labels = [];

    // Local transform of each mesh relative to the machine root (exact even
    // for nested groups), baked once so per-frame sync is just copy().
    _m1.copy(m.group.matrixWorld).invert();
    m.group.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      let eg;
      try { eg = new THREE.EdgesGeometry(o.geometry, 1); } catch (err) { return; }
      _m2.multiplyMatrices(_m1, o.matrixWorld);
      _m2.decompose(_p, _q, _s);
      const ls = new THREE.LineSegments(eg, edgeMat);
      ls.position.copy(_p);
      ls.quaternion.copy(_q);
      ls.scale.copy(_s);
      ls.renderOrder = 999;
      wrap.add(ls);
    });

    if (Array.isArray(m.weakPoints)) {
      for (const wp of m.weakPoints) {
        if (!wp || wp.broken || !wp.mesh) continue;
        const mult = typeof wp.multiplier === 'number' ? wp.multiplier : 2;
        const spr = makeLabelSprite(`${String(wp.name || 'WEAK').toUpperCase()} ×${mult}`);
        spr.visible = false;
        overlayRoot.add(spr); // scene-space; positioned each frame from world pos
        labels.push({ spr, wp });
      }
    }

    wrap.visible = m.alive !== false;
    overlayRoot.add(wrap);
    entries.push({ machine: m, wrap, labels });
  }

  for (const s of markerPool) overlayRoot.add(s);
  syncOverlays();
  checkVantageScan(); // same-frame Vantage detection on scan start
  bus.emit('ui', { action: 'focusOn' });
}

function deactivate() {
  if (!scanning) return;
  scanning = false;
  G.timeScale = 1;
  regenDelay = REGEN_DELAY;

  if (overlayRoot) {
    // Hand each machine's overlay to the faint tag layer (8 s hold, then fade).
    for (const e of entries) adoptTag(e.machine, e.wrap, e.labels);
    entries.length = 0;
    // Wraps/labels were reparented out; only the scratch root goes away.
    // Edge geometries stay alive inside the tags and are disposed on expiry.
    G.scene.remove(overlayRoot);
    overlayRoot = null;
    if (edgeMat) { edgeMat.dispose(); edgeMat = null; }
  }
  bus.emit('ui', { action: 'focusOff' });
}

// ------------------------------------------------------- v2: tag persistence

function ensureTagRoot() {
  if (tagRoot || !G.scene) return;
  tagRoot = new THREE.Group();
  tagRoot.name = 'iw-focus-tags';
  G.scene.add(tagRoot);
}

/** Move a scanned machine's overlay into the faint tag layer with a fresh 8 s. */
function adoptTag(machine, wrap, labels) {
  if (!tagRoot) return;
  dropTag(machine); // re-scanned machine: replace old tag so the timer refreshes
  if (!wrap) return;
  const mat = new THREE.LineBasicMaterial({
    color: 0x59e3ff, transparent: true, opacity: TAG_EDGE_OP, depthTest: false,
  });
  wrap.traverse((o) => { if (o.isLineSegments) o.material = mat; });
  for (const l of labels) {
    l.spr.material.opacity = TAG_LABEL_OP;
    tagRoot.add(l.spr);
  }
  tagRoot.add(wrap);
  tags.push({ machine, wrap, labels, mat, t: TAG_HOLD });
}

function dropTag(machine) {
  for (let i = tags.length - 1; i >= 0; i--) {
    if (tags[i].machine === machine) {
      disposeTag(tags[i]);
      tags.splice(i, 1);
    }
  }
}

function disposeTag(tag) {
  tag.wrap.removeFromParent();
  tag.wrap.traverse((o) => {
    if (o.isLineSegments && o.geometry) o.geometry.dispose();
  });
  for (const l of tag.labels) {
    l.spr.removeFromParent();
    if (l.spr.material.map) l.spr.material.map.dispose();
    l.spr.material.dispose();
  }
  tag.mat.dispose();
}

function clearTags() {
  for (const t of tags) disposeTag(t);
  tags.length = 0;
}

/** Per-frame tag upkeep: timers, transform sync, end-of-hold fade. */
function updateTags(dt) {
  for (let i = tags.length - 1; i >= 0; i--) {
    const tg = tags[i];
    tg.t -= dt;
    const m = tg.machine;
    if (tg.t <= 0 || !m || m._disposed) {
      disposeTag(tg);
      tags.splice(i, 1);
      continue;
    }
    const g = m.group;
    const vis = !!g && m.alive !== false;
    tg.wrap.visible = vis;
    if (vis) {
      tg.wrap.position.copy(g.position);
      tg.wrap.quaternion.copy(g.quaternion);
      tg.wrap.scale.copy(g.scale);
    }
    for (const l of tg.labels) {
      if (!l.wp.broken && l.wp.mesh && vis) {
        l.wp.mesh.getWorldPosition(_v);
        l.spr.position.set(_v.x, _v.y + 0.4, _v.z);
        l.spr.visible = true;
      } else {
        l.spr.visible = false;
      }
    }
    // fade out over the last TAG_FADE seconds of the hold
    const f = clamp(tg.t / TAG_FADE, 0, 1);
    tg.mat.opacity = TAG_EDGE_OP * f;
    for (const l of tg.labels) l.spr.material.opacity = TAG_LABEL_OP * f;
  }
}

// --------------------------------------------------- v2: vantage scanning --

function scanOnCooldown(m) {
  if (typeof m._scanCd === 'number') return m._scanCd > 0;
  return (scanCdFallback.get(m) || 0) > 0;
}

function beginScanCd(m) {
  if (typeof m._scanCd === 'number') {
    m._scanCd = VANTAGE_RESCAN_CD;
    if (!cdOwned.includes(m)) cdOwned.push(m);
  } else {
    scanCdFallback.set(m, VANTAGE_RESCAN_CD);
  }
}

function tickScanCds(dt) {
  for (const [m, t] of scanCdFallback) {
    if (!m || m._disposed || t - dt <= 0) scanCdFallback.delete(m);
    else scanCdFallback.set(m, t - dt);
  }
  for (let i = cdOwned.length - 1; i >= 0; i--) {
    const m = cdOwned[i];
    if (!m || m._disposed || typeof m._scanCd !== 'number') {
      cdOwned.splice(i, 1);
      continue;
    }
    if (m._scanCd > 0) m._scanCd = Math.max(0, m._scanCd - dt);
  }
}

/** While scanning: emit machineScanned for in-range Vantages, cooldown-gated. */
function checkVantageScan() {
  const pp = G.player && G.player.pos ? G.player.pos : null;
  if (!pp) return;
  for (const e of entries) {
    const m = e.machine;
    if (!m || m.type !== 'vantage' || m.alive === false || !m.group) continue;
    if (m.group.position.distanceToSquared(pp) > VANTAGE_RANGE_SQ) continue;
    if (scanOnCooldown(m)) continue;
    beginScanCd(m);
    bus.emit('machineScanned', { machine: m });
  }
}

/** Per-frame sync while scanning: transforms + label/marker placement. */
function syncOverlays() {
  for (const e of entries) {
    const g = e.machine.group;
    const vis = !!g && e.machine.alive !== false;
    e.wrap.visible = vis;
    if (vis) {
      e.wrap.position.copy(g.position);
      e.wrap.quaternion.copy(g.quaternion);
      e.wrap.scale.copy(g.scale);
    }
    for (const l of e.labels) {
      if (!l.wp.broken && l.wp.mesh && vis) {
        l.wp.mesh.getWorldPosition(_v);
        l.spr.position.set(_v.x, _v.y + 0.4, _v.z);
        l.spr.visible = true;
      } else {
        l.spr.visible = false;
      }
    }
  }

  // Diamond markers over untaken pickups within 40u of the player.
  let mi = 0;
  const pp = G.player && G.player.pos ? G.player.pos : null;
  if (pp) {
    for (const pk of G.pickups) {
      if (mi >= markerPool.length) break;
      if (!pk || pk.taken || !pk.pos) continue;
      _v.subVectors(pk.pos, pp);
      if (_v.lengthSq() > PICKUP_RANGE_SQ) continue;
      const s = markerPool[mi++];
      s.visible = true;
      s.position.set(pk.pos.x, pk.pos.y + 1.1, pk.pos.z);
    }
  }
  for (; mi < markerPool.length; mi++) markerPool[mi].visible = false;
}

function ensureMarkers() {
  if (markerPool.length) return;
  diamondTex = makeDiamondTexture();
  markerMat = new THREE.SpriteMaterial({
    map: diamondTex, transparent: true, depthTest: false, opacity: 0.95,
  });
  for (let i = 0; i < MAX_MARKERS; i++) {
    const s = new THREE.Sprite(markerMat);
    s.scale.set(0.8, 0.8, 1);
    s.renderOrder = 1000;
    s.visible = false;
    markerPool.push(s);
  }
}

/** Cyan-on-dark canvas label sprite, e.g. "OPTIC ×2.5". */
function makeLabelSprite(text) {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 64;
  const c = cv.getContext('2d');
  c.font = 'bold 26px "Segoe UI", system-ui, sans-serif';
  const tw = Math.min(c.measureText(text).width, 220);
  const bw = tw + 28;
  c.fillStyle = 'rgba(89,227,255,0.92)';
  c.fillRect((256 - bw) / 2, 10, bw, 44);
  c.fillStyle = '#04222e';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(2.4, 0.6, 1);
  spr.renderOrder = 1000;
  return spr;
}

function makeDiamondTexture() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const c = cv.getContext('2d');
  c.strokeStyle = '#59e3ff';
  c.lineWidth = 6;
  c.shadowColor = '#59e3ff';
  c.shadowBlur = 8;
  c.beginPath();
  c.moveTo(32, 7); c.lineTo(57, 32); c.lineTo(32, 57); c.lineTo(7, 32);
  c.closePath();
  c.stroke();
  return new THREE.CanvasTexture(cv);
}

function injectStyles() {
  if (document.getElementById('iw-focus-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-focus-style';
  st.textContent = `
#iw-focus-hint{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);
  z-index:21;pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif;
  font-size:12px;letter-spacing:2px;color:#59e3ff;background:rgba(8,12,16,.6);
  border:1px solid rgba(89,227,255,.35);padding:4px 14px;opacity:0;
  transition:opacity .25s;}
#iw-focus-hint.show{opacity:1;}
`;
  document.head.appendChild(st);
}
