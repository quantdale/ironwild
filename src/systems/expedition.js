// IRONWILD - bounded frontier expeditions.
// One optional objective is active at a time. The system owns plain-data state,
// one reusable Three.js site visual, and one DOM status panel. It rewards the
// existing inventory/XP systems instead of creating a second economy.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { heightAt, biomeAt } from '../world/terrain.js';
import { grantXp } from './xp.js';
import { clamp, makeRng } from '../core/utils.js';

export const EXPEDITION_TYPES = ['salvage', 'survey', 'signal'];
export const EXPEDITION_MAX_ACTIVE = 1;

const INITIAL_DELAY = 8;
const BETWEEN_EVENTS = 14;
const EVENT_DURATION = 150;
const INTERACT_RADIUS = 3.2;
const SURVEY_HOLD = 2.5;
const SIGNAL_HOLD = 3.5;
const MAX_COMPLETIONS = 9999;

const INTERACTIONS = {
  salvage: { action: 'interact', hold: 0, label: '[E] SECURE SITE' },
  survey: { action: 'interact', hold: SURVEY_HOLD, label: '[HOLD E] SURVEY SITE' },
  signal: { action: 'focus', hold: SIGNAL_HOLD, label: '[HOLD Q] RELIGHT RELAY' },
};

const ANCHORS = [
  { x: 112, z: -142, label: 'Mosswood Verge' },
  { x: -132, z: 156, label: 'Ashen Rise' },
  { x: 18, z: -116, label: 'Lakeward Shelf' },
  { x: 164, z: 48, label: 'Windscar Meadow' },
  { x: -176, z: -74, label: 'Old Relay' },
  { x: 74, z: 184, label: 'Stoneglass Pass' },
];

const REWARDS = {
  salvage: { shards: 12, oil: 2, xp: 35 },
  survey: { shards: 8, wood: 4, xp: 45 },
  signal: { shards: 16, medicine: 1, xp: 70 },
};

const TITLES = {
  salvage: 'Recover lost machine salvage',
  survey: 'Survey the frontier beacon',
  signal: 'Relight the old-world signal',
};

const TYPE_LABELS = {
  salvage: 'SALVAGE CACHE',
  survey: 'SURVEY BEACON',
  signal: 'SIGNAL RELAY',
};

let inited = false;
let worldRoot = null;
let uiEl = null;
let beacon = null;
let cache = null;
let coreMat = null;
let ringMat = null;
let siteLight = null;
let promptActive = false;
let promptType = null;
let titleCache = '';
let detailCache = '';
let timerCache = '';
let progressCache = '';
let holdProgressCache = '';
let rng = null;

/** Return a fresh default that is safe to put in a save file. */
export function createExpeditionState() {
  return { active: null, completed: 0, nextId: 1, cooldown: INITIAL_DELAY };
}

function validType(type) {
  return EXPEDITION_TYPES.includes(type);
}

function normalizeEvent(event) {
  if (!event || typeof event !== 'object' || !validType(event.type)) return null;
  const x = Number(event.x);
  const z = Number(event.z);
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) > CONFIG.playRadius + 1) return null;
  const maxTime = clamp(Number(event.maxTime) || EVENT_DURATION, 30, EVENT_DURATION);
  const rawTime = Number(event.timeLeft);
  const timeLeft = Number.isFinite(rawTime) ? clamp(rawTime, 0, maxTime) : maxTime;
  return {
    id: Math.max(1, Math.floor(Number(event.id) || 1)),
    type: event.type,
    x,
    z,
    label: typeof event.label === 'string' ? event.label.slice(0, 40) : 'Frontier site',
    radius: clamp(Number(event.radius) || INTERACT_RADIUS, 1.5, 8),
    maxTime,
    timeLeft,
    progress: clamp(Number(event.progress) || 0, 0, INTERACTIONS[event.type].hold),
  };
}

/** Validate and clone persisted state; discard unknown fields and bad objects. */
export function normalizeExpeditionState(value) {
  const fresh = createExpeditionState();
  if (!value || typeof value !== 'object') return fresh;
  const completed = Number(value.completed);
  const nextId = Number(value.nextId);
  const cooldown = Number(value.cooldown);
  fresh.completed = Number.isFinite(completed) ? clamp(Math.floor(completed), 0, MAX_COMPLETIONS) : 0;
  fresh.nextId = Number.isFinite(nextId) ? Math.max(1, Math.floor(nextId)) : 1;
  fresh.cooldown = Number.isFinite(cooldown) ? clamp(cooldown, 0, BETWEEN_EVENTS) : INITIAL_DELAY;
  fresh.active = normalizeEvent(value.active);
  if (fresh.active) fresh.nextId = Math.max(fresh.nextId, fresh.active.id + 1);
  return fresh;
}

/** Squared XZ distance from a player position to an event target. */
export function eventDistance(event, pos) {
  if (!event || !pos) return Infinity;
  const dx = Number(event.x) - Number(pos.x);
  const dz = Number(event.z) - Number(pos.z);
  return dx * dx + dz * dz;
}

/** Public reward copy for UI/tests; callers cannot mutate tuning records. */
export function rewardForType(type) {
  const reward = REWARDS[type];
  return reward ? { ...reward } : null;
}

/** Public interaction copy for UI/tests; callers cannot mutate tuning. */
export function interactionForType(type) {
  const interaction = INTERACTIONS[type];
  return interaction ? { ...interaction } : null;
}

/** Deterministic site selection used by the scheduler. */
export function anchorFor(completed, id) {
  const index = Math.abs((Math.floor(completed) * 3 + Math.floor(id)) % ANCHORS.length);
  return { ...ANCHORS[index] };
}

function safeLandAnchor(anchor) {
  if (heightAt(anchor.x, anchor.z) > CONFIG.waterLevel + 0.4) return { ...anchor };
  for (let radius = 8; radius <= 40; radius += 8) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const x = anchor.x + Math.cos(angle) * radius;
      const z = anchor.z + Math.sin(angle) * radius;
      if (Math.hypot(x, z) < CONFIG.playRadius - 10 && heightAt(x, z) > CONFIG.waterLevel + 0.4) return { x, z };
    }
  }
  return { x: 28, z: 20 };
}

function makeEvent() {
  const state = normalizeExpeditionState(G.expedition);
  const id = state.nextId;
  const anchor = safeLandAnchor(anchorFor(state.completed, id));
  const type = EXPEDITION_TYPES[Math.floor(rng() * EXPEDITION_TYPES.length)];
  const event = {
    id,
    type,
    x: anchor.x,
    z: anchor.z,
    label: anchor.label,
    radius: INTERACT_RADIUS,
    maxTime: EVENT_DURATION,
    timeLeft: EVENT_DURATION,
    progress: 0,
  };
  G.expedition = { ...state, active: event, nextId: id + 1, cooldown: 0 };
  bus.emit('expeditionStarted', { event });
  bus.emit('notify', { text: `New expedition: ${TITLES[type]}`, tone: 'info' });
}

function addReward(type) {
  const reward = REWARDS[type];
  const inv = G.inventory;
  for (const [key, value] of Object.entries(reward)) {
    if (key === 'xp' || typeof inv[key] !== 'number') continue;
    const cap = key === 'arrows' ? inv.maxArrows : key === 'fireArrows' ? inv.maxFireArrows : Infinity;
    inv[key] = Math.min(cap, Math.max(0, inv[key] + value));
  }
  grantXp(reward.xp, `expedition:${type}`);
}

function completeEvent() {
  const event = G.expedition && G.expedition.active;
  if (!event) return;
  addReward(event.type);
  G.expedition.completed = clamp((G.expedition.completed | 0) + 1, 0, MAX_COMPLETIONS);
  G.expedition.active = null;
  G.expedition.cooldown = BETWEEN_EVENTS;
  bus.emit('expeditionCompleted', { event, reward: rewardForType(event.type) });
  bus.emit('notify', { text: `Expedition complete — ${TYPE_LABELS[event.type]}`, tone: 'good' });
  setPrompt(false);
}

function expireEvent() {
  const event = G.expedition && G.expedition.active;
  if (!event) return;
  G.expedition.active = null;
  G.expedition.cooldown = BETWEEN_EVENTS;
  bus.emit('expeditionExpired', { event });
  bus.emit('notify', { text: 'Expedition expired', tone: 'bad' });
  setPrompt(false);
}

function setPrompt(near, event) {
  const type = event ? event.type : null;
  if (near === promptActive && (!near || type === promptType)) return;
  promptActive = near;
  promptType = type;
  const interaction = event ? INTERACTIONS[event.type] : null;
  bus.emit('prompt', {
    text: near && interaction ? interaction.label : null,
    source: 'expedition',
    priority: 2,
  });
}

function buildWorldVisuals() {
  if (!G.scene) return;
  worldRoot = new THREE.Group();
  worldRoot.name = 'ironwild_expedition_site';
  worldRoot.visible = false;

  const baseMat = new THREE.MeshStandardMaterial({ color: 0x202a31, metalness: 0.85, roughness: 0.3 });
  coreMat = new THREE.MeshStandardMaterial({ color: 0x59e3ff, emissive: 0x12485a, emissiveIntensity: 2.2, metalness: 0.25, roughness: 0.24 });
  ringMat = new THREE.MeshBasicMaterial({ color: 0x59e3ff, transparent: true, opacity: 0.72 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.5, 0.35, 8), baseMat);
  base.position.y = 0.18;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 2.1, 8), baseMat);
  mast.position.y = 1.25;
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.42, 1), coreMat);
  core.name = 'expedition_core';
  core.position.y = 2.15;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.045, 6, 24), ringMat);
  ring.name = 'expedition_ring';
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.08;
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.48), coreMat);
  flag.position.set(0.3, 1.55, 0);
  flag.rotation.y = Math.PI / 2;
  cache = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.7, 0.85), baseMat);
  cache.name = 'expedition_cache';
  cache.position.y = 0.55;
  cache.visible = false;
  siteLight = new THREE.PointLight(0x59e3ff, 1.4, 14, 2);
  siteLight.position.y = 2.1;

  beacon = new THREE.Group();
  beacon.add(base, mast, core, ring, flag, siteLight);
  worldRoot.add(beacon, cache);
  G.scene.add(worldRoot);
}

function updateWorldVisual(event) {
  if (!worldRoot || !event) {
    if (worldRoot) worldRoot.visible = false;
    return;
  }
  worldRoot.visible = true;
  worldRoot.position.set(event.x, heightAt(event.x, event.z) + 0.02, event.z);
  const pulse = 1 + Math.sin(G.elapsed * 4.5) * 0.12;
  const core = beacon.getObjectByName('expedition_core');
  const ring = beacon.getObjectByName('expedition_ring');
  if (core) core.scale.setScalar(pulse);
  if (ring) {
    ring.scale.setScalar(1 + Math.sin(G.elapsed * 2.4) * 0.08);
    ring.rotation.z = G.elapsed * 0.65;
  }
  if (siteLight) siteLight.intensity = 1.2 + Math.sin(G.elapsed * 4.5) * 0.35;
  const salvage = event.type === 'salvage';
  beacon.visible = !salvage;
  cache.visible = salvage;
  if (salvage) {
    cache.rotation.y = G.elapsed * 0.25;
    coreMat.color.setHex(0xffc857);
    coreMat.emissive.setHex(0x6b4314);
    ringMat.color.setHex(0xffc857);
    if (siteLight) siteLight.color.setHex(0xffc857);
  } else {
    const signal = event.type === 'signal';
    coreMat.color.setHex(signal ? 0xff6b5f : 0x59e3ff);
    coreMat.emissive.setHex(signal ? 0x6b1d18 : 0x12485a);
    ringMat.color.setHex(signal ? 0xff6b5f : 0x59e3ff);
    if (siteLight) siteLight.color.setHex(signal ? 0xff6b5f : 0x59e3ff);
  }
}

function updateUi(event, near) {
  if (!uiEl) return;
  if (!event) {
    uiEl.classList.remove('show');
    return;
  }
  uiEl.classList.add('show');
  const title = `${TYPE_LABELS[event.type]} · ${event.label}`;
  const distance = Math.ceil(Math.sqrt(eventDistance(event, G.player.pos)));
  const interaction = INTERACTIONS[event.type];
  const detail = near
    ? interaction.label
    : `${distance}m AWAY`;
  const holdPct = interaction.hold > 0
    ? Math.round((clamp(Number(event.progress) || 0, 0, interaction.hold) / interaction.hold) * 100)
    : 0;
  const timer = interaction.hold > 0
    ? `WINDOW ${Math.ceil(event.timeLeft)}s · ${holdPct}%`
    : `WINDOW ${Math.ceil(event.timeLeft)}s`;
  const progress = `${Math.round((event.timeLeft / event.maxTime) * 100)}%`;
  const holdProgress = `${holdPct}%`;
  if (title !== titleCache) {
    titleCache = title;
    uiEl.querySelector('.iw-exp-title').textContent = title;
  }
  if (detail !== detailCache) {
    detailCache = detail;
    uiEl.querySelector('.iw-exp-detail').textContent = detail;
  }
  if (timer !== timerCache) {
    timerCache = timer;
    uiEl.querySelector('.iw-exp-time').textContent = timer;
  }
  if (progress !== progressCache) {
    progressCache = progress;
    uiEl.querySelector('.iw-exp-fill').style.width = progress;
  }
  if (holdProgress !== holdProgressCache) {
    holdProgressCache = holdProgress;
    const holdTrack = uiEl.querySelector('.iw-exp-hold-track');
    holdTrack.style.display = interaction.hold > 0 ? 'block' : 'none';
    uiEl.querySelector('.iw-exp-hold-fill').style.width = holdProgress;
  }
}

function injectStyles() {
  if (document.getElementById('iw-expedition-style')) return;
  const style = document.createElement('style');
  style.id = 'iw-expedition-style';
  style.textContent = `
#iw-expedition { position:fixed; right:218px; bottom:22px; z-index:20; width:250px;
  padding:10px 12px; background:rgba(7,12,16,.72); border:1px solid rgba(89,227,255,.34);
  color:#eaf7fb; font:11px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;
  pointer-events:none; opacity:0; transform:translateY(7px); transition:opacity .25s,transform .25s;
  box-shadow:0 5px 22px rgba(0,0,0,.26); }
#iw-expedition.show { opacity:1; transform:translateY(0); }
.iw-exp-kicker { font-size:9px; letter-spacing:2px; color:#59e3ff; margin-bottom:4px; }
.iw-exp-title { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.iw-exp-row { display:flex; justify-content:space-between; gap:8px; margin-top:6px; color:rgba(234,247,251,.7); }
.iw-exp-time { color:#ffc857; }
.iw-exp-track { height:3px; background:rgba(255,255,255,.14); margin-top:7px; }
.iw-exp-fill { height:100%; width:100%; background:#59e3ff; transition:width .2s linear; }
.iw-exp-hold-track { display:none; height:4px; background:rgba(255,255,255,.12); margin-top:5px; }
.iw-exp-hold-fill { height:100%; width:0%; background:#ffc857; transition:width .08s linear; }
`;
  document.head.appendChild(style);
}

function buildUi() {
  if (typeof document === 'undefined' || !document.body) return;
  injectStyles();
  uiEl = document.createElement('div');
  uiEl.id = 'iw-expedition';
  uiEl.innerHTML = '<div class="iw-exp-kicker">FRONTIER EXPEDITION</div><div class="iw-exp-title"></div><div class="iw-exp-row"><span class="iw-exp-detail"></span><span class="iw-exp-time"></span></div><div class="iw-exp-track"><div class="iw-exp-fill"></div></div><div class="iw-exp-hold-track"><div class="iw-exp-hold-fill"></div></div>';
  document.body.appendChild(uiEl);
}

/** Idempotent boot. Safe before the scene exists or in plain unit environments. */
export function createExpedition() {
  if (inited) return;
  inited = true;
  G.expedition = normalizeExpeditionState(G.expedition);
  rng = makeRng((CONFIG.seed ^ 0x5e71) >>> 0);
  buildWorldVisuals();
  buildUi();
}

/** Advance the active event in scaled gameplay time. */
export function updateExpedition(dt) {
  if (!inited) return;
  if (!Number.isFinite(dt) || dt < 0) dt = 1 / 60;
  let state = G.expedition;
  if (!state) return;
  if (!G.started || G.gameOver || !G.player || !G.player.pos) {
    if (uiEl) uiEl.classList.remove('show');
    if (worldRoot) worldRoot.visible = false;
    return;
  }
  if (!state.active) {
    state.cooldown -= dt;
    if (state.cooldown <= 0) {
      makeEvent();
      state = G.expedition;
    }
  }
  const event = state.active;
  if (!event) return;
  event.timeLeft = Math.max(0, event.timeLeft - dt);
  // Expiry wins over interaction on the boundary frame: a cache with zero
  // seconds left cannot be claimed merely because the player is standing on it.
  if (event.timeLeft <= 0) {
    expireEvent();
    updateWorldVisual(null);
    updateUi(null, false);
    return;
  }
  const near = eventDistance(event, G.player.pos) <= event.radius * event.radius;
  setPrompt(near, event);
  const interaction = INTERACTIONS[event.type];
  const held = near && Input.isAction(interaction.action);
  const currentProgress = clamp(Number(event.progress) || 0, 0, interaction.hold);
  if (interaction.hold === 0) {
    if (near && Input.wasActionPressed(interaction.action)) completeEvent();
  } else if (held) {
    event.progress = Math.min(interaction.hold, currentProgress + dt);
    if (event.progress >= interaction.hold) completeEvent();
  } else {
    event.progress = Math.max(0, currentProgress - dt * 1.5);
  }
  if (!G.expedition.active) {
    updateWorldVisual(null);
    updateUi(null, false);
    return;
  }
  updateWorldVisual(G.expedition.active);
  updateUi(G.expedition.active, near);
}

export function disposeExpedition() {
  if (promptActive) setPrompt(false);
  if (worldRoot) {
    worldRoot.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    worldRoot.removeFromParent();
  }
  if (uiEl) uiEl.remove();
  worldRoot = null;
  uiEl = null;
  beacon = null;
  cache = null;
  coreMat = null;
  ringMat = null;
  siteLight = null;
  inited = false;
  promptActive = false;
  promptType = null;
  titleCache = '';
  detailCache = '';
  timerCache = '';
  progressCache = '';
  holdProgressCache = '';
}

/** Diagnostics/test surface with immutable tuning copies. */
export function getExpeditionTuning() {
  return {
    initialDelay: INITIAL_DELAY,
    betweenEvents: BETWEEN_EVENTS,
    duration: EVENT_DURATION,
    interactRadius: INTERACT_RADIUS,
    maxActive: EXPEDITION_MAX_ACTIVE,
    anchors: ANCHORS.map((anchor) => ({ ...anchor, biome: biomeAt(anchor.x, anchor.z) })),
  };
}
