// IRONWILD - pooled VFX engine (Wave H): the reusable particle layer that
// combat/damage.js's bespoke spark/smoke pools can migrate onto later. One
// fixed-capacity allocation per class at init, then the hot loops only touch
// preallocated slots - zero steady-state GC pressure.
//
//   sparks  - ONE THREE.Points cloud (custom shader, additive) holding every
//             live spark; small bright dots so hits read without blobbing.
//   debris  - ONE InstancedMesh of tiny tetrahedra (chips/splinters/shards).
//   smoke   - sprite puffs, LOW alpha + normal blending + depthTest on, so
//             smoke never paints over machine geometry (readability rule:
//             effects reveal events, they never hide targets).
//   flashes - brief additive billboards for muzzle/break pop frames.
//   rings   - expanding transparent ground-plane rings (shockwaves).
//
// Budgets are hard: MAX_ACTIVE units across all classes plus per-class caps.
// When full, spawn STEALS the lowest-priority most-progressed slot instead of
// dropping new feedback wholesale. Emission is LOD-scaled by camera distance
// and G.settings.quality, so distant fights cost almost nothing.
//
// Particle record (spec shape {pos, vel, life, ttl, size, color, drag,
// gravity}) is stored structure-of-arrays in typed fields below - same data,
// cache-friendly and allocation-free.

import * as THREE from 'three';
import { G, CONFIG } from '../core/state.js';
import { bus } from '../core/events.js';

// --- tuning -----------------------------------------------------------------

const SPARK_CAP = 512;
const DEBRIS_CAP = 256;
const SMOKE_CAP = 64;
const FLASH_CAP = 32;
const RING_CAP = 16;

// Hard global unit budget (sparks/debris/smoke/flashes/rings each count as 1).
// Class caps sum to 880 < 900, so pure single-class spam stays legal and the
// global cap only binds mixed loads, exactly where contention hurts.
const MAX_ACTIVE = SPARK_CAP + DEBRIS_CAP + SMOKE_CAP + FLASH_CAP + RING_CAP;

// Camera-distance emission bands (squared units): full nearby, decimated far,
// nothing beyond 140u - off-screen fights cost literally zero particles.
const LOD_NEAR2 = 30 * 30;     // <= 100%
const LOD_MID2 = 70 * 70;      // <= 50%
const LOD_FAR2 = 140 * 140;    // <= 20%, else 0

const QUALITY_MUL = { high: 1.0, medium: 0.7, low: 0.45 };

// Per-class spawn defaults; caller opts override any field.
const CLASS_DEFAULTS = {
  // gravity is a multiplier of CONFIG.gravity; drag is per-second damping.
  spark: { count: 1, speed: 6, spread: Math.PI, ttl: 0.45, size: 0.11, color: 0xffd9a0, gravity: 0.9, drag: 0.6, alpha: 1.0, priority: 0.5 },
  debris: { count: 1, speed: 7, spread: Math.PI * 0.9, ttl: 0.9, size: 1.0, color: 0x8f959b, gravity: 1.0, drag: 0.15, alpha: 1.0, priority: 0.5 },
  // Smoke rises (negative gravity), grows, and stays faint; lowest priority so
  // ambience loses its slots to gameplay sparks under budget pressure.
  smoke: { count: 1, speed: 1.2, spread: Math.PI, ttl: 1.3, size: 0.9, grow: 1.6, color: 0x777c80, alpha: 0.34, gravity: -0.06, drag: 1.2, priority: 0.35 },
  flash: { count: 1, speed: 0, spread: 0, ttl: 0.14, size: 1.4, color: 0xfff2d8, alpha: 0.85, gravity: 0, drag: 0, priority: 0.4 },
  ring: { ttl: 0.55, size: 4.5, color: 0xbfeaff, alpha: 0.8, priority: 0.45 }, // always exactly 1 unit
};

// --- module state -----------------------------------------------------------

let inited = false;
let sceneRef = null;         // captured at init so dispose never touches a swapped scene

let sparkPts = null;         // the single THREE.Points
let sparkGeo = null;
let sparkMat = null;
let sparkSize = null;        // aSize attr array (cap)
let sparkAlpha = null;       // aAlpha attr array (cap)

let debrisMesh = null;       // InstancedMesh or null when unsupported
let debrisGeo = null;
let debrisMat = null;
let debrisDirty = false;     // instanceMatrix changed since last upload

let smokeTex = null;         // shared soft radial canvas texture
let glowTex = null;          // tighter-core variant for flashes
let smokes = [];             // [{sprite}] parallel to the smoke pool slots
let flashes = [];            // [{sprite}]
let rings = [];              // [{mesh}]
let ringGeo = null;

let totalActive = 0;
let qualityMul = QUALITY_MUL.high;
let offSettings = null;      // unsubscribe from 'settingsChanged'

// --- pools (structure-of-arrays particle records) ---------------------------

/** One pool = every field of every slot, flat. Fields map 1:1 to the spec's
 *  particle record {pos, vel, life, ttl, size, color, drag, gravity} plus
 *  per-class extras (grow/alpha/priority/rot/spin). */
function makePool(kind, cap) {
  return {
    kind, cap,
    pos: new Float32Array(cap * 3),
    vel: new Float32Array(cap * 3),
    col: new Float32Array(cap * 3),  // linear-space rgb, mirrored into GPU attrs at spawn
    rot: new Float32Array(cap * 3),  // euler angles (debris tumble; harmless elsewhere)
    spin: new Float32Array(cap * 3), // rad/s around each axis
    life: new Float32Array(cap),
    ttl: new Float32Array(cap),
    size: new Float32Array(cap),
    grow: new Float32Array(cap),     // per-second scale growth (smoke/flash)
    alpha: new Float32Array(cap),    // base opacity before the life fade curve
    drag: new Float32Array(cap),
    grav: new Float32Array(cap),     // gravity multiplier
    pri: new Float32Array(cap),      // eviction priority: higher survives longer
    active: new Uint8Array(cap),
    count: 0,
    cursor: 0,                       // rotating scan start - spreads wear across slots
  };
}

const pools = {
  spark: makePool('spark', SPARK_CAP),
  debris: makePool('debris', DEBRIS_CAP),
  smoke: makePool('smoke', SMOKE_CAP),
  flash: makePool('flash', FLASH_CAP),
  ring: makePool('ring', RING_CAP),
};

// Scratch - reused every frame / every spawn, never reallocated.
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();          // second scratch - compose() needs distinct pos/scale
const _q = new THREE.Quaternion();
const _eu = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const _c = new THREE.Color();
const _d = { x: 0, y: 1, z: 0 };          // sampled velocity direction
const _axU = new THREE.Vector3();          // cone-basis helpers
const _axW = new THREE.Vector3();

// --- slot lifecycle ---------------------------------------------------------

/** Free one slot immediately. Debris instances are GPU-resident, so their
 *  matrices must be explicitly zero-scaled or dead chunks would hang mid-air;
 *  points/billboards/rings get covered by alpha-0 / visibleFlag instead. */
function releaseSlot(pool, i) {
  pool.active[i] = 0;
  pool.count--;
  totalActive--;
  pool.pos[i * 3 + 1] = -1000; // park underground; alpha-0 keeps it invisible too
  if (pool.kind === 'debris' && debrisMesh) {
    _m4.makeScale(0, 0, 0);
    debrisMesh.setMatrixAt(i, _m4);
    debrisDirty = true;
  }
}

/** Grab a slot: prefer an inactive one (rotating scan), else steal the
 *  lowest-priority most-progressed live slot - old low-stakes FX yield to new
 *  feedback instead of the newest effect being silently dropped. */
function acquireSlot(pool, priority) {
  const cap = pool.cap;
  for (let i = 0; i < cap; i++) {
    const idx = (pool.cursor + i) % cap;
    if (!pool.active[idx]) {
      pool.cursor = (idx + 1) % cap;
      pool.active[idx] = 1;
      pool.count++;
      totalActive++;
      return idx;
    }
  }
  // Full: eviction score = priority weighted 4x + normalized age (0..1).
  let worst = -1;
  let worstScore = Infinity;
  for (let i = 0; i < cap; i++) {
    const score = pool.pri[i] * 4 + pool.life[i] / Math.max(pool.ttl[i], 1e-4);
    if (score < worstScore) { worstScore = score; worst = i; }
  }
  if (worst < 0) return -1; // unreachable (cap > 0), kept as a guard
  releaseSlot(pool, worst);
  pool.active[worst] = 1;
  pool.count++;
  totalActive++;
  return worst;
}

// --- direction sampling -----------------------------------------------------

/** Fill `_d` with a unit vector: uniform sphere when spread >= PI, else a cone
 *  of half-angle `spread` around (dx,dy,dz). Plain-object out - no allocs. */
function sampleDir(dx, dy, dz, spread) {
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  dx /= len; dy /= len; dz /= len;
  if (spread >= Math.PI - 0.01) {
    // uniform sphere: acos-uniform polar + uniform azimuth
    const cosP = 2 * Math.random() - 1;
    const sinP = Math.sqrt(Math.max(0, 1 - cosP * cosP));
    const th = Math.random() * Math.PI * 2;
    _d.x = sinP * Math.cos(th); _d.y = cosP; _d.z = sinP * Math.sin(th);
    return;
  }
  // Orthonormal basis perpendicular to the cone axis.
  _v3.set(dx, dy, dz);
  const helper = Math.abs(dy) > 0.99 ? _axW.set(1, 0, 0) : _axW.set(0, 1, 0);
  _axU.crossVectors(_v3, helper).normalize();
  _axW.crossVectors(_v3, _axU);
  const theta = Math.random() * Math.PI * 2;
  const r = spread * Math.sqrt(Math.random()); // sqrt -> uniform disc of angles
  const cr = Math.cos(r), sr = Math.sin(r);
  const ux = Math.cos(theta), uz = Math.sin(theta);
  _d.x = dx * cr + (_axU.x * ux + _axW.x * uz) * sr;
  _d.y = dy * cr + (_axU.y * ux + _axW.y * uz) * sr;
  _d.z = dz * cr + (_axU.z * ux + _axW.z * uz) * sr;
}

// --- LOD --------------------------------------------------------------------

/** Distance-based emission scale from the camera (player pos fallback). */
function lodScale(pos) {
  const anchor = (G.camera && G.camera.position) ? G.camera.position
    : (G.player && G.player.pos) ? G.player.pos : null;
  if (!anchor) return 1; // cannot cull what we cannot locate - emit
  const dx = pos.x - anchor.x;
  const dy = pos.y - anchor.y;
  const dz = pos.z - anchor.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > LOD_FAR2) return 0;
  if (d2 > LOD_MID2) return 0.2;
  if (d2 > LOD_NEAR2) return 0.5;
  return 1;
}

function refreshQuality() {
  // Defensive: G.settings may be mid-merge or hold an unknown value.
  const q = G.settings && G.settings.quality;
  qualityMul = QUALITY_MUL[q] !== undefined ? QUALITY_MUL[q] : QUALITY_MUL.high;
}

// --- spawning ---------------------------------------------------------------

/**
 * Generic primitive behind every named effect. Spawns `count` units of `kind`
 * ('spark'|'debris'|'smoke'|'flash'|'ring') around `opts.pos`, sprayed inside
 * a cone of half-angle `opts.spread` around `opts.dir`.
 * Returns how many units actually spawned (after LOD x quality x budgets).
 * Rings ignore count (one expanding circle per call).
 */
export function spawnEffect(kind, opts = {}) {
  if (!inited && !initVfxEngine()) return 0;
  const pool = pools[kind];
  if (!pool) {
    console.warn(`[vfx] unknown effect kind "${kind}"`);
    return 0;
  }
  const pos = opts.pos;
  if (!pos || typeof pos.x !== 'number') return 0;
  if (kind === 'debris' && !debrisMesh) return 0; // class compiled out safely

  // LOD gate first - free even when it rejects.
  const lod = lodScale(pos);
  if (lod <= 0) return 0;

  const def = CLASS_DEFAULTS[kind];
  let n = kind === 'ring' ? 1 : Math.round((opts.count != null ? opts.count : def.count) * lod * qualityMul);
  if (n <= 0) return 0;
  const avail = Math.max(0, MAX_ACTIVE - totalActive);
  if (n > avail) n = avail;
  if (kind !== 'ring' && n > pool.cap) n = pool.cap; // per-class cap via slots anyway

  // Resolve params once per call (per-particle jitter applied in the loop).
  // Default direction is straight up (rising sparks/puffs read best).
  const dir = opts.dir;
  const ddx = dir && typeof dir.x === 'number' ? dir.x : 0;
  const ddy = dir && typeof dir.y === 'number' ? dir.y : 1;
  const ddz = dir && typeof dir.z === 'number' ? dir.z : 0;
  const spread = opts.spread != null ? opts.spread : def.spread;
  const speed = opts.speed != null ? opts.speed : def.speed;
  const ttl = opts.ttl != null ? opts.ttl : def.ttl;
  const size = opts.size != null ? opts.size : def.size;
  const grow = opts.grow != null ? opts.grow : (def.grow || 0);
  const alpha = opts.alpha != null ? opts.alpha : (def.alpha != null ? def.alpha : 1);
  const grav = opts.gravity != null ? opts.gravity : def.gravity;
  const drag = opts.drag != null ? opts.drag : def.drag;
  const pri = opts.priority != null ? opts.priority : def.priority;
  const spin = opts.spin != null ? opts.spin : 9;
  _c.setHex(opts.color != null ? opts.color : def.color);

  for (let k = 0; k < n; k++) {
    const i = acquireSlot(pool, pri);
    if (i < 0) break;
    const j = i * 3;
    pool.pos[j] = pos.x;
    pool.pos[j + 1] = pos.y;
    pool.pos[j + 2] = pos.z;
    sampleDir(ddx, ddy, ddz, spread);
    const sp = speed * (0.65 + Math.random() * 0.7); // +-35% energy jitter
    pool.vel[j] = _d.x * sp;
    pool.vel[j + 1] = _d.y * sp;
    pool.vel[j + 2] = _d.z * sp;
    pool.col[j] = _c.r; pool.col[j + 1] = _c.g; pool.col[j + 2] = _c.b;
    pool.rot[j] = Math.random() * Math.PI * 2;
    pool.rot[j + 1] = Math.random() * Math.PI * 2;
    pool.rot[j + 2] = Math.random() * Math.PI * 2;
    pool.spin[j] = (Math.random() - 0.5) * 2 * spin;
    pool.spin[j + 1] = (Math.random() - 0.5) * 2 * spin;
    pool.spin[j + 2] = (Math.random() - 0.5) * 2 * spin;
    pool.life[i] = 0;
    pool.ttl[i] = ttl * (0.8 + Math.random() * 0.4);
    pool.size[i] = size * (0.85 + Math.random() * 0.3);
    pool.grow[i] = grow;
    pool.alpha[i] = alpha;
    pool.drag[i] = drag;
    pool.grav[i] = grav;
    pool.pri[i] = pri;
  }

  // Spawn-time GPU mirrors: colors feed the point-sprite attribute directly,
  // instanceColor feeds the debris tint. Upload flags are cheap to re-set.
  if (kind === 'spark') sparkGeo.attributes.aColor.needsUpdate = true;
  else if (kind === 'debris' && debrisMesh && debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
  return n;
}

// --- simulation -------------------------------------------------------------

/** Shared physics: life, drag, gravity (scaled by CONFIG.gravity), integrate,
 *  tumble, expire. Runs per class so each pool stays a tight linear scan. */
function stepPool(pool, dt) {
  const g = CONFIG.gravity;
  const pos = pool.pos, vel = pool.vel;
  for (let i = 0; i < pool.cap; i++) {
    if (!pool.active[i]) continue;
    const j = i * 3;
    pool.life[i] += dt;
    if (pool.life[i] >= pool.ttl[i]) { releaseSlot(pool, i); continue; }
    const dr = Math.max(0, 1 - pool.drag[i] * dt);
    vel[j] *= dr;
    vel[j + 1] = vel[j + 1] * dr - g * pool.grav[i] * dt;
    vel[j + 2] *= dr;
    pos[j] += vel[j] * dt;
    pos[j + 1] += vel[j + 1] * dt;
    pos[j + 2] += vel[j + 2] * dt;
    pool.rot[j] += pool.spin[j] * dt;
    pool.rot[j + 1] += pool.spin[j + 1] * dt;
    pool.rot[j + 2] += pool.spin[j + 2] * dt;
  }
}

function syncSparks() {
  const n = pools.spark.cap;
  const life = pools.spark.life, ttl = pools.spark.ttl;
  const size = pools.spark.size, baseA = pools.spark.alpha, act = pools.spark.active;
  for (let i = 0; i < n; i++) {
    if (act[i]) {
      const k = life[i] / ttl[i];
      const f = 1 - k;
      // quadratic-ish fade reads as ember cooling; size stays constant
      sparkAlpha[i] = baseA[i] * f * Math.sqrt(f > 0 ? f : 0);
      sparkSize[i] = size[i];
    } else {
      sparkAlpha[i] = 0; // dead slots discard in the fragment shader
    }
  }
  sparkGeo.attributes.position.needsUpdate = true; // array IS pools.spark.pos
  sparkGeo.attributes.aSize.needsUpdate = true;
  sparkGeo.attributes.aAlpha.needsUpdate = true;
}

function syncDebris() {
  if (!debrisMesh) return;
  const pool = pools.debris;
  const pos = pool.pos, rot = pool.rot, size = pool.size, act = pool.active;
  for (let i = 0; i < pool.cap; i++) {
    if (!act[i]) continue;
    const j = i * 3;
    // NOTE: rot was already integrated in stepPool this frame. Distinct
    // scratches are mandatory here - compose() reads position and scale.
    _q.setFromEuler(_eu.set(rot[j], rot[j + 1], rot[j + 2]));
    _v3.set(pos[j], pos[j + 1], pos[j + 2]);
    _v3b.set(size[i], size[i], size[i]);
    _m4.compose(_v3, _q, _v3b);
    debrisMesh.setMatrixAt(i, _m4);
    debrisDirty = true;
  }
  if (debrisDirty) {
    debrisMesh.instanceMatrix.needsUpdate = true;
    debrisDirty = false;
  }
}

function syncBillboards(pool, entries, curve) {
  const life = pool.life, ttl = pool.ttl, size = pool.size;
  const grow = pool.grow, baseA = pool.alpha, act = pool.active;
  const pos = pool.pos;
  for (let i = 0; i < pool.cap; i++) {
    const e = entries[i];
    if (!act[i]) continue; // visibility handled at kill time
    const k = life[i] / ttl[i];
    e.sprite.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (curve === 'smoke') {
      // quick ramp-in, long linear fade-out; grows steadily (alpha-low by design)
      const fadeIn = k < 0.12 ? k / 0.12 : 1;
      const fadeOut = 1 - Math.max(0, k - 0.12) / 0.88;
      e.sprite.material.opacity = baseA[i] * fadeIn * fadeOut;
      e.sprite.scale.setScalar(size[i] * (1 + grow[i] * k));
    } else { // 'flash': hard pop, square falloff
      e.sprite.material.opacity = baseA[i] * (1 - k) * (1 - k);
      e.sprite.scale.setScalar(size[i] * (1 + 3 * k));
    }
  }
}

function syncRings() {
  const pool = pools.ring;
  const life = pool.life, ttl = pool.ttl, size = pool.size;
  const baseA = pool.alpha, act = pool.active;
  for (let i = 0; i < pool.cap; i++) {
    if (!act[i]) continue;
    const k = life[i] / ttl[i];
    const e = 1 - Math.pow(1 - k, 3); // easeOutCubic expansion
    rings[i].mesh.scale.setScalar(size[i] * (0.25 + 2.75 * e));
    rings[i].mesh.material.opacity = baseA[i] * (1 - k);
  }
}

// --- textures / builders ----------------------------------------------------

/** Soft radial blob on transparent canvas; stops shape smoke vs glow cores. */
function makeRadialTexture(stops) {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSparks() {
  const pool = pools.spark;
  sparkSize = new Float32Array(pool.cap);
  sparkAlpha = new Float32Array(pool.cap);
  sparkGeo = new THREE.BufferGeometry();
  // The position attribute WRAPS pool.pos and aColor WRAPS pool.col - physics
  // writes land straight in GPU-visible memory, no copy pass.
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(pool.pos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aColor', new THREE.BufferAttribute(pool.col, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aSize', new THREE.BufferAttribute(sparkSize, 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute('aAlpha', new THREE.BufferAttribute(sparkAlpha, 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6); // world-space slots
  sparkMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,               // additive embers never occlude targets
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      attribute vec3 aColor;
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 0.001);
        // perspective-sized with sane clamps so near sparks never flood pixels
        gl_PointSize = clamp(aSize * 340.0 / dist, 1.0, 56.0);
        vAlpha = aAlpha;
        vColor = aColor;
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying vec3 vColor;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0 || vAlpha < 0.012) discard;
        float a = vAlpha * (1.0 - r2) * (1.0 - r2); // soft round ember
        gl_FragColor = vec4(vColor, a);
      }`,
  });
  sparkPts = new THREE.Points(sparkGeo, sparkMat);
  sparkPts.frustumCulled = false; // bounds would go stale as slots recycle
  sparkPts.renderOrder = 22;
  sceneRef.add(sparkPts);
}

function buildDebris() {
  // Feature-detect: a broken/unavailable addon path must never crash boot.
  if (typeof THREE.InstancedMesh !== 'function') return;
  const pool = pools.debris;
  debrisGeo = new THREE.TetrahedronGeometry(0.07);
  debrisMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); // tinted per-instance
  debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, pool.cap);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.frustumCulled = false;
  // Start fully hidden (zero-scale) and allocate the instanceColor buffer.
  _m4.makeScale(0, 0, 0);
  for (let i = 0; i < pool.cap; i++) {
    debrisMesh.setMatrixAt(i, _m4);
    debrisMesh.setColorAt(i, _c.setHex(0xffffff));
  }
  debrisMesh.instanceMatrix.needsUpdate = true;
  if (debrisMesh.instanceColor) debrisMesh.instanceColor.needsUpdate = true;
  sceneRef.add(debrisMesh);
}

function buildSprites(cap, texture, blending, renderOrder, list) {
  for (let i = 0; i < cap; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthWrite: false,
      depthTest: true, // KEY readability choice: world depth still occludes us
      blending, opacity: 0,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.visible = false;
    sprite.renderOrder = renderOrder;
    sceneRef.add(sprite);
    list.push({ sprite, visibleFlag: false });
  }
}

function buildRings() {
  const pool = pools.ring;
  ringGeo = new THREE.RingGeometry(0.82, 1.0, 40);
  for (let i = 0; i < pool.cap; i++) {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2; // shockwave rings lie flat on the ground plane
    mesh.renderOrder = 24;
    mesh.visible = false;
    sceneRef.add(mesh);
    rings.push({ mesh, visibleFlag: false });
  }
}

// --- lifecycle --------------------------------------------------------------

/**
 * Build every pool + GPU backend and subscribe to quality changes. Idempotent
 * and safe to retry: without a scene it reports false and callers (update /
 * spawn paths) lazily re-attempt next frame, mirroring combat/damage.js.
 */
export function initVfxEngine() {
  if (inited) return true;
  if (!G.scene || typeof document === 'undefined') return false;
  inited = true;
  sceneRef = G.scene;

  refreshQuality();
  smokeTex = makeRadialTexture([
    [0, 'rgba(255,255,255,0.85)'],
    [0.55, 'rgba(255,255,255,0.32)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  glowTex = makeRadialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.3, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

  buildSparks();
  buildDebris();
  buildSprites(SMOKE_CAP, smokeTex, THREE.NormalBlending, 4, smokes);
  buildSprites(FLASH_CAP, glowTex, THREE.AdditiveBlending, 26, flashes);
  buildRings();

  offSettings = bus.on('settingsChanged', (p) => {
    if (!p || p.key === 'quality') refreshQuality();
  });
  return true;
}

/** Advance every pool. Lazy-boots the engine so call order never matters. */
export function updateVfx(dt) {
  if (!inited) initVfxEngine();
  if (!inited || !(dt > 0)) return;
  dt = Math.min(dt, 0.1); // tab-return spikes must not teleport particles

  stepPool(pools.spark, dt); syncSparks();
  stepPool(pools.debris, dt); syncDebris();
  stepPool(pools.smoke, dt); syncBillboards(pools.smoke, smokes, 'smoke');
  stepPool(pools.flash, dt); syncBillboards(pools.flash, flashes, 'flash');
  stepPool(pools.ring, dt); syncRings();

  // Visibility flips are batched here (not in releaseSlot) so the physics scan
  // stays branch-light; flags avoid touching three.js objects redundantly.
  hideInactive(pools.smoke, smokes, HIDE_SPRITE);
  hideInactive(pools.flash, flashes, HIDE_SPRITE);
  hideInactive(pools.ring, rings, HIDE_MESH);
  showActive(pools.smoke, smokes, SHOW_SPRITE);
  showActive(pools.flash, flashes, SHOW_SPRITE);
  showActive(pools.ring, rings, SHOW_MESH);
}

// Module-scope toggles: hoisted so updateVfx allocates zero closures per frame.
const HIDE_SPRITE = (e) => { e.sprite.visible = false; };
const SHOW_SPRITE = (e) => { e.sprite.visible = true; };
const HIDE_MESH = (e) => { e.mesh.visible = false; };
const SHOW_MESH = (e) => { e.mesh.visible = true; };

function hideInactive(pool, entries, hideFn) {
  for (let i = 0; i < pool.cap; i++) {
    if (!pool.active[i] && entries[i].visibleFlag) {
      entries[i].visibleFlag = false;
      hideFn(entries[i]);
    }
  }
}

function showActive(pool, entries, showFn) {
  for (let i = 0; i < pool.cap; i++) {
    if (pool.active[i] && !entries[i].visibleFlag) {
      entries[i].visibleFlag = true;
      showFn(entries[i]);
    }
  }
}

/** Free every GPU resource this engine owns (debug / teardown). */
export function disposeVfx() {
  if (!inited) return;
  if (offSettings) { offSettings(); offSettings = null; }

  if (sparkPts) { sceneRef.remove(sparkPts); sparkPts = null; }
  if (sparkGeo) { sparkGeo.dispose(); sparkGeo = null; }
  if (sparkMat) { sparkMat.dispose(); sparkMat = null; }
  sparkSize = null;
  sparkAlpha = null;

  if (debrisMesh) { sceneRef.remove(debrisMesh); debrisMesh.dispose(); debrisMesh = null; }
  if (debrisGeo) { debrisGeo.dispose(); debrisGeo = null; }
  if (debrisMat) { debrisMat.dispose(); debrisMat = null; }

  for (const e of smokes) { sceneRef.remove(e.sprite); e.sprite.material.dispose(); }
  for (const e of flashes) { sceneRef.remove(e.sprite); e.sprite.material.dispose(); }
  smokes = []; flashes = [];
  for (const e of rings) { sceneRef.remove(e.mesh); e.mesh.material.dispose(); }
  rings = [];
  if (ringGeo) { ringGeo.dispose(); ringGeo = null; }
  if (smokeTex) { smokeTex.dispose(); smokeTex = null; }
  if (glowTex) { glowTex.dispose(); glowTex = null; }

  for (const key of Object.keys(pools)) {
    const pool = pools[key];
    pool.count = 0;
    pool.cursor = 0;
    pool.active.fill(0);
    pool.pos.fill(0);
  }
  totalActive = 0;
  sceneRef = null;
  inited = false;
}

/** Perf-HUD contract getter ({active, budget} top level, per-class detail). */
export function getVfxStats() {
  return {
    active: totalActive,
    budget: MAX_ACTIVE,
    sparks: { active: pools.spark.count, cap: SPARK_CAP },
    debris: { active: pools.debris.count, cap: DEBRIS_CAP, instanced: !!debrisMesh },
    smoke: { active: pools.smoke.count, cap: SMOKE_CAP },
    flash: { active: pools.flash.count, cap: FLASH_CAP },
    ring: { active: pools.ring.count, cap: RING_CAP },
    qualityMul,
  };
}
