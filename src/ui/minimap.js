// IRONWILD - minimap (v2): circular canvas under the top-right resource counters.
// The terrain swatch is baked ONCE at init (96x96 heightAt/biomeAt grid sampled
// over worldSize into an offscreen canvas); per-frame work is throttled to 10 Hz
// and limited to one drawImage plus a handful of dots/rings. North-up map,
// world-to-map scale = size / CONFIG.worldSize. Before G.mapRevealed only a
// 60u radius around the player is visible (radial-gradient fog mask).

import * as terrain from '../world/terrain.js';
import { G, CONFIG } from '../core/state.js';
import { hash2 } from '../core/utils.js';

const SIZE = 180;                 // css px diameter
const BAKE_RES = 96;              // terrain swatch sampling grid
const REDRAW_INTERVAL = 0.1;      // 10 Hz throttle
const REVEAL_RADIUS = 60;         // world units visible before the map reveal
const TAU = Math.PI * 2;

// Biome palette (minimap spec + ARCHITECTURE.md style guide).
const COL_MEADOW = [0x6a, 0x8f, 0x4f];
const COL_FOREST = [0x39, 0x5c, 0x33];
const COL_HIGHLAND = [0x7d, 0x75, 0x68];
const COL_SAND = [0xc7, 0xb0, 0x77];
const COL_WATER = [0x3d, 0x6f, 0x7d];
const COL_WATER_DEEP = [0x25, 0x49, 0x54];

const DOT_COLORS = {
  wood: '#6b4a2f',
  shards: '#59e3ff',
  oil: '#8a4b32',
  medicine: '#e06a5a',
};
const DOT_UNKNOWN = '#dfe7ea';
const COL_AGGRO = '#ff4d3d';
const COL_CALM = '#9aa3ab';
const COL_QUEST = '#f2c14e';
const COL_EXPEDITION = '#59e3ff';
const COL_PLAYER = '#eef6f8';
const FOG_RGBA = 'rgba(6,10,14,0.94)';

// Named regions make the expanded map read like a frontier chart rather than
// an enlarged radar. Coordinates are world-space anchors, so labels remain
// aligned with the same deterministic terrain bake at every resolution.
const MAP_REGIONS = [
  { name: 'LAKEWARD BASIN', x: 0, z: -60, color: '#8fd7e4' },
  { name: 'MOSSWOOD', x: 112, z: -88, color: '#a8cf86' },
  { name: 'WINDSCAR MEADOW', x: 150, z: 42, color: '#d9c78a' },
  { name: 'ASHEN RISE', x: -112, z: 142, color: '#d0c6b2' },
  { name: 'OLD RELAY', x: -158, z: -70, color: '#e6a28f' },
];
const MAP_LANDMARKS = [
  { name: 'WAYSHRINE', x: 10, z: -14, color: '#f1d58a' },
];

let created = false;
let wrap = null;
let canvas = null;
let ctx = null;
let dpr = 1;
let bakeCanvas = null;
let acc = 0;
let shown = false;
let placed = false;

// Cached fog gradient - rebuilt only when the player moves >= 1 px on the map.
let fogGrad = null;
let fogX = -1;
let fogY = -1;
let expandedRedrawT = 0;

// Resolved quest-target world pos is returned explicitly by resolveQuestTarget().

export function createMinimap() {
  if (created) return;
  created = true;
  injectStyles();

  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas = document.createElement('canvas');
  canvas.width = Math.round(SIZE * dpr);
  canvas.height = Math.round(SIZE * dpr);
  wrap = document.createElement('div');
  wrap.id = 'iw-minimap';
  wrap.appendChild(canvas);
  document.body.appendChild(wrap);
  ctx = canvas.getContext('2d');

  bakeTerrain();
  tryPlace();
  window.addEventListener('resize', () => { placed = false; });
}

export function updateMinimap(dt) {
  if (!created || !ctx) return;
  if (typeof dt !== 'number' || !isFinite(dt)) dt = 1 / 60;
  if (!placed) tryPlace();
  acc += dt;
  if (acc < REDRAW_INTERVAL) return;
  acc %= REDRAW_INTERVAL;
  redraw();
}

// ---------------------------------------------------------------- internals

/** Sample heightAt/biomeAt once into an offscreen 96x96 canvas. */
function bakeTerrain() {
  bakeCanvas = document.createElement('canvas');
  bakeCanvas.width = BAKE_RES;
  bakeCanvas.height = BAKE_RES;
  const bctx = bakeCanvas.getContext('2d');
  const img = bctx.createImageData(BAKE_RES, BAKE_RES);
  const data = img.data;
  const half = CONFIG.worldSize * 0.5;
  const step = CONFIG.worldSize / BAKE_RES;
  const wl = CONFIG.waterLevel;
  const hasBiome = typeof terrain.biomeAt === 'function';
  let o = 0;
  for (let j = 0; j < BAKE_RES; j++) {
    const z = -half + (j + 0.5) * step;
    for (let i = 0; i < BAKE_RES; i++) {
      const x = -half + (i + 0.5) * step;
      const h = terrain.heightAt(x, z);
      let r, g, b;
      if (h < wl) {
        // Water, darkening with depth.
        const deep = Math.min(1, (wl - h) / 8);
        r = COL_WATER[0] + (COL_WATER_DEEP[0] - COL_WATER[0]) * deep;
        g = COL_WATER[1] + (COL_WATER_DEEP[1] - COL_WATER[1]) * deep;
        b = COL_WATER[2] + (COL_WATER_DEEP[2] - COL_WATER[2]) * deep;
      } else {
        const biome = hasBiome ? String(terrain.biomeAt(x, z)) : '';
        let c;
        if (biome === 'forest') c = COL_FOREST;
        else if (biome === 'highland') c = COL_HIGHLAND;
        else if (biome === 'shore' || h < wl + 1.7) c = COL_SAND;
        else c = COL_MEADOW;
        // Subtle deterministic cell variation for texture.
        const v = 0.92 + hash2(i, j) * 0.16;
        r = c[0] * v;
        g = c[1] * v;
        b = c[2] * v;
      }
      data[o++] = r;
      data[o++] = g;
      data[o++] = b;
      data[o++] = 255;
    }
  }
  bctx.putImageData(img, 0, 0);
}

/**
 * Position the canvas just below the HUD resource counters (#iw-res),
 * right-aligned with them. Falls back to fixed offsets until HUD exists.
 */
function tryPlace() {
  const res = document.getElementById('iw-res');
  if (!res) return;
  const rect = res.getBoundingClientRect();
  if (!rect || rect.width <= 0) return; // HUD not laid out yet
  wrap.style.top = Math.round(rect.bottom + 12) + 'px';
  wrap.style.right =
    Math.max(12, Math.round(window.innerWidth - rect.right)) + 'px';
  placed = true;
}

function redraw() {
  const p = G.player;
  const active = !!G.started && !!p && !!p.pos;
  if (shown !== active) {
    shown = active;
    wrap.classList.toggle('show', active);
  }
  if (!active) return;

  const S = SIZE;
  const inv = 1 / CONFIG.worldSize;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  const px = (p.pos.x * inv + 0.5) * S;
  const py = (p.pos.z * inv + 0.5) * S;

  ctx.save();
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.5, S * 0.5 - 2, 0, TAU);
  ctx.clip();

  // Prebaked terrain swatch.
  ctx.drawImage(bakeCanvas, 0, 0, S, S);

  // Fog: beyond REVEAL_RADIUS everything stays dark until the Vantage reveal.
  const revealed = !!G.mapRevealed;
  const visR = REVEAL_RADIUS * S * inv;
  if (!revealed) {
    const gx = Math.round(px), gy = Math.round(py);
    if (!fogGrad || gx !== fogX || gy !== fogY) {
      fogX = gx;
      fogY = gy;
      fogGrad = ctx.createRadialGradient(gx, gy, visR * 0.55, gx, gy, visR);
      fogGrad.addColorStop(0, 'rgba(6,10,14,0)');
      fogGrad.addColorStop(1, FOG_RGBA);
    }
    ctx.fillStyle = fogGrad;
    ctx.fillRect(0, 0, S, S);
  }

  const visR2 = visR * visR;
  const lim = S * 0.5 + 6; // cull margin just outside the circle

  // Untaken pickups: small type-colored squares.
  const picks = G.pickups;
  for (let i = 0; i < picks.length; i++) {
    const pk = picks[i];
    if (!pk || pk.taken || !pk.pos) continue;
    const dx = pk.pos.x - p.pos.x, dz = pk.pos.z - p.pos.z;
    if (!revealed && dx * dx + dz * dz > visR2) continue;
    const mx = (pk.pos.x * inv + 0.5) * S;
    const my = (pk.pos.z * inv + 0.5) * S;
    if (Math.abs(mx - S * 0.5) > lim || Math.abs(my - S * 0.5) > lim) continue;
    ctx.fillStyle = DOT_COLORS[pk.type] || DOT_UNKNOWN;
    ctx.fillRect(mx - 1.5, my - 1.5, 3, 3);
  }

  // Machines: red when aggro, grey when calm; Alpha variants slightly larger.
  const machines = G.machines;
  for (let i = 0; i < machines.length; i++) {
    const m = machines[i];
    if (!m || !m.alive || !m.group) continue;
    const mp = m.group.position;
    const dx = mp.x - p.pos.x, dz = mp.z - p.pos.z;
    if (!revealed && dx * dx + dz * dz > visR2) continue;
    const mx = (mp.x * inv + 0.5) * S;
    const my = (mp.z * inv + 0.5) * S;
    if (Math.abs(mx - S * 0.5) > lim || Math.abs(my - S * 0.5) > lim) continue;
    const alpha = /^alpha/i.test(String(m.name || ''));
    ctx.fillStyle = m.aggro ? COL_AGGRO : COL_CALM;
    ctx.beginPath();
    ctx.arc(mx, my, alpha ? 3.4 : 2.4, 0, TAU);
    ctx.fill();
  }

  // Quest targets: gold rings, always visible (they are objectives).
  const slots = G.quests && G.quests.slots;
  if (slots) {
    for (let i = 0; i < slots.length; i++) {
      const q = slots[i];
      if (!q || q.done) continue;
      const target = resolveQuestTarget(q);
      if (!target) continue;
      const mx = (target.x * inv + 0.5) * S;
      const my = (target.z * inv + 0.5) * S;
      ctx.strokeStyle = 'rgba(242,193,78,0.35)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(mx, my, 5, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = COL_QUEST;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx, my, 5, 0, TAU);
      ctx.stroke();
    }
  }

  // The optional expedition is a single high-contrast beacon. It is an
  // objective marker rather than a machine/pickup, so it remains visible
  // through the pre-reveal fog just like quest targets.
  const expedition = G.expedition && G.expedition.active;
  if (expedition) {
    const ex = (expedition.x * inv + 0.5) * S;
    const ez = (expedition.z * inv + 0.5) * S;
    // A faint route line makes a distant objective actionable even when the
    // player has not revealed the map. The line is intentionally clipped by
    // the circular map viewport above.
    ctx.save();
    ctx.strokeStyle = 'rgba(89,227,255,0.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(ex, ez);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = COL_EXPEDITION;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ex, ez, 6, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = COL_EXPEDITION;
    ctx.fillRect(ex - 1.5, ez - 1.5, 3, 3);
  }

  // Player arrow at its map position, rotated by camera yaw (yaw 0 = north/up).
  ctx.translate(px, py);
  ctx.rotate(-G.cam.yaw);
  ctx.fillStyle = COL_PLAYER;
  ctx.strokeStyle = 'rgba(6,10,14,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -6);
  ctx.lineTo(4.4, 5);
  ctx.lineTo(0, 2.6);
  ctx.lineTo(-4.4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Rim ring.
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(S * 0.5, S * 0.5, S * 0.5 - 2, 0, TAU);
  ctx.stroke();
}

/**
 * Resolve a quest slot's target world position.
 * Slots: { type:'hunt'|'gather'|'scanVantage', target, need, progress, done }.
 */
function resolveQuestTarget(q) {
  const kind = String(q.type || '').toLowerCase();
  if (kind.indexOf('scan') >= 0 || kind.indexOf('vantage') >= 0) {
    const v = nearestMachine('vantage');
    return v ? { x: v.group.position.x, z: v.group.position.z } : null;
  }
  const want = String(q.target || '').toLowerCase();
  if (kind.indexOf('hunt') >= 0 || kind.indexOf('kill') >= 0) {
    const m = nearestMachine(want);
    return m ? { x: m.group.position.x, z: m.group.position.z } : null;
  }
  if (kind.indexOf('gather') >= 0 || kind.indexOf('collect') >= 0) {
    return nearestPickup(want);
  }
  return null;
}

/** Nearest alive machine of `type` ('' matches any). Returns machine or null. */
function nearestMachine(type) {
  let best = null;
  let bestD2 = Infinity;
  const pp = G.player.pos;
  for (let i = 0; i < G.machines.length; i++) {
    const m = G.machines[i];
    if (!m || !m.alive || !m.group) continue;
    if (type && String(m.type || '').toLowerCase() !== type) continue;
    const dx = m.group.position.x - pp.x, dz = m.group.position.z - pp.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = m;
    }
  }
  return best;
}

/** Nearest untaken pickup of `type`, or null when none exists. */
function nearestPickup(type) {
  let found = null;
  let bestD2 = Infinity;
  const pp = G.player.pos;
  for (let i = 0; i < G.pickups.length; i++) {
    const pk = G.pickups[i];
    if (!pk || pk.taken || !pk.pos) continue;
    if (type && String(pk.type || '').toLowerCase() !== type) continue;
    const dx = pk.pos.x - pp.x, dz = pk.pos.z - pp.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      found = { x: pk.pos.x, z: pk.pos.z };
    }
  }
  return found;
}

/**
 * Paint the full exploration map into a caller-owned canvas. This deliberately
 * reuses the baked terrain swatch and the same marker rules as the minimap;
 * opening the map costs one canvas redraw and no WebGL allocations.
 */
export function renderExpandedMap(target) {
  if (!target || !bakeCanvas || !G.player || !G.player.pos) return false;
  const mapSize = 720;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(mapSize * pixelRatio);
  const height = Math.round(mapSize * pixelRatio);
  if (target.width !== width || target.height !== height) {
    target.width = width;
    target.height = height;
  }
  const mapCtx = target.getContext('2d');
  if (!mapCtx) return false;
  mapCtx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  mapCtx.clearRect(0, 0, mapSize, mapSize);

  const inv = 1 / CONFIG.worldSize;
  const px = (G.player.pos.x * inv + 0.5) * mapSize;
  const py = (G.player.pos.z * inv + 0.5) * mapSize;
  const revealed = !!G.mapRevealed;
  const visR = REVEAL_RADIUS * mapSize * inv;
  const visR2 = visR * visR;
  const pointVisible = (x, z) => {
    const dx = x - G.player.pos.x;
    const dz = z - G.player.pos.z;
    return revealed || dx * dx + dz * dz <= visR2;
  };
  const mapX = (x) => (x * inv + 0.5) * mapSize;
  const mapY = (z) => (z * inv + 0.5) * mapSize;

  mapCtx.save();
  mapCtx.beginPath();
  mapCtx.rect(0, 0, mapSize, mapSize);
  mapCtx.clip();
  mapCtx.drawImage(bakeCanvas, 0, 0, mapSize, mapSize);
  if (!revealed) {
    const fog = mapCtx.createRadialGradient(px, py, visR * 0.45, px, py, visR);
    fog.addColorStop(0, 'rgba(6,10,14,0)');
    fog.addColorStop(1, 'rgba(6,10,14,0.96)');
    mapCtx.fillStyle = fog;
    mapCtx.fillRect(0, 0, mapSize, mapSize);
  }

  // A faint coordinate grid gives the chart scale and helps the player read
  // long routes without making the terrain texture noisy.
  mapCtx.strokeStyle = 'rgba(238,246,248,0.08)';
  mapCtx.lineWidth = 1;
  for (let world = -240; world <= 240; world += 60) {
    const gx = mapX(world);
    const gz = mapY(world);
    mapCtx.beginPath();
    mapCtx.moveTo(gx, 0);
    mapCtx.lineTo(gx, mapSize);
    mapCtx.moveTo(0, gz);
    mapCtx.lineTo(mapSize, gz);
    mapCtx.stroke();
  }

  // Fixed landmarks are deliberately separate from contracts and machines:
  // they remain useful navigation anchors after the fog has been surveyed.
  for (const landmark of MAP_LANDMARKS) {
    if (!pointVisible(landmark.x, landmark.z)) continue;
    const lx = mapX(landmark.x);
    const lz = mapY(landmark.z);
    mapCtx.fillStyle = landmark.color;
    mapCtx.strokeStyle = 'rgba(4,10,14,0.8)';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.moveTo(lx, lz - 8);
    mapCtx.lineTo(lx + 7, lz);
    mapCtx.lineTo(lx, lz + 8);
    mapCtx.lineTo(lx - 7, lz);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.stroke();
  }

  // Cartographic labels are painted after fog so undiscovered regions remain
  // unreadable until the player surveys them or gets close enough.
  mapCtx.font = '600 13px ui-monospace, SFMono-Regular, Consolas, monospace';
  mapCtx.textAlign = 'center';
  mapCtx.textBaseline = 'middle';
  for (const region of MAP_REGIONS) {
    if (!pointVisible(region.x, region.z)) continue;
    const rx = mapX(region.x);
    const rz = mapY(region.z);
    mapCtx.fillStyle = 'rgba(4, 10, 14, 0.7)';
    mapCtx.fillText(region.name, rx + 1, rz + 1);
    mapCtx.fillStyle = region.color;
    mapCtx.fillText(region.name, rx, rz);
  }

  // A compact navigation plate keeps the full map useful at a glance while
  // avoiding DOM churn each time the player moves.
  mapCtx.textAlign = 'left';
  mapCtx.font = '700 12px ui-monospace, SFMono-Regular, Consolas, monospace';
  mapCtx.fillStyle = '#eef6f8';
  mapCtx.fillText('N', mapSize - 28, 24);
  mapCtx.strokeStyle = '#eef6f8';
  mapCtx.lineWidth = 2;
  mapCtx.beginPath();
  mapCtx.moveTo(mapSize - 22, 42);
  mapCtx.lineTo(mapSize - 22, 28);
  mapCtx.lineTo(mapSize - 27, 34);
  mapCtx.moveTo(mapSize - 22, 28);
  mapCtx.lineTo(mapSize - 17, 34);
  mapCtx.stroke();
  mapCtx.strokeStyle = 'rgba(238,246,248,0.8)';
  mapCtx.lineWidth = 3;
  mapCtx.beginPath();
  mapCtx.moveTo(mapSize - 154, mapSize - 24);
  mapCtx.lineTo(mapSize - 34, mapSize - 24);
  mapCtx.stroke();
  mapCtx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
  mapCtx.fillStyle = 'rgba(238,246,248,0.82)';
  mapCtx.fillText('50 m', mapSize - 154, mapSize - 38);

  const expeditionDistanceTarget = G.expedition && G.expedition.active;
  if (expeditionDistanceTarget) {
    const dx = expeditionDistanceTarget.x - G.player.pos.x;
    const dz = expeditionDistanceTarget.z - G.player.pos.z;
    const distance = Math.round(Math.hypot(dx, dz));
    mapCtx.textAlign = 'right';
    mapCtx.font = '700 12px ui-monospace, SFMono-Regular, Consolas, monospace';
    mapCtx.fillStyle = '#59e3ff';
    mapCtx.fillText(`EXPEDITION · ${distance} m`, mapSize - 16, mapSize - 48);
  }

  const picks = G.pickups;
  for (let i = 0; i < picks.length; i++) {
    const pk = picks[i];
    if (!pk || pk.taken || !pk.pos || !pointVisible(pk.pos.x, pk.pos.z)) continue;
    mapCtx.fillStyle = DOT_COLORS[pk.type] || DOT_UNKNOWN;
    mapCtx.fillRect(mapX(pk.pos.x) - 2, mapY(pk.pos.z) - 2, 4, 4);
  }

  for (let i = 0; i < G.machines.length; i++) {
    const m = G.machines[i];
    if (!m || !m.alive || !m.group || !pointVisible(m.group.position.x, m.group.position.z)) continue;
    const mx = mapX(m.group.position.x);
    const my = mapY(m.group.position.z);
    mapCtx.fillStyle = m.aggro ? COL_AGGRO : COL_CALM;
    mapCtx.beginPath();
    mapCtx.arc(mx, my, /^alpha/i.test(String(m.name || '')) ? 6 : 4, 0, TAU);
    mapCtx.fill();
  }

  const slots = G.quests && G.quests.slots;
  if (slots) {
    for (let i = 0; i < slots.length; i++) {
      const q = slots[i];
      if (!q || q.done) continue;
      const target = resolveQuestTarget(q);
      if (!target) continue;
      mapCtx.strokeStyle = COL_QUEST;
      mapCtx.lineWidth = 2;
      mapCtx.beginPath();
      mapCtx.arc(mapX(target.x), mapY(target.z), 9, 0, TAU);
      mapCtx.stroke();
    }
  }

  const expedition = G.expedition && G.expedition.active;
  if (expedition) {
    const ex = mapX(expedition.x);
    const ez = mapY(expedition.z);
    mapCtx.strokeStyle = 'rgba(89,227,255,0.55)';
    mapCtx.lineWidth = 2;
    mapCtx.setLineDash([6, 6]);
    mapCtx.beginPath();
    mapCtx.moveTo(px, py);
    mapCtx.lineTo(ex, ez);
    mapCtx.stroke();
    mapCtx.setLineDash([]);
    mapCtx.strokeStyle = COL_EXPEDITION;
    mapCtx.lineWidth = 3;
    mapCtx.beginPath();
    mapCtx.arc(ex, ez, 12, 0, TAU);
    mapCtx.stroke();
    mapCtx.fillStyle = COL_EXPEDITION;
    mapCtx.fillRect(ex - 3, ez - 3, 6, 6);
  }

  mapCtx.translate(px, py);
  mapCtx.rotate(-G.cam.yaw);
  mapCtx.fillStyle = COL_PLAYER;
  mapCtx.strokeStyle = '#061016';
  mapCtx.lineWidth = 2;
  mapCtx.beginPath();
  mapCtx.moveTo(0, -14);
  mapCtx.lineTo(10, 12);
  mapCtx.lineTo(0, 6);
  mapCtx.lineTo(-10, 12);
  mapCtx.closePath();
  mapCtx.fill();
  mapCtx.stroke();
  mapCtx.restore();

  mapCtx.strokeStyle = 'rgba(255,255,255,0.28)';
  mapCtx.lineWidth = 2;
  mapCtx.strokeRect(1, 1, mapSize - 2, mapSize - 2);
  return true;
}

/** Redraw the expanded map at a bounded cadence while its panel is open. */
export function updateExpandedMap(target, dt = 1 / 60) {
  if (!target) return false;
  const step = Number.isFinite(dt) && dt >= 0 ? dt : 1 / 60;
  expandedRedrawT += step;
  if (expandedRedrawT < 0.12) return false;
  expandedRedrawT %= 0.12;
  return renderExpandedMap(target);
}

function injectStyles() {
  if (document.getElementById('iw-minimap-style')) return;
  const st = document.createElement('style');
  st.id = 'iw-minimap-style';
  st.textContent = `
#iw-minimap{position:fixed;z-index:20;width:${SIZE}px;height:${SIZE}px;
  pointer-events:none;opacity:0;transition:opacity .5s;}
#iw-minimap.show{opacity:1;}
#iw-minimap canvas{width:100%;height:100%;display:block;border-radius:50%;
  box-shadow:0 2px 10px rgba(0,0,0,.45);}
`;
  st.textContent += `
@media (max-width:700px) {
  #iw-minimap { width:min(140px,36vw); height:min(140px,36vw); }
}`;
  document.head.appendChild(st);
}
