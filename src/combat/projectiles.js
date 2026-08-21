// IRONWILD - arrow projectiles: pooling, floaty ballistics, hit detection.
// Arrows arc under reduced gravity, sweep-test against machine weak points
// (first) then body spheres, stick into terrain, and can be walked over to
// silently recover. All entities come from a fixed pool - no per-frame allocs.
// v2: fire arrows (x0.8 impact, applies burn), fading LineSegments trails,
// camShake on weak-point hits.
// Wave F: every hit emits the 'impact' material contract (metal/soil/water -
// props are not arrow-collidable yet, so wood/stone never classify here), a
// per-arrow `resolved` flag guarantees one hit resolution max, and damage
// rules/severity come from combat/damage.js (COMPONENT_RULES + tiers).

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { clamp, lerp } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';
import { applyBurn, BURN_DURATION } from './status.js';
import { componentRule, COMPONENT_RULES, checkDamageTiers } from './damage.js';

const MAX_ARROWS = 40;
const STUCK_LIFE = 25;          // seconds a stuck arrow persists
const FADE_AT = 24;             // start fading one second before removal
const COLLECT_DIST_SQ = 1.8 * 1.8;
const BOUND_SQ = (CONFIG.worldSize * 0.5) * (CONFIG.worldSize * 0.5);
const FIRE_DMG_MULT = 0.8;      // fire arrows trade impact for burn
const TRAIL_PTS = 6;            // ribbon history points per arrow
const TRAIL_SEGS = TRAIL_PTS - 1;
const TRAIL_LINGER = 0.3;       // s of fade-out after the arrow stops
const TRAIL_COLOR_STD = 0x9fd8e8;
const TRAIL_COLOR_FIRE = 0xff9a4d;
const FLETCH_COLOR_STD = 0x59e3ff;
const FLETCH_COLOR_FIRE = 0xff8c3b;
const FLETCH_EMISSIVE_STD = 0x14495c;
const FLETCH_EMISSIVE_FIRE = 0x6b2c0e;

// Scratch vectors declared once - reused by every hot-loop call.
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _dirN = new THREE.Vector3();
const _step = new THREE.Vector3();
const _stick = new THREE.Vector3();
const _imp = new THREE.Vector3(); // 'impact' event position scratch

let pool = null; // all arrow records (mirrored into G.arrows)
let rr = 0;      // round-robin cursor for slot selection

/** Build one arrow: wood shaft + tip, three cyan fletching fins. Points along +Y. */
function buildArrowMesh() {
  const wood = new THREE.MeshStandardMaterial({
    color: 0x6b4a2f, roughness: 0.85, metalness: 0.05,
    flatShading: true, transparent: true,
  });
  const fletch = new THREE.MeshStandardMaterial({
    color: 0x59e3ff, emissive: 0x14495c, roughness: 0.6,
    flatShading: true, transparent: true, side: THREE.DoubleSide,
  });
  const group = new THREE.Group();

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.75, 6), wood);
  group.add(shaft);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 6), wood);
  tip.position.y = 0.42;
  group.add(tip);

  for (let i = 0; i < 3; i++) {
    const holder = new THREE.Group();
    holder.rotation.y = (i / 3) * Math.PI * 2;
    const fin = new THREE.Mesh(new THREE.PlaneGeometry(0.085, 0.17), fletch);
    fin.position.set(0.035, -0.27, 0);
    holder.add(fin);
    group.add(holder);
  }
  return { group, wood, fletch };
}

/** Fading line ribbon trailing one arrow: ring buffer of past positions
 *  rewritten into a LineSegments buffer in place. Brightness falls toward the
 *  tail via a static grayscale color attribute (black vanishes under additive
 *  blending); material.color tints it per arrow type. */
function makeTrail() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(TRAIL_SEGS * 2 * 3), 3)
      .setUsage(THREE.DynamicDrawUsage),
  );
  const colArr = new Float32Array(TRAIL_SEGS * 2 * 3);
  for (let i = 0; i < TRAIL_SEGS; i++) {
    const b = (1 - i / TRAIL_SEGS) ** 2; // head bright -> tail near-black
    for (let v = 0; v < 2; v++) {
      const o = i * 6 + v * 3;
      colArr[o] = b; colArr[o + 1] = b; colArr[o + 2] = b;
    }
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const line = new THREE.LineSegments(geo, mat);
  line.frustumCulled = false; // world-space positions, bounds never updated
  line.visible = false;
  return {
    line, mat,
    hist: new Float32Array(TRAIL_PTS * 3), // ring buffer of past positions
    head: 0,
    lingerT: -1, // >=0 while fading out after the arrow stopped
  };
}

function resetTrail(a, pos) {
  const t = a.trail;
  for (let i = 0; i < TRAIL_PTS; i++) {
    t.hist[i * 3] = pos.x;
    t.hist[i * 3 + 1] = pos.y;
    t.hist[i * 3 + 2] = pos.z;
  }
  t.head = 0;
  const arr = t.line.geometry.attributes.position.array;
  for (let i = 0; i < TRAIL_PTS; i++) {
    arr[i * 3] = pos.x; arr[i * 3 + 1] = pos.y; arr[i * 3 + 2] = pos.z;
  }
  t.line.geometry.attributes.position.needsUpdate = true;
  t.mat.opacity = 1;
  t.lingerT = -1;
  t.line.visible = true;
}

/** Record the current arrow position as the newest trail point. */
function pushTrail(a) {
  const t = a.trail;
  t.head = (t.head + 1) % TRAIL_PTS;
  const h = t.head * 3;
  t.hist[h] = a.pos.x; t.hist[h + 1] = a.pos.y; t.hist[h + 2] = a.pos.z;
  const arr = t.line.geometry.attributes.position.array;
  for (let i = 0; i < TRAIL_SEGS; i++) {
    const ia = ((t.head - i + TRAIL_PTS) % TRAIL_PTS) * 3;     // newer end
    const ib = ((t.head - i - 1 + TRAIL_PTS) % TRAIL_PTS) * 3; // older end
    const o = i * 6;
    arr[o] = t.hist[ia]; arr[o + 1] = t.hist[ia + 1]; arr[o + 2] = t.hist[ia + 2];
    arr[o + 3] = t.hist[ib]; arr[o + 4] = t.hist[ib + 1]; arr[o + 5] = t.hist[ib + 2];
  }
  t.line.geometry.attributes.position.needsUpdate = true;
}

/** Freeze + fade the ribbon once its arrow has stopped flying. */
function updateTrailFade(a, dt) {
  const t = a.trail;
  if (t.lingerT < 0 || (a.alive && a.stuckT < 0)) return;
  t.lingerT += dt;
  const k = clamp(t.lingerT / TRAIL_LINGER, 0, 1);
  t.mat.opacity = 1 - k;
  if (k >= 1) {
    t.lingerT = -1;
    t.line.visible = false;
  }
}

/** Lazily build the pool once G.scene exists. */
function ensurePool() {
  if (pool || !G.scene) return;
  pool = [];
  for (let i = 0; i < MAX_ARROWS; i++) {
    const { group, wood, fletch } = buildArrowMesh();
    group.visible = false;
    G.scene.add(group);
    const trail = makeTrail();
    G.scene.add(trail.line);
    pool.push({
      mesh: group,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      damage: 0,
      alive: false,
      stuckT: -1, // <0 while flying, >=0 counts seconds since impact
      resolved: false, // Wave F: set on first hit resolution, one hit per arrow
      fire: false,   // v2: fire arrow (burn on hit)
      woodMat: wood,
      fletchMat: fletch,
      trail,
    });
  }
  G.arrows.length = 0;
  for (let i = 0; i < pool.length; i++) G.arrows.push(pool[i]);
}

/** Free slot first, then a flying arrow, then any slot (worst case reclaims stuck). */
function pickSlot() {
  for (let i = 0; i < MAX_ARROWS; i++) {
    const c = pool[(rr + i) % MAX_ARROWS];
    if (!c.alive) { rr = (rr + i + 1) % MAX_ARROWS; return c; }
  }
  for (let i = 0; i < MAX_ARROWS; i++) {
    const c = pool[(rr + i) % MAX_ARROWS];
    if (c.stuckT < 0) { rr = (rr + i + 1) % MAX_ARROWS; return c; }
  }
  const c = pool[rr];
  rr = (rr + 1) % MAX_ARROWS;
  return c;
}

function deactivate(a) {
  a.alive = false;
  a.stuckT = -1;
  a.resolved = false; // slot is clean for whoever reclaims it next
  a.mesh.visible = false;
  if (a.trail.lingerT < 0 && a.trail.line.visible) a.trail.lingerT = 0; // fade the ribbon out
}

/** Closest point on segment p0->p1 vs sphere; result point left in _closest. */
function segmentHitsSphere(p0, p1, center, radius) {
  _seg.subVectors(p1, p0);
  const lenSq = _seg.lengthSq();
  let t = 0;
  if (lenSq > 1e-8) t = clamp(_seg.dot(_v3.subVectors(center, p0)) / lenSq, 0, 1);
  _closest.copy(p0).addScaledVector(_seg, t);
  return _closest.distanceToSquared(center) <= radius * radius;
}

/** Apply damage + events for a confirmed hit, then kill the arrow. */
function resolveHit(a, machine, wp, center, radius) {
  if (a.resolved) return; // one-hit guarantee: an arrow never resolves twice
  a.resolved = true;
  const fire = !!a.fire;
  const rule = componentRule(machine, wp || null, null);
  const dmg =
    a.damage *
    (wp ? (wp.multiplier ?? COMPONENT_RULES.weakpoint.multiplier) * (G.skills.hunterKiller ? 1.3 : 1) : 1) *
    (fire ? FIRE_DMG_MULT : 1);
  // Project the segment closest-point outward onto the sphere surface for FX.
  _hitPoint.copy(_closest).sub(center);
  const l = _hitPoint.length();
  if (l > 1e-5) _hitPoint.multiplyScalar(radius / l);
  _hitPoint.add(center);
  const pt = _hitPoint.clone(); // single heap alloc per hit, shared by hit()+FX
  const landed = machine.hit(dmg, pt, wp || null) !== false;
  const spd = clamp(a.vel.length() / CONFIG.arrowMaxPowerSpeed, 0, 1); // 0..1 impact speed
  const dir = _dirN.copy(a.vel).normalize().clone(); // travel line at contact
  if (!landed) {
    // Deflected hits (e.g. the bulwark's front armor) deal zero damage and get
    // only their own deflect FX plus a light metal 'impact' ping - no damage
    // number, hit marker or flesh sound.
    bus.emit('impact', { pos: pt, material: 'metal', dir, strength: 0.3 + 0.3 * spd });
    deactivate(a);
    return;
  }
  bus.emit('impact', {
    pos: pt,
    material: 'metal',
    dir,
    // Weak-point contacts read harder: rule severity (weakpoint 1.0 vs body
    // 0.55) plus a flat bonus on top of the arrival-speed ramp.
    strength: lerp(0.55, 1.0, spd) * rule.fxSeverity + (wp ? 0.25 : 0),
  });
  // Deflection already returned above, so igniting here can never bypass armor
  // identity; the rule carries that immunity as data for future classes.
  if (fire && machine.alive && rule.burnInteraction !== 'immune') {
    applyBurn(machine, BURN_DURATION * (0.35 + 0.65 * (a.power ?? 1))); // weak or body hits ignite
  }
  bus.emit('machineHit', {
    machine,
    point: pt,
    damage: dmg,
    weak: !!wp,
    partName: wp ? wp.name : null,
    fire, // v2 additive field: damage.js tints sparks orange
  });
  bus.emit('hitMarker', { weak: !!wp });
  if (wp) bus.emit('camShake', { amp: 0.35 }); // weak-point impacts jolt the camera
  checkDamageTiers(machine); // Wave F: 'machineDamaged' at the 50%/25% crossings
  deactivate(a);
}

/**
 * Classify a terrain/water landing and emit the 'impact' contract event.
 * Water wins whenever the lakebed sits below CONFIG.waterLevel; the splash
 * point is clamped to the surface even though the arrow itself sticks in the
 * shallows (kept collectable - v2 behavior preserved).
 */
function emitSurfaceImpact(a, groundY) {
  const water = groundY < CONFIG.waterLevel;
  const spd = clamp(a.vel.length() / CONFIG.arrowMaxPowerSpeed, 0, 1);
  _imp.set(a.pos.x, water ? CONFIG.waterLevel : a.pos.y, a.pos.z);
  bus.emit('impact', {
    pos: _imp.clone(),
    material: water ? 'water' : 'soil',
    dir: _dirN.copy(a.vel).normalize().clone(),
    strength: water ? lerp(0.3, 0.7, spd) : lerp(0.25, 0.6, spd),
  });
}

/** Sweep one flight substep against every alive machine: weak points, then body. */
function collideMachines(a, p0, p1) {
  for (let mi = 0; mi < G.machines.length; mi++) {
    const m = G.machines[mi];
    if (!m.alive) continue;
    const wps = m.weakPoints;
    if (wps) {
      for (let wi = 0; wi < wps.length; wi++) {
        const wp = wps[wi];
        if (wp.broken || !wp.mesh) continue; // broken part -> falls through to body
        wp.mesh.getWorldPosition(_v1);
        if (segmentHitsSphere(p0, p1, _v1, wp.radius)) {
          resolveHit(a, m, wp, _v1, wp.radius);
          return true;
        }
      }
    }
    const bods = m.bodySpheres;
    if (bods) {
      for (let bi = 0; bi < bods.length; bi++) {
        const bs = bods[bi];
        _v1.copy(bs.localPos);
        m.group.localToWorld(_v1);
        if (segmentHitsSphere(p0, p1, _v1, bs.radius)) {
          resolveHit(a, m, null, _v1, bs.radius);
          return true;
        }
      }
    }
  }
  return false;
}

/** Replant a landed arrow: mostly upright, leaning slightly along travel. */
function stickArrow(a, groundY) {
  a.stuckT = 0;
  _stick.set(a.vel.x, 0, a.vel.z);
  if (_stick.lengthSq() < 1e-6) _stick.set(0, 0, 1);
  _stick.normalize().multiplyScalar(0.22);
  _stick.y = 1;
  _stick.normalize();
  a.mesh.quaternion.setFromUnitVectors(Y_AXIS, _stick);
  a.pos.y = groundY + 0.16; // tail buried, tip proud of the dirt
  a.mesh.position.copy(a.pos);
  if (a.trail.lingerT < 0) a.trail.lingerT = 0; // let the ribbon fade in place
}

function updateFlying(a, dt) {
  a.vel.y -= CONFIG.gravity * dt * 0.55; // floaty arc
  const dist = a.vel.length() * dt;
  const steps = dist > 0.5 ? clamp(Math.ceil(dist / 0.5), 2, 3) : 1;
  const subDt = dt / steps;
  _step.copy(a.vel).multiplyScalar(subDt);
  for (let s = 0; s < steps; s++) {
    _v2.copy(a.pos).add(_step); // segment end; pos only advances once clear
    if (collideMachines(a, a.pos, _v2)) return;
    a.pos.copy(_v2);
    const gy = heightAt(a.pos.x, a.pos.z);
    if (a.pos.y <= gy) {
      stickArrow(a, gy);
      emitSurfaceImpact(a, gy); // Wave F: 'soil'/'water' impact contract event
      return;
    }
  }
  if (a.pos.x * a.pos.x + a.pos.z * a.pos.z > BOUND_SQ || a.pos.y < -40) {
    deactivate(a);
    return;
  }
  _dirN.copy(a.vel).normalize();
  a.mesh.quaternion.setFromUnitVectors(Y_AXIS, _dirN);
  a.mesh.position.copy(a.pos);
  pushTrail(a);
}

function updateStuck(a, dt) {
  a.stuckT += dt;
  // Silent auto-collect: walking over a spent arrow refunds it (no notify).
  if (
    G.player && !G.player.dead &&
    G.inventory.arrows < G.inventory.maxArrows &&
    a.pos.distanceToSquared(G.player.pos) < COLLECT_DIST_SQ
  ) {
    G.inventory.arrows += 1;
    deactivate(a);
    return;
  }
  if (a.stuckT >= FADE_AT) {
    const k = clamp((a.stuckT - FADE_AT) / (STUCK_LIFE - FADE_AT), 0, 1);
    a.woodMat.opacity = 1 - k;
    a.fletchMat.opacity = 1 - k;
    if (a.stuckT >= STUCK_LIFE) deactivate(a);
  }
}

/** Fire one arrow. Called by player/bow.js on release. `fire` selects the
 *  fire-arrow variant (orange fletching/trail, x0.8 impact + burn on hit). */
export function spawnArrow({ origin, dir, speed, damage, fire = false, power = 1 }) {
  ensurePool();
  if (!pool || !origin || !dir) return null;
  const a = pickSlot();
  a.pos.copy(origin);
  a.vel.copy(dir).normalize().multiplyScalar(speed);
  a.damage = damage;
  a.alive = true;
  a.stuckT = -1;
  a.resolved = false; // fresh flight, one resolution available
  a.fire = fire;
  a.power = power;
  a.woodMat.opacity = 1;
  a.fletchMat.opacity = 1;
  a.fletchMat.color.setHex(fire ? FLETCH_COLOR_FIRE : FLETCH_COLOR_STD);
  a.fletchMat.emissive.setHex(fire ? FLETCH_EMISSIVE_FIRE : FLETCH_EMISSIVE_STD);
  _dirN.copy(a.vel).normalize();
  a.mesh.quaternion.setFromUnitVectors(Y_AXIS, _dirN);
  a.mesh.position.copy(a.pos);
  a.mesh.visible = true;
  resetTrail(a, origin);
  a.trail.mat.color.setHex(fire ? TRAIL_COLOR_FIRE : TRAIL_COLOR_STD);
  return a;
}

/** Frame update; dt is already time-scaled by main.js. */
export function updateProjectiles(dt) {
  ensurePool();
  if (!pool || !(dt > 0)) return;
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i];
    if (a.alive) {
      if (a.stuckT >= 0) updateStuck(a, dt);
      else updateFlying(a, dt);
    }
    updateTrailFade(a, dt);
  }
}
