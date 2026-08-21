// IRONWILD - combat feedback FX, fully pooled and bus-driven.
// Floating damage numbers (canvas sprites), impact spark bursts (THREE.Points),
// weak-point-break shockwave rings, death explosions with smoke puffs,
// oil-splatter decals (v2, orange-tinted on fire hits).
// Everything is preallocated in createDamageFX(); the per-frame update only
// reuses pool entries - no allocations in hot loops.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { lerp } from '../core/utils.js';

const NUM_POOL = 24;        // live damage numbers cap
const SPARK_POOL = 3;       // concurrent spark bursts
const SPARK_PARTICLES = 16; // particles per burst
const RING_POOL = 4;
const SMOKE_POOL = 8;
const SPLAT_POOL = 10;      // oil-splatter decals (v2)

const NUM_DUR = 0.8;   // damage number lifetime
const NUM_RISE = 1.2;  // world units it climbs
const SPARK_DUR = 0.4;
const RING_DUR = 0.5;
const SMOKE_DUR = 1.2;
const SPLAT_DUR = 0.7;

// Spark tints per hit kind (v2): cyan weak / orange fire / pale body.
const SPARK_WEAK = 0xbdf3ff;
const SPARK_FIRE = 0xff8c3b;
const SPARK_BODY = 0x9fd8e8;
const SPLAT_COLOR = 0x4a3826;      // dark machine oil
const SPLAT_COLOR_FIRE = 0xc46a2a; // burning oil sheen

const _v1 = new THREE.Vector3();

let inited = false;
let nums = [];
let sparks = [];
let rings = [];
let smokes = [];
let splats = [];
let numCursor = 0;
let sparkCursor = 0;
let ringCursor = 0;
let smokeCursor = 0;
let splatCursor = 0;
let smokeTex = null;
let splatTex = null;
let ringGeo = null;

// ---------------------------------------------------------------- numbers

function makeNumberEntry() {
  const canvas = document.createElement('canvas');
  canvas.width = 192;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 30; // draw over machines
  sprite.visible = false;
  return { sprite, ctx, tex, t: 0, active: false, startY: 0 };
}

function spawnNumber(value, pos, weak) {
  const n = nums[numCursor];
  numCursor = (numCursor + 1) % NUM_POOL;
  n.active = true;
  n.t = 0;
  n.startY = pos.y + 0.35;
  const ctx = n.ctx;
  ctx.clearRect(0, 0, 192, 64);
  ctx.font = 'bold 42px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(8,12,16,0.85)';
  ctx.strokeText(String(value), 96, 34);
  ctx.fillStyle = weak ? '#59e3ff' : '#e8eef2'; // cyan bold for weak, pale body
  ctx.fillText(String(value), 96, 34);
  n.tex.needsUpdate = true;
  n.sprite.material.opacity = 1;
  n.sprite.position.set(
    pos.x + (Math.random() - 0.5) * 0.5,
    n.startY,
    pos.z + (Math.random() - 0.5) * 0.5,
  );
  const s = weak ? 1.15 : 1;
  n.sprite.scale.set(1.5 * s, 0.5 * s, 1);
  n.sprite.visible = true;
}

function updateNums(dt) {
  for (let i = 0; i < nums.length; i++) {
    const n = nums[i];
    if (!n.active) continue;
    n.t += dt;
    const k = n.t / NUM_DUR;
    if (k >= 1) {
      n.active = false;
      n.sprite.visible = false;
      continue;
    }
    n.sprite.position.y = n.startY + NUM_RISE * k;
    n.sprite.material.opacity = k < 0.55 ? 1 : 1 - (k - 0.55) / 0.45;
  }
}

// ---------------------------------------------------------------- sparks

function makeSparkEntry() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(SPARK_PARTICLES * 3), 3)
      .setUsage(THREE.DynamicDrawUsage),
  );
  const mat = new THREE.PointsMaterial({
    color: 0xbdf3ff, size: 0.11, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false; // positions live in world space at the origin object
  pts.visible = false;
  return { pts, vels: new Float32Array(SPARK_PARTICLES * 3), t: 0, dur: SPARK_DUR, active: false };
}

/** power scales speeds; dur/size/color vary per use (hit / break / death). */
function spawnSparks(pos, power, colorHex, size, dur = SPARK_DUR) {
  let s = null;
  for (let i = 0; i < SPARK_POOL; i++) {
    const c = sparks[(sparkCursor + i) % SPARK_POOL];
    if (!c.active) { s = c; sparkCursor = (sparkCursor + i + 1) % SPARK_POOL; break; }
  }
  if (!s) {
    // all busy: steal the oldest burst (smallest t = spawned longest ago)
    s = sparks[0];
    for (let i = 1; i < SPARK_POOL; i++) if (sparks[i].t < s.t) s = sparks[i];
  }
  s.active = true;
  s.t = 0;
  s.dur = dur;
  s.pts.visible = true;
  s.pts.material.color.set(colorHex);
  s.pts.material.size = size;
  s.pts.material.opacity = 1;
  const arr = s.pts.geometry.attributes.position.array;
  const vel = s.vels;
  for (let i = 0; i < SPARK_PARTICLES; i++) {
    const j = i * 3;
    arr[j] = pos.x;
    arr[j + 1] = pos.y;
    arr[j + 2] = pos.z;
    // random spherical direction with an upward bias
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = (2.2 + Math.random() * 5.2) * power;
    vel[j] = Math.sin(ph) * Math.cos(th) * sp;
    vel[j + 1] = Math.abs(Math.cos(ph)) * sp * 0.85 + 1.6;
    vel[j + 2] = Math.sin(ph) * Math.sin(th) * sp;
  }
  s.pts.geometry.attributes.position.needsUpdate = true;
}

function updateSparks(dt) {
  const g = CONFIG.gravity;
  for (let i = 0; i < sparks.length; i++) {
    const s = sparks[i];
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / s.dur;
    if (k >= 1) {
      s.active = false;
      s.pts.visible = false;
      continue;
    }
    const arr = s.pts.geometry.attributes.position.array;
    const vel = s.vels;
    for (let j = 0; j < arr.length; j += 3) {
      vel[j + 1] -= g * dt;
      arr[j] += vel[j] * dt;
      arr[j + 1] += vel[j + 1] * dt;
      arr[j + 2] += vel[j + 2] * dt;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
    s.pts.material.opacity = 1 - k;
  }
}

// ---------------------------------------------------------------- rings

function makeRingEntry() {
  const mat = new THREE.MeshBasicMaterial({
    color: 0x59e3ff, transparent: true, opacity: 0.95,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(ringGeo, mat);
  mesh.renderOrder = 25;
  mesh.visible = false;
  return { mesh, t: 0, active: false };
}

function spawnRing(pos) {
  const r = rings[ringCursor];
  ringCursor = (ringCursor + 1) % RING_POOL;
  r.active = true;
  r.t = 0;
  r.mesh.position.copy(pos);
  r.mesh.scale.setScalar(0.35);
  r.mesh.material.opacity = 0.95;
  r.mesh.visible = true;
}

function updateRings(dt) {
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (!r.active) continue;
    r.t += dt;
    const k = r.t / RING_DUR;
    if (k >= 1) {
      r.active = false;
      r.mesh.visible = false;
      continue;
    }
    r.mesh.scale.setScalar(lerp(0.35, 3.2, k));
    r.mesh.material.opacity = 0.95 * (1 - k);
    if (G.camera) r.mesh.quaternion.copy(G.camera.quaternion); // billboard
  }
}

// ---------------------------------------------------------------- smoke

function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.38)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSmokeEntry() {
  const mat = new THREE.SpriteMaterial({
    map: smokeTex, color: 0x8a8f94, transparent: true, opacity: 0.5, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.visible = false;
  return { sprite, t: 0, active: false, baseScale: 1, drift: new THREE.Vector3() };
}

function spawnSmoke(pos) {
  const s = smokes[smokeCursor];
  smokeCursor = (smokeCursor + 1) % SMOKE_POOL;
  s.active = true;
  s.t = 0;
  s.baseScale = 0.8 + Math.random() * 0.6;
  s.sprite.position.set(
    pos.x + (Math.random() - 0.5) * 1.2,
    pos.y + 0.3 + Math.random() * 0.8,
    pos.z + (Math.random() - 0.5) * 1.2,
  );
  s.drift.set((Math.random() - 0.5) * 0.7, 0.9 + Math.random() * 0.7, (Math.random() - 0.5) * 0.7);
  s.sprite.material.opacity = 0.5;
  s.sprite.scale.setScalar(s.baseScale);
  s.sprite.visible = true;
}

function updateSmokes(dt) {
  for (let i = 0; i < smokes.length; i++) {
    const s = smokes[i];
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / SMOKE_DUR;
    if (k >= 1) {
      s.active = false;
      s.sprite.visible = false;
      continue;
    }
    s.sprite.position.addScaledVector(s.drift, dt);
    s.sprite.scale.setScalar(s.baseScale * (1 + 1.7 * k));
    s.sprite.material.opacity = 0.5 * (1 - k);
  }
}

// ---------------------------------------------------------------- splats (v2)

/** Irregular oil-blob texture: white on transparent, tinted per spawn. */
function makeSplatTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath();
  ctx.arc(32, 32, 13, 0, Math.PI * 2);
  ctx.fill();
  // satellite droplets flung outward
  for (let i = 0; i < 7; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = 15 + Math.random() * 14;
    ctx.beginPath();
    ctx.arc(32 + Math.cos(ang) * r, 32 + Math.sin(ang) * r, 1.5 + Math.random() * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeSplatEntry() {
  const mat = new THREE.SpriteMaterial({
    map: splatTex, color: SPLAT_COLOR, transparent: true, opacity: 0.55,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 15; // under rings/numbers so FX read on top
  sprite.visible = false;
  return { sprite, t: 0, active: false };
}

/** Oil-splatter decal at a hit point; billboards briefly then fades away. */
function spawnSplat(pos, fire) {
  const s = splats[splatCursor];
  splatCursor = (splatCursor + 1) % SPLAT_POOL;
  s.active = true;
  s.t = 0;
  s.sprite.position.set(
    pos.x + (Math.random() - 0.5) * 0.2,
    pos.y + (Math.random() - 0.5) * 0.2,
    pos.z + (Math.random() - 0.5) * 0.2,
  );
  s.sprite.material.rotation = Math.random() * Math.PI * 2;
  s.sprite.material.color.setHex(fire ? SPLAT_COLOR_FIRE : SPLAT_COLOR);
  s.sprite.material.opacity = 0.55;
  s.sprite.scale.setScalar(0.8 + Math.random() * 0.3);
  s.sprite.visible = true;
}

function updateSplats(dt) {
  for (let i = 0; i < splats.length; i++) {
    const s = splats[i];
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / SPLAT_DUR;
    if (k >= 1) {
      s.active = false;
      s.sprite.visible = false;
      continue;
    }
    s.sprite.scale.setScalar(s.sprite.scale.x + dt * 0.5); // creep outward
    s.sprite.material.opacity = 0.55 * (1 - k);
  }
}

// ---------------------------------------------------------------- bus hooks

function onMachineHit(p) {
  if (!p || !p.point) return;
  spawnNumber(Math.round(p.damage || 0), p.point, !!p.weak);
  const col = p.fire ? SPARK_FIRE : p.weak ? SPARK_WEAK : SPARK_BODY;
  spawnSparks(p.point, p.fire ? 0.8 : p.weak ? 1.0 : 0.55, col, 0.11);
  spawnSplat(p.point, !!p.fire);
}

function onPartBroken(p) {
  if (!p || !p.machine) return;
  const m = p.machine;
  const wp = (p.partName != null && m.weakPoints)
    ? m.weakPoints.find((w) => w.name === p.partName)
    : null;
  if (wp && wp.mesh) wp.mesh.getWorldPosition(_v1);
  else _v1.copy(m.group.position);
  spawnSparks(_v1, 1.4, 0xaefcff, 0.14, 0.55); // bigger burst than a plain hit
  spawnRing(_v1);
}

function onMachineDied(p) {
  if (!p || !p.machine) return;
  _v1.copy(p.pos || p.machine.group.position);
  spawnSparks(_v1, 2.0, 0xdffbff, 0.17, 0.6); // explosion burst
  for (let i = 0; i < 4; i++) spawnSmoke(_v1);
}

// ---------------------------------------------------------------- public API

/** Build all pools, add them to the scene, subscribe to combat events. */
export function createDamageFX() {
  if (inited || !G.scene) return;
  inited = true;

  for (let i = 0; i < NUM_POOL; i++) {
    const e = makeNumberEntry();
    G.scene.add(e.sprite);
    nums.push(e);
  }
  for (let i = 0; i < SPARK_POOL; i++) {
    const e = makeSparkEntry();
    G.scene.add(e.pts);
    sparks.push(e);
  }
  ringGeo = new THREE.TorusGeometry(0.5, 0.045, 6, 28);
  for (let i = 0; i < RING_POOL; i++) {
    const e = makeRingEntry();
    G.scene.add(e.mesh);
    rings.push(e);
  }
  smokeTex = makeSmokeTexture();
  for (let i = 0; i < SMOKE_POOL; i++) {
    const e = makeSmokeEntry();
    G.scene.add(e.sprite);
    smokes.push(e);
  }
  splatTex = makeSplatTexture();
  for (let i = 0; i < SPLAT_POOL; i++) {
    const e = makeSplatEntry();
    G.scene.add(e.sprite);
    splats.push(e);
  }

  bus.on('machineHit', onMachineHit);
  bus.on('partBroken', onPartBroken);
  bus.on('machineDied', onMachineDied);
}

/** Advance all FX; dt is the scaled gameplay delta from main.js. */
export function updateDamageFX(dt) {
  if (!inited) createDamageFX();
  if (!inited || !(dt > 0)) return;
  updateNums(dt);
  updateSparks(dt);
  updateRings(dt);
  updateSmokes(dt);
  updateSplats(dt);
}
