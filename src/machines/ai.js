// IRONWILD - machine AI: perception, FSM (dormant/patrol/suspicious/attack),
// per-roster attacks, hearing, spawning and world population.
// v2: duskwing aerial dive / bulwark roll+deflect / peaceful vantage loop,
// part-behavioral effects, alpha variants, corpse harvest, G.threat,
// kill streaks and focus-scan detection.
// v3: mirefang lake ambusher + monarch world-boss scripts, G.bossNear,
// timed anchor respawns and bramblehorn herd stampedes.
// v5: perception/blackboard strangler layer (see perception.js) feeds the
// FSMs instead of replacing them - awareness-gated aggro, seek tier, local
// steering + stuck recovery, far-machine LOD ticking, per-machine debug.

import * as THREE from 'three';
import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { Input } from '../core/input.js';
import { clamp, lerp, damp, makeRng, randRange } from '../core/utils.js';
import { heightAt } from '../world/terrain.js';
import { sfx } from '../audio/audio.js';
import { attachMachineAnimator } from '../anim/machineAnim.js'; // wave E lifecycle wiring
import {
  createMachine, applyAlphaVariant, updateDeflectFX,
  showHarvestRing, hideHarvestRing, CARCASS_LIFE,
} from './machines.js';
import { createPerception, AWARE_AGGRO } from './perception.js';

// ----------------------------------------------------------------- tuning --

// v5: the flat 45u sight range + cone moved to perception.js's per-type
// VISION table (tighter ranges are the point of the layer).
const WAKE_DIST = 18;      // dormant machines wake when the player is this close
const LEAVE_DIST = 70;     // aggro drops when the player gets this far away
const WALK_SPEED = 2.2;    // patrol speed
const SUSPICIOUS_SPEED = 1.6;
const SUSPICIOUS_TIMEOUT = 6;

const STATS = {
  skitter: { run: 6.0, turn: 5.0 },
  bramblehorn: { run: 8.5, turn: 4.0 },
  rendclaw: { run: 7.5, turn: 5.5 },
  ironmaw: { run: 3.2, turn: 2.2 },
  duskwing: { run: 9.0, turn: 3.5 },
  bulwark: { run: 3.0, turn: 2.4 },
  vantage: { run: 1.7, turn: 2.0 },
  mirefang: { run: 3.2, turn: 2.6 }, // sluggish haul-out chase on land
  monarch: { run: 2.4, turn: 1.2 },  // ponderous border walk, never sprints
};

// v2: duskwing flight / dive
const DUSKWING_CRUISE = 12;      // circle altitude above the terrain
const DUSKWING_ORBIT = 9;        // circling radius around the anchor
const DUSKWING_DIVE_DMG = 18;
const DUSKWING_STUN = 2.5;       // grounded + stunned after each dive
const DUSKWING_CLIMB_LOCK = 6;   // must climb back up this long before diving
const DUSKWING_TELEGRAPH = 0.85; // shadow-circle grow time
const DUSKWING_WADE_RADII = [8, 16, 24]; // wade probe rings - widened when all-wet

// v2: bulwark attacks
const BULWARK_ROLL_DMG = 22;
const BULWARK_ROLL_CD = 7;
const BULWARK_CRUSH_DMG = 14;

// v2: vantage focus scanning
const SCAN_COOLDOWN = 30;
const SCAN_RANGE = 70;
const SCAN_COS = Math.cos((14 * Math.PI) / 360); // ~7 deg aim cone

// v2: corpse harvest
const HARVEST_RANGE_SQ = 2.5 * 2.5;
const HARVEST_TIME = 1.2;
const CARCASS_PROMPT = '[Hold E] Harvest carcass';

// v2: threat + kill streak
const THREAT_DIST = 40;
const THREAT_DIST_SQ = THREAT_DIST * THREAT_DIST;
const KILL_STREAK_WINDOW = 8;

// v3: population ceiling - the mirefang pair + monarch need 3 slots above the
// v2 layout's 14; kept local so core tuning stays untouched.
const MACH_CAP = CONFIG.maxMachines + 3;

// v3: mirefang lake ambusher
const MIRE_STRIKE_DIST = 14; // lurking strike range against swimmers
const MIRE_LUNGE_DMG = 20;
const MIRE_DRAG_DMG = 6;     // per drag bite
const MIRE_DRAG_TIME = 1.3;  // death-roll duration after the lunge connects
const MIRE_SWIM = 6.0;       // open-water pursuit speed
const MIRE_HAULOUT = 18;     // how far from its lair it will crawl onto land

// v3: monarch world-boss
const MONARCH_STOMP_RANGE = 6;   // player distance that provokes the stomp
const MONARCH_STOMP_R = 4;       // slam AOE radius
const MONARCH_STOMP_DMG = 35;
const MONARCH_STOMP_TELE = 0.8;  // foot-raise telegraph
const MONARCH_STOMP_CD = 4.5;
const MONARCH_TAIL_DMG = 25;
const MONARCH_TAIL_REACH = 7.5;
const MONARCH_TAIL_CD = 5;
const MONARCH_BEHIND_TIME = 2;   // seconds loitering behind before the swipe
const MONARCH_ENRAGE_MUL = 1.3;  // walk-speed multiplier per enrage step
const BOSS_NEAR_DIST = 80;       // G.bossNear radius
const BOSS_NEAR_DIST_SQ = BOSS_NEAR_DIST * BOSS_NEAR_DIST;
const RESPAWN_AFTER = 90;        // dead non-alpha machines, seconds
const RESPAWN_AFTER_ALPHA = 240; // alpha variants take longer

// v5: local steering / stuck recovery (applyLocalSteering below)
const STEER_SEP_DIST = 4;        // separation radius between alive machines
const STEER_BORDER_BAND = 10;    // soft inward push begins this far inside the hard border
const STUCK_WINDOW = 1.5;        // seconds between displacement audits
const STUCK_MIN_MOVE = 0.3;      // less XZ travel than this counts as wedged
const STUCK_REANCHOR_T = 4;      // seconds of homeward pull after repeated wedges

// v5: far-machine LOD (>90u): behavior logic at <=10Hz on accumulated dt
const LOD_INTERVAL = 0.1;
const LOD_DIST = 90;
const LOD_DIST_SQ = LOD_DIST * LOD_DIST;

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _bv = new THREE.Vector3();

// -------------------------------------------------- v5: perception layer ---
// One blackboard instance serves the roster. Created lazily so both boot
// orders (populateWorld first OR updateMachines first) work; module-level
// null until then lets the machineDied hook no-op pre-boot.

let perception = null;

function ensurePerception() {
  if (!perception) perception = createPerception();
  return perception;
}

// drop stale blackboard data when a machine dies (respawns build fresh ones)
bus.on('machineDied', ({ machine }) => {
  if (perception) perception.forgetMachine(machine);
});

/** Full-awareness read replacing the old per-frame canSeePlayer -> enterAttack
 *  trigger: awareness >= AWARE_AGGRO means exactly what "saw the player" used
 *  to, just reached over a few think ticks instead of instantly. */
function perceptionSighted(m) {
  if (!perception) return false;
  return perception.getBlackboard(m).awareness >= AWARE_AGGRO;
}

/** Consume-and-clear seek hint (edge-triggered by perception.js). Null when
 *  nothing new - callers redirect patrol/suspicious toward the returned point. */
function takeSeekHint(m) {
  return perception ? perception.takeSeekHint(m) : null;
}

// ------------------------------------------------------- v5: debug mirror --
// m.debug is dev/HUD-facing only: allocated on transitions, field-mutated per
// tick so steady-state costs zero garbage. peekBlackboard avoids creating
// boards for vantage/dormant machines just to display zeros.

function noteDebug(m, reason) {
  const bb = perception ? perception.peekBlackboard(m) : null;
  m.debug = {
    state: m._ai ? m._ai.state : '-',
    targetDist: Math.round(distToPlayer(m)),
    awareness: bb ? Math.round(bb.awareness * 100) / 100 : 0,
    lastTransition: G.elapsed,
    reason,
    stuckCount: m._ai && m._ai._steer ? m._ai._steer.wedgeStreak : 0,
  };
}

function refreshDebug(m) {
  const d = m.debug;
  if (!d) return;
  const bb = perception ? perception.peekBlackboard(m) : null;
  d.state = m._ai ? m._ai.state : '-';
  d.targetDist = Math.round(distToPlayer(m));
  d.awareness = bb ? Math.round(bb.awareness * 100) / 100 : 0;
  d.stuckCount = m._ai && m._ai._steer ? m._ai._steer.wedgeStreak : 0;
}

// ------------------------------------------------------------- AI state ----

function initAI(m, idx) {
  const rng = makeRng((CONFIG.seed + idx * 1013904223) >>> 0);
  m._ai = {
    rng,
    state: 'dormant',   // dormant | patrol | suspicious | attack
    waypoints: [],
    wpIndex: 0,
    waitT: 0,
    stateT: 0,
    target: new THREE.Vector3(), // investigation point (suspicious)
    atk: null,          // attack sub-phase
    phaseT: 0,
    cd: randRange(rng, 1, 2),      // melee/charge cooldown
    boltCd: 0,                      // ironmaw ranged cooldown
    strafeDir: rng() < 0.5 ? 1 : -1,
    strafeT: 0,
    // skitter leap
    leapStart: new THREE.Vector3(),
    leapEnd: new THREE.Vector3(),
    leapU: 0,
    leapHit: false,
    // rendclaw combo / bramblehorn kick flag reuse
    comboStep: 0,
    swipeSide: 1,
    dashHit: false,
    // ironmaw charge / bulwark roll
    dashDir: new THREE.Vector3(),
    rollCd: 0,
    // v2: skitter optic-broken erratic wander
    wanderYaw: 0,
    jitterT: 0,
    // v2: duskwing flight
    anchor: new THREE.Vector3(m.group.position.x, 0, m.group.position.z),
    homeX: m.group.position.x, // immutable spawn roost - respawns read this,
    homeZ: m.group.position.z, // not anchor (duskwing drift/aggro reassigns it)
    anchorT: 0,
    circleAng: rng() * Math.PI * 2,
    diveTarget: new THREE.Vector3(),
    diveStart: new THREE.Vector3(),
    diveU: 0,
    grounded: false, // permanent (broken wing)
    crashing: false, // falling out of the sky after a wing break
    climbT: 0,
    // v2: vantage scan cooldown
    scanCd: 0,
    // v3: mirefang / monarch script fields
    enrageStep: 0,      // monarch: enrage thresholds consumed
    roarT: 0,           // monarch: enrage bellow timer
    behindT: 0,         // monarch: how long the player has loitered behind
    tailCd: 0,          // monarch: tail swipe cooldown
    dragTick: 0,        // mirefang: death-roll bite interval
    lungeDur: 0.5,      // mirefang: locked lunge travel time
    teleMesh: null,     // monarch: stomp telegraph ring (owned here, not dispose()'d)
    teleMat: null,
  };
}

function makeWaypoints(m) {
  if (m.type === 'vantage') return makeVantageLoop(m);
  const rng = m._ai.rng;
  const pts = [];
  const n = 3 + Math.floor(rng() * 3); // 3-5 waypoints
  const p = m.group.position;
  for (let i = 0; i < n; i++) {
    let wx = p.x;
    let wz = p.z;
    for (let t = 0; t < 8; t++) {
      const ang = rng() * Math.PI * 2;
      const r = randRange(rng, 12, 25);
      const cx = p.x + Math.cos(ang) * r;
      const cz = p.z + Math.sin(ang) * r;
      if (inBounds(cx, cz) && heightAt(cx, cz) > CONFIG.waterLevel + 0.3) {
        wx = cx;
        wz = cz;
        break;
      }
    }
    pts.push(new THREE.Vector3(wx, 0, wz));
  }
  return pts;
}

/** Vantage fixed patrol: one large ellipse loop walked forever. */
function makeVantageLoop(m) {
  const rng = m._ai.rng;
  const p = m.group.position;
  const n = 7;
  const baseR = randRange(rng, 28, 42);
  const ang0 = rng() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = ang0 + (i / n) * Math.PI * 2;
    let r = baseR * randRange(rng, 0.85, 1.15);
    let wx = p.x + Math.cos(ang) * r;
    let wz = p.z + Math.sin(ang) * r;
    for (let t = 0; t < 6 && !loopPointOk(wx, wz); t++) {
      r *= 0.7; // shrink toward the anchor until the point is legal
      wx = p.x + Math.cos(ang) * r;
      wz = p.z + Math.sin(ang) * r;
    }
    if (!loopPointOk(wx, wz)) {
      wx = p.x;
      wz = p.z;
    }
    pts.push(new THREE.Vector3(wx, 0, wz));
  }
  return pts;
}

function loopPointOk(x, z) {
  return Math.hypot(x, z) < CONFIG.playRadius - 12 && heightAt(x, z) > CONFIG.waterLevel + 0.3;
}

// ------------------------------------------------------------ locomotion --

function inBounds(x, z) {
  return Math.hypot(x, z) < CONFIG.playRadius - 8;
}

/** Water or world-border ahead? */
function blockedAt(x, z) {
  if (Math.hypot(x, z) > CONFIG.playRadius - 6) return true;
  return heightAt(x, z) < CONFIG.waterLevel + 0.2;
}

/** Turn yaw toward (tx, tz); returns remaining angular error in radians. */
function turnToward(m, tx, tz, rate, dt) {
  const dx = tx - m.group.position.x;
  const dz = tz - m.group.position.z;
  const want = Math.atan2(dx, dz); // forward is +Z
  let d = want - m.group.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  m.group.rotation.y += clamp(d, -rate * dt, rate * dt);
  return Math.abs(d);
}

function advance(m, speed, dt) {
  const yaw = m.group.rotation.y;
  const nx = m.group.position.x + Math.sin(yaw) * speed * dt;
  const nz = m.group.position.z + Math.cos(yaw) * speed * dt;
  if (blockedAt(nx, nz)) return false;
  m.group.position.x = nx;
  m.group.position.z = nz;
  m.moveSpeed = speed;
  return true;
}

function retreat(m, speed, dt) {
  const yaw = m.group.rotation.y;
  const nx = m.group.position.x - Math.sin(yaw) * speed * dt;
  const nz = m.group.position.z - Math.cos(yaw) * speed * dt;
  if (blockedAt(nx, nz)) return false;
  m.group.position.x = nx;
  m.group.position.z = nz;
  m.moveSpeed = speed;
  return true;
}

/** Advance with water/border avoidance: probe ahead, detour sideways if blocked. */
function advanceAvoid(m, speed, dt) {
  applyLocalSteering(m, dt); // v5: slope/separation/border deflect before the probe
  const yaw = m.group.rotation.y;
  const px = m.group.position.x + Math.sin(yaw) * 2.5;
  const pz = m.group.position.z + Math.cos(yaw) * 2.5;
  if (!blockedAt(px, pz)) return advance(m, speed, dt);
  const side = m._ai.strafeDir;
  for (const s of [side, -side]) {
    const a = yaw + s * 0.9;
    const dx = m.group.position.x + Math.sin(a) * 2.5;
    const dz = m.group.position.z + Math.cos(a) * 2.5;
    if (!blockedAt(dx, dz)) {
      m.group.rotation.y = a;
      break;
    }
  }
  return false;
}

/** v3: swim/crawl movement that ignores water (mirefang); still border-clamped. */
function advanceWater(m, speed, dt) {
  applyLocalSteering(m, dt, true); // v5: watchdog only - submerged pathing unchanged
  const yaw = m.group.rotation.y;
  let nx = m.group.position.x + Math.sin(yaw) * speed * dt;
  let nz = m.group.position.z + Math.cos(yaw) * speed * dt;
  const rr = Math.hypot(nx, nz);
  const lim = CONFIG.playRadius - 8;
  if (rr > lim) {
    nx *= lim / rr;
    nz *= lim / rr;
  }
  m.group.position.x = nx;
  m.group.position.z = nz;
  m.moveSpeed = speed;
  return true;
}

/**
 * Airborne glide toward (tx, tz): straight horizontal move, world-border
 * clamp, faces travel direction. Flying machines ignore water.
 */
function hoverToward(m, tx, tz, speed, dt) {
  const dx = tx - m.group.position.x;
  const dz = tz - m.group.position.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= 0.05) return;
  const step = Math.min(speed * dt, d);
  let nx = m.group.position.x + (dx / d) * step;
  let nz = m.group.position.z + (dz / d) * step;
  const rr = Math.sqrt(nx * nx + nz * nz);
  const lim = CONFIG.playRadius - 12;
  if (rr > lim) {
    nx *= lim / rr;
    nz *= lim / rr;
  }
  m.group.position.x = nx;
  m.group.position.z = nz;
  m.moveSpeed = speed;
  turnToward(m, tx, tz, 6, dt);
}

function moveGround(m) {
  m.group.position.y = heightAt(m.group.position.x, m.group.position.z);
}

/** Hold cruise altitude above the terrain under the current XZ. */
function duskwingFlightHeight(m, dt) {
  const gy = heightAt(m.group.position.x, m.group.position.z);
  if (m._ai.atk !== 'dive') { // dives manage their own descent
    // v5: clearance probe - rising ground ~4u ahead lifts the cruise band
    // early so ridge lines don't clip the wingtips before the damp catches up
    let band = DUSKWING_CRUISE;
    const yaw = m.group.rotation.y;
    const ah = heightAt(
      m.group.position.x + Math.sin(yaw) * 4,
      m.group.position.z + Math.cos(yaw) * 4,
    );
    if (ah - gy > 1.5) band += ah - gy;
    m.group.position.y = damp(m.group.position.y, gy + band, 1.6, dt);
  }
}

// ------------------------------------------------- v5: local steering ------
// Corrective micro-layer under the archetype FSMs: nudges headings around
// slopes, crowding and the world border, plus a stuck watchdog with detour /
// homeward-recovery. Purely advisory - each FSM keeps heading authority via
// its own turnToward next frame. Ground movers reach this through
// advanceAvoid; water movers get watchdog-only through advanceWater.

/**
 * Deflect `m`'s heading in place. waterMode skips slope/separation/border
 * (submerged pathing stays exactly as shipped) but keeps stuck recovery.
 */
function applyLocalSteering(m, dt, waterMode = false) {
  const ai = m._ai;
  const s = ai._steer || (ai._steer = {
    ax: m.group.position.x,
    az: m.group.position.z,
    auditT: STUCK_WINDOW,
    detourT: 0,
    detourYaw: 0,
    wedgeStreak: 0, // consecutive wedges -> re-anchor pull toward homeX/homeZ
    reanchorT: 0,
  });

  // -- stuck watchdog: audit displacement every STUCK_WINDOW while trying to move
  s.auditT -= dt;
  if (Math.abs(m.moveSpeed) > 0.5) { // movement intent without progress = wedged
    if (s.auditT <= 0) {
      const moved = Math.hypot(m.group.position.x - s.ax, m.group.position.z - s.az);
      s.auditT = STUCK_WINDOW;
      s.ax = m.group.position.x;
      s.az = m.group.position.z;
      if (moved < STUCK_MIN_MOVE) {
        s.wedgeStreak++;
        if (s.wedgeStreak >= 3) {
          // teleport-free re-anchor: strong homeward heading for a few seconds
          // (homeX/homeZ is the spawn roost - lair/lair for mirefang too)
          s.wedgeStreak = 0;
          s.reanchorT = STUCK_REANCHOR_T;
        } else {
          s.detourT = 1; // brief angled shove out of the wedge
          const side = ai.rng() < 0.5 ? -1 : 1;
          s.detourYaw = side * ((60 + ai.rng() * 60) * Math.PI) / 180; // +-60..120 deg
        }
      } else {
        s.wedgeStreak = 0;
      }
    }
  } else {
    // idle time must not bank as progress: keep the window armed and anchored here
    s.auditT = STUCK_WINDOW;
    s.ax = m.group.position.x;
    s.az = m.group.position.z;
  }

  if (s.reanchorT > 0) {
    s.reanchorT -= dt;
    turnToward(m, ai.homeX, ai.homeZ, 2.5, dt); // walk home instead of shoving
    return;
  }
  if (s.detourT > 0) {
    s.detourT -= dt;
    m.group.rotation.y += s.detourYaw * dt; // hold the detour bearing
    return;
  }
  if (waterMode) return; // submerged pathing unchanged beyond recovery

  // -- terrain slope probe: refuse to march up/down >45 degree faces ----------
  const px = m.group.position.x;
  const pz = m.group.position.z;
  const yaw = m.group.rotation.y;
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const hHere = heightAt(px, pz);
  const hAhead = heightAt(px + fx * 2, pz + fz * 2);
  if (Math.atan2(Math.abs(hAhead - hHere), 2) > Math.PI / 4) {
    // take whichever flank is gentler, then rotate the heading off the face
    const leftD = Math.abs(heightAt(px - fz * 2, pz + fx * 2) - hHere);
    const rightD = Math.abs(heightAt(px + fz * 2, pz - fx * 2) - hHere);
    const side = leftD <= rightD ? 1 : -1;
    m.group.rotation.y = yaw + side * ((40 * Math.PI) / 180);
    return; // one correction per frame; the next frame re-probes
  }

  // -- separation: slide off crowded neighbours --------------------------------
  let sx = 0;
  let sz = 0;
  let crowded = false;
  for (const o of G.machines) {
    if (o === m || !o.alive) continue;
    const dx = px - o.group.position.x;
    const dz = pz - o.group.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > STEER_SEP_DIST * STEER_SEP_DIST || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    sx += (dx / d) * (STEER_SEP_DIST - d);
    sz += (dz / d) * (STEER_SEP_DIST - d);
    crowded = true;
  }

  // -- soft border push: ramps up over the innermost 10u of the play radius ----
  let bx = 0;
  let bz = 0;
  const rr = Math.hypot(px, pz);
  const borderR = CONFIG.playRadius - STEER_BORDER_BAND;
  if (rr > borderR) {
    const k = Math.min(1, (rr - borderR) / STEER_BORDER_BAND);
    bx = (-px / rr) * k * 2;
    bz = (-pz / rr) * k * 2;
  }

  if (!crowded && bx === 0 && bz === 0) return;
  // blend corrections into the desired heading, rate-limited so pursuits still converge
  const cx = fx + sx * 0.35 + bx * 0.3;
  const cz = fz + sz * 0.35 + bz * 0.3;
  const cl = Math.hypot(cx, cz);
  if (cl < 1e-4) return;
  const want = Math.atan2(cx / cl, cz / cl);
  let d = want - m.group.rotation.y;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  m.group.rotation.y += clamp(d, -3 * dt, 3 * dt);
}

// ------------------------------------------------------------- perception --
// v5: per-frame sight raycasting moved to perception.js (staggered thinks,
// budgeted terrain LOS, awareness ramp). ai.js only reads blackboards now.

function distSqToPlayer(m) {
  const p = G.player.pos;
  const dx = p.x - m.group.position.x;
  const dz = p.z - m.group.position.z;
  return dx * dx + dz * dz;
}

function distToPlayer(m) {
  return Math.sqrt(distSqToPlayer(m));
}

function distXZto(m, v) {
  const dx = v.x - m.group.position.x;
  const dz = v.z - m.group.position.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** True when the named weak point has been shattered. */
function hasBroken(m, name) {
  const wps = m.weakPoints;
  for (let i = 0; i < wps.length; i++) {
    if (wps[i].name === name && wps[i].broken) return true;
  }
  return false;
}

function damagePlayer(amount, fromPos) {
  const p = G.player;
  if (!p || p.dead || p.dodging) return;
  p.takeDamage(amount, fromPos);
}

// ------------------------------------------------------------ transitions --

function enterSuspicious(m, pos) {
  const ai = m._ai;
  ai.state = 'suspicious';
  ai.stateT = 0;
  ai.atk = null;
  ai.target.copy(pos);
  noteDebug(m, 'investigating'); // v5
}

function enterAttack(m) {
  const ai = m._ai;
  if (ai.state === 'attack') return;
  ai.state = 'attack';
  ai.stateT = 0;
  ai.atk = null;
  m.aggro = true;
  noteDebug(m, 'aggro'); // v5
  // one-shot alert cue for audio/FX consumers - the re-entry guard above keeps
  // this to exactly one emit per calm->aggravated transition
  bus.emit('machineAlert', { pos: m.group.position.clone() });
  // v3: a bolting bramblehorn panics nearby herdmates into fleeing too
  if (m.type === 'bramblehorn') stampedeHerd(m);
  // alert nearby machines - unless a skitter's optic is broken and it can't call out
  if (!(m.type === 'skitter' && hasBroken(m, 'optic'))) {
    bus.emit('noise', { pos: m.group.position.clone(), radius: 30 });
  }
}

function enterPatrol(m) {
  const ai = m._ai;
  ai.state = 'patrol';
  ai.stateT = 0;
  ai.atk = null;
  ai.waitT = 0;
  m.aggro = false;
  noteDebug(m, 'calmed'); // v5
  // a sub-state cut short by target loss leaves its pose channels driven and
  // nothing decays them - clear them or the machine freezes in that pose
  const a = m._anim;
  a.crouch = 0;
  a.rear = 0;
  a.lean = 0;
  a.roar = 0;
  a.rollSpin = 0;
  m.jawTarget = null;
  if (m._anim.shadowMesh) m._anim.shadowMesh.visible = false; // drop stale dive markers
  ai.waypoints = makeWaypoints(m); // fresh route from wherever we ended up
  ai.wpIndex = 0;
}

/** v3 herd flee: bramblehorns within 25u join the flight (all run away from
 * the player, so they share the instigator's direction). Direct state set -
 * no recursion, no extra noise beyond the instigator's own call. */
function stampedeHerd(src) {
  const pp = G.player.pos;
  for (const m of G.machines) {
    if (m === src || !m.alive || m.type !== 'bramblehorn' || !m._ai) continue;
    if (m._ai.state === 'attack') continue;
    const dx = m.group.position.x - pp.x;
    const dz = m.group.position.z - pp.z;
    if (dx * dx + dz * dz > 25 * 25) continue;
    m._ai.state = 'attack';
    m._ai.stateT = 0;
    m._ai.atk = null;
    m.aggro = true;
    noteDebug(m, 'herd-flee'); // v5
  }
}

// -------------------------------------------------------------------- FSM --

function tickMachine(m, dt) {
  const ai = m._ai;
  if (!ai) return;
  refreshDebug(m); // v5: cheap in-place mirror refresh (allocs only on transitions)
  const p = G.player;
  m.moveSpeed = 0;
  ai.stateT += dt;
  if (ai.cd > 0) ai.cd -= dt;

  // vantage: peaceful scanner - walks its loop, never fights, ignores noise
  if (m.type === 'vantage') {
    m.hitFlag = false;
    if (ai.scanCd > 0) ai.scanCd -= dt;
    vantagePatrol(m, dt);
    moveGround(m);
    return;
  }

  // v3: the two new roster types run their own scripts, not the generic FSM
  if (m.type === 'mirefang') {
    mirefangTick(m, dt);
    moveGround(m); // bottom-hugger: y always follows the lakebed/ground
    return;
  }
  if (m.type === 'monarch') {
    monarchTick(m, dt);
    moveGround(m);
    return;
  }

  if (ai.boltCd > 0) ai.boltCd -= dt;
  if (m.type === 'bulwark' && ai.rollCd > 0) ai.rollCd -= dt;
  if (m.type === 'duskwing' && ai.climbT > 0) ai.climbT -= dt;

  // duskwing loses a wing -> falls out of the sky, permanently grounded
  if (m.type === 'duskwing' && !ai.grounded && !ai.crashing &&
    (hasBroken(m, 'wingL') || hasBroken(m, 'wingR'))) {
    ai.crashing = true;
    ai.atk = null;
    if (m._anim.shadowMesh) m._anim.shadowMesh.visible = false;
  }
  if (ai.crashing) {
    // land on the water surface, never the lakebed - nothing down there can
    // be walked out of (advanceAvoid is water-blocked everywhere in the basin)
    const gy = Math.max(heightAt(m.group.position.x, m.group.position.z), CONFIG.waterLevel);
    m.group.position.y = Math.max(gy, m.group.position.y - 9 * dt);
    m.moveSpeed = 2; // frantic flap on the way down
    if (m.group.position.y <= gy + 0.01) {
      ai.crashing = false;
      ai.grounded = true;
      m.staggerTimer = 2; // brief stun on touchdown
      sfx('machineStep', { pos: m.group.position, size: 1.2 });
    }
    return; // no FSM while falling
  }

  // wingless splash-down: wade ashore before any FSM move - advanceAvoid is
  // water-blocked out here and every regenerated waypoint fails its dry check
  if (m.type === 'duskwing' && ai.grounded &&
    heightAt(m.group.position.x, m.group.position.z) < CONFIG.waterLevel) {
    // consume hits mid-wade too, else they queue up until shore
    if (m.hitFlag) {
      m.hitFlag = false;
      if (ai.state !== 'attack') enterAttack(m);
    }
    duskwingWade(m, dt);
    m.group.position.y = Math.max(
      heightAt(m.group.position.x, m.group.position.z),
      CONFIG.waterLevel,
    );
    return;
  }

  // damaged -> aggro (bramblehorn "attacks" by fleeing)
  if (m.hitFlag) {
    m.hitFlag = false;
    if (ai.state !== 'attack') enterAttack(m);
  }

  const dist = distToPlayer(m);
  switch (ai.state) {
    case 'dormant':
      if (m.type === 'duskwing' && !ai.grounded) duskwingDrift(m, dt); // idle hover-circle
      // instant-reaction path: proximity wake bypasses perception by design
      // (sleepers have no think loop; awareness stays 0 until they wake)
      if (!p.dead && dist < WAKE_DIST) enterSuspicious(m, p.pos);
      break;
    case 'patrol':
      patrolTick(m, dt, dist);
      break;
    case 'suspicious':
      suspiciousTick(m, dt, dist);
      break;
    case 'attack':
      attackTick(m, dt, dist);
      break;
  }

  if (m.type === 'duskwing' && !ai.grounded) {
    duskwingFlightHeight(m, dt); // airborne: manages its own height
    return;
  }
  if (ai.atk !== 'lunge') moveGround(m); // lunge manages its own arc height
}

function patrolTick(m, dt, _dist) { // _dist: caller-computed range kept in the tick API for future range gates
  const ai = m._ai;
  // v5: blackboard-gated escalation. Bramblehorn keeps its legacy
  // never-initiates exemption for both the aggro read and seek hints.
  if (m.type !== 'bramblehorn') {
    if (perceptionSighted(m)) {
      enterAttack(m);
      return;
    }
    const seek = takeSeekHint(m); // partial awareness: investigate instead of waiting
    if (seek) {
      enterSuspicious(m, seek);
      return;
    }
  }
  if (m.type === 'duskwing' && !ai.grounded) {
    duskwingDrift(m, dt); // aerial circles instead of ground waypoints
    return;
  }
  if (m.type === 'skitter' && hasBroken(m, 'optic')) {
    erraticWander(m, dt); // broken optic: blind-ish random wandering
    return;
  }
  if (ai.waitT > 0) {
    ai.waitT -= dt;
    return;
  }
  const tgt = ai.waypoints[ai.wpIndex];
  if (!tgt) {
    ai.waypoints = makeWaypoints(m);
    return;
  }
  const misalign = turnToward(m, tgt.x, tgt.z, 3, dt);
  if (misalign < 0.7) {
    if (!advanceAvoid(m, WALK_SPEED, dt)) {
      ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length; // blocked -> skip leg
      return;
    }
    if (distXZto(m, tgt) < 1.2) {
      ai.waitT = randRange(ai.rng, 1.5, 3.5); // pause at each waypoint
      ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length;
    }
  }
}

function suspiciousTick(m, dt, _dist) {
  const ai = m._ai;
  // v5: blackboard-gated escalation (same exemption as patrolTick).
  if (m.type !== 'bramblehorn' && perceptionSighted(m)) {
    enterAttack(m);
    return;
  }
  const seek = takeSeekHint(m);
  if (seek) ai.target.copy(seek); // fresher clue mid-investigation: retarget the approach
  if (m.type === 'duskwing' && !ai.grounded) {
    ai.circleAng += dt * 0.7; // circle above the investigation point
    hoverToward(
      m,
      ai.target.x + Math.cos(ai.circleAng) * DUSKWING_ORBIT,
      ai.target.z + Math.sin(ai.circleAng) * DUSKWING_ORBIT,
      6,
      dt,
    );
    return;
  }
  if (ai.stateT > SUSPICIOUS_TIMEOUT) {
    enterPatrol(m);
    return;
  }
  const misalign = turnToward(m, ai.target.x, ai.target.z, 3.5, dt);
  if (distXZto(m, ai.target) > 2.5 && misalign < 0.8) {
    advanceAvoid(m, SUSPICIOUS_SPEED, dt); // approach slowly to investigate
  }
}

// v3(F3): ground melee/ranged types break off and run while burning, rather
// than fighting on unimpeded (bramblehorn already flees by design; duskwing/
// mirefang/monarch run their own scripts and never reach this switch).
const PANIC_FLEE_TYPES = new Set(['skitter', 'rendclaw', 'ironmaw', 'bulwark']);

/** Face away from the player and run, mirroring bramblehornAttack's flee
 *  pattern. Only called between attacks (ai.atk falsy) so no telegraph or
 *  active swing is ever cut short. */
function panicFlee(m, dt) {
  const pp = G.player.pos;
  turnToward(m, m.group.position.x * 2 - pp.x, m.group.position.z * 2 - pp.z, 4, dt);
  advanceAvoid(m, STATS[m.type].run * 0.85, dt);
}

function attackTick(m, dt, dist) {
  const p = G.player;
  if (p.dead || dist > LEAVE_DIST) {
    enterPatrol(m); // player dead or escaped: calm down
    return;
  }
  if (m.panic && !m._ai.atk && PANIC_FLEE_TYPES.has(m.type)) {
    panicFlee(m, dt);
    return;
  }
  switch (m.type) {
    case 'skitter': skitterAttack(m, dt, dist); break;
    case 'bramblehorn': bramblehornAttack(m, dt, dist); break;
    case 'rendclaw': rendclawAttack(m, dt, dist); break;
    case 'ironmaw': ironmawAttack(m, dt, dist); break;
    case 'duskwing': duskwingAttack(m, dt, dist); break;
    case 'bulwark': bulwarkAttack(m, dt, dist); break;
  }
}

// ---------------------------------------------------------- v2: wanderers --

/** Skitter with a shattered optic: can't call alerts, wanders erratically. */
function erraticWander(m, dt) {
  const ai = m._ai;
  ai.jitterT -= dt;
  if (ai.jitterT <= 0) {
    ai.jitterT = randRange(ai.rng, 0.6, 1.4);
    ai.wanderYaw = ai.rng() * Math.PI * 2;
  }
  turnToward(
    m,
    m.group.position.x + Math.sin(ai.wanderYaw) * 6,
    m.group.position.z + Math.cos(ai.wanderYaw) * 6,
    4,
    dt,
  );
  advanceAvoid(m, WALK_SPEED, dt);
}

/** Peaceful vantage: endless slow walk around its fixed loop. */
function vantagePatrol(m, dt) {
  const ai = m._ai;
  const tgt = ai.waypoints[ai.wpIndex];
  if (!tgt) {
    ai.waypoints = makeVantageLoop(m);
    ai.wpIndex = 0;
    return;
  }
  const misalign = turnToward(m, tgt.x, tgt.z, 2, dt);
  if (misalign < 0.7) {
    if (!advanceAvoid(m, STATS.vantage.run, dt)) {
      ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length; // blocked -> skip leg
      return;
    }
    if (distXZto(m, tgt) < 1.5) {
      ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length; // endless loop, no pauses
    }
  }
}

/** Slow drifting circle used by non-aggro airborne duskwings. */
function duskwingDrift(m, dt) {
  const ai = m._ai;
  ai.anchorT -= dt;
  if (ai.anchorT <= 0) {
    ai.anchorT = randRange(ai.rng, 6, 11);
    const ang = ai.rng() * Math.PI * 2;
    const r = randRange(ai.rng, 18, 40);
    let nx = m.group.position.x + Math.cos(ang) * r;
    let nz = m.group.position.z + Math.sin(ang) * r;
    const rr = Math.sqrt(nx * nx + nz * nz);
    const lim = CONFIG.playRadius - 20;
    if (rr > lim) {
      nx *= lim / rr;
      nz *= lim / rr;
    }
    ai.anchor.set(nx, 0, nz);
  }
  ai.circleAng += dt * 0.55;
  hoverToward(
    m,
    ai.anchor.x + Math.cos(ai.circleAng) * DUSKWING_ORBIT + 4,
    ai.anchor.z + Math.sin(ai.circleAng) * DUSKWING_ORBIT + 4,
    5,
    dt,
  );
}

/** Wingless splash-down escape: turn toward the driest of 8 nearby headings
 * and swim-walk until ashore (tickMachine routes grounded-in-water birds here).
 * An all-wet sweep widens the probe ring 8 -> 16 -> 24u before falling back to
 * the shallowest sample seen, so deep-basin birds still climb toward shore. */
function duskwingWade(m, dt) {
  const x = m.group.position.x;
  const z = m.group.position.z;
  let bestAng = m.group.rotation.y;
  let bestH = -Infinity;
  let allWet = true;
  for (let ri = 0; ri < DUSKWING_WADE_RADII.length && allWet; ri++) {
    const r = DUSKWING_WADE_RADII[ri];
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const h = heightAt(x + Math.sin(ang) * r, z + Math.cos(ang) * r);
      if (h > bestH) {
        bestH = h;
        bestAng = ang;
      }
      if (h >= CONFIG.waterLevel) allWet = false; // dry landing found: stop widening
    }
  }
  turnToward(m, x + Math.sin(bestAng) * 8, z + Math.cos(bestAng) * 8, 3, dt);
  advanceWater(m, 2.6, dt); // resampled every frame, so the heading self-corrects
}

// ---------------------------------------------------------------- attacks --

function skitterAttack(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  switch (ai.atk) {
    case 'crouch': { // 0.5s telegraph squat
      ai.phaseT += dt;
      a.crouch = damp(a.crouch, 1, 10, dt);
      turnToward(m, pp.x, pp.z, 4, dt);
      if (ai.phaseT >= 0.5) {
        a.crouch = 0;
        ai.atk = 'lunge';
        ai.phaseT = 0;
        ai.leapU = 0;
        ai.leapHit = false;
        ai.leapStart.copy(m.group.position);
        const yaw = m.group.rotation.y;
        const reach = clamp(dist, 3, 8);
        let ex = m.group.position.x + Math.sin(yaw) * reach;
        let ez = m.group.position.z + Math.cos(yaw) * reach;
        if (blockedAt(ex, ez)) {
          ex = m.group.position.x + Math.sin(yaw) * 2;
          ez = m.group.position.z + Math.cos(yaw) * 2;
        }
        ai.leapEnd.set(ex, 0, ez);
      }
      break;
    }
    case 'lunge': { // arcing lunge along a locked line
      ai.leapU = Math.min(1, ai.leapU + dt / 0.55);
      const u = ai.leapU;
      m.group.position.x = lerp(ai.leapStart.x, ai.leapEnd.x, u);
      m.group.position.z = lerp(ai.leapStart.z, ai.leapEnd.z, u);
      const gy = lerp(
        heightAt(ai.leapStart.x, ai.leapStart.z),
        heightAt(ai.leapEnd.x, ai.leapEnd.z),
        u,
      );
      m.group.position.y = gy + Math.sin(u * Math.PI) * 1.1;
      m.moveSpeed = m.maxSpeed * 2; // blur-fast gait mid-air
      if (!ai.leapHit && dist < 1.7) {
        ai.leapHit = true;
        damagePlayer(12 * (m.damageMul || 1), m.group.position);
      }
      if (ai.leapU >= 1) {
        ai.atk = 'recover';
        ai.phaseT = 0;
        ai.cd = 3;
      }
      break;
    }
    case 'recover':
      ai.phaseT += dt;
      if (ai.phaseT > 0.4) ai.atk = null;
      break;
    default: { // circle at mid range, keep distance, leap when ready
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) {
        ai.strafeT = randRange(ai.rng, 1.2, 2.2);
        ai.strafeDir *= -1;
      }
      if (dist > 9) {
        const misalign = turnToward(m, pp.x, pp.z, STATS.skitter.turn, dt);
        if (misalign < 1.0) advanceAvoid(m, STATS.skitter.run, dt);
      } else if (dist < 4.5) {
        turnToward(m, pp.x, pp.z, STATS.skitter.turn, dt);
        retreat(m, 4, dt); // too close: back off while facing the player
      } else {
        const ang = Math.atan2(
          m.group.position.x - pp.x,
          m.group.position.z - pp.z,
        ) + ai.strafeDir * 0.8;
        turnToward(m, pp.x + Math.sin(ang) * 6.5, pp.z + Math.cos(ang) * 6.5, 5, dt);
        advanceAvoid(m, 3.5, dt);
      }
      if (ai.cd <= 0 && dist >= 4 && dist <= 9) {
        ai.atk = 'crouch';
        ai.phaseT = 0;
      }
      break;
    }
  }
}

function rendclawAttack(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  // v2: a shattered neckcord halves claw damage
  const dmgMul = (m.damageMul || 1) * (hasBroken(m, 'neckcord') ? 0.5 : 1);
  if (!ai.atk) {
    const misalign = turnToward(m, pp.x, pp.z, STATS.rendclaw.turn, dt);
    if (misalign < 1.2) advanceAvoid(m, STATS.rendclaw.run, dt);
    if (dist < 2.3 && ai.cd <= 0) {
      ai.atk = 'combo';
      ai.comboStep = 0;
      ai.phaseT = 0;
      ai.swipeSide = ai.strafeDir;
    }
    return;
  }
  // claw combo: windup 0.30s -> strike -> 0.35s -> strike -> recover
  turnToward(m, pp.x, pp.z, 6, dt);
  ai.phaseT += dt;
  if (ai.comboStep === 0) {
    a.lean = damp(a.lean, -ai.swipeSide, 10, dt);
    m.jawTarget = 0.9;
    if (ai.phaseT >= 0.3) {
      if (dist < 2.6) damagePlayer(15 * dmgMul, m.group.position);
      ai.comboStep = 1;
      ai.phaseT = 0;
      a.lean = ai.swipeSide;
    }
  } else if (ai.comboStep === 1) {
    a.lean = damp(a.lean, ai.swipeSide, 12, dt);
    if (ai.phaseT >= 0.35) {
      if (dist < 2.6) damagePlayer(15 * dmgMul, m.group.position);
      ai.comboStep = 2;
      ai.phaseT = 0;
    }
  } else {
    a.lean = damp(a.lean, 0, 8, dt);
    m.jawTarget = null;
    if (ai.phaseT >= 0.35) {
      ai.atk = null;
      ai.cd = 2.2;
    }
  }
}

function bramblehornAttack(m, dt, dist) { // never initiates: flee, kick if cornered
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  // v2: a ruptured fuelsac makes it slower on the flee
  const fleeSpeed = STATS.bramblehorn.run * (hasBroken(m, 'fuelsac') ? 0.6 : 1);

  if (ai.atk === 'kick') { // rear-up telegraph then hind-leg kick
    ai.phaseT += dt;
    a.rear = damp(a.rear, 1, 8, dt);
    turnToward(m, pp.x, pp.z, 3, dt);
    if (ai.phaseT >= 0.4 && !ai.dashHit) {
      ai.dashHit = true;
      if (dist < 3.2) damagePlayer(10 * (m.damageMul || 1), m.group.position);
    }
    if (ai.phaseT >= 0.9) {
      a.rear = 0;
      ai.atk = null;
      ai.cd = 2.5;
    }
    return;
  }

  // face away from the player and run
  a.rear = damp(a.rear, 0, 8, dt);
  turnToward(m, m.group.position.x * 2 - pp.x, m.group.position.z * 2 - pp.z, 5, dt);
  const moved = advanceAvoid(m, fleeSpeed, dt);
  if ((!moved || dist < 3) && ai.cd <= 0) {
    // cornered against water/border or overrun: kick
    ai.atk = 'kick';
    ai.phaseT = 0;
    ai.dashHit = false;
  }
}

function ironmawAttack(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  // v2: a destroyed core disables the charge and slows it down
  const coreOut = hasBroken(m, 'core');
  const runSpeed = STATS.ironmaw.run * (coreOut ? 0.7 : 1);

  if (ai.atk === 'roar') { // 0.8s roar telegraph for the charge
    ai.phaseT += dt;
    a.roar = 1;
    turnToward(m, pp.x, pp.z, 1.5, dt);
    if (ai.phaseT >= 0.8) {
      a.roar = 0;
      ai.atk = 'dash';
      ai.phaseT = 0;
      ai.dashHit = false;
      const yaw = m.group.rotation.y;
      ai.dashDir.set(Math.sin(yaw), 0, Math.cos(yaw)); // line locked at roar end
      ai.cd = 6;
    }
    return;
  }

  if (ai.atk === 'dash') { // straight line dash, contact damage once
    ai.phaseT += dt;
    const nx = m.group.position.x + ai.dashDir.x * 16 * dt;
    const nz = m.group.position.z + ai.dashDir.z * 16 * dt;
    if (!blockedAt(nx, nz)) {
      m.group.position.x = nx;
      m.group.position.z = nz;
      m.moveSpeed = 16;
    } else {
      ai.atk = null; // slammed into water/edge
    }
    if (!ai.dashHit && dist < m.radius + 1.0) {
      ai.dashHit = true;
      damagePlayer(30 * (m.damageMul || 1), m.group.position); // takeDamage applies knockback from fromPos
    }
    if (ai.phaseT >= 1.1) ai.atk = null;
    return;
  }

  if (ai.atk === 'bolt') { // 0.6s wind-up then spark bolt
    ai.phaseT += dt;
    a.boltGlow = 1;
    turnToward(m, pp.x, pp.z, 2.5, dt);
    if (ai.phaseT >= 0.6) {
      fireBolt(m);
      a.boltGlow = 0;
      ai.atk = null;
      ai.boltCd = 1.8;
    }
    return;
  }

  // slow pursuit
  const misalign = turnToward(m, pp.x, pp.z, STATS.ironmaw.turn, dt);
  if (misalign < 1.0) advanceAvoid(m, runSpeed, dt);
  if (!coreOut && ai.cd <= 0 && dist < 26 && dist > 4) {
    ai.atk = 'roar';
    ai.phaseT = 0;
  } else if (ai.boltCd <= 0 && dist > 12 && dist < 30) {
    ai.atk = 'bolt'; // ranged fallback while the charge is unavailable (cd or core-out)
    ai.phaseT = 0;
  }
}

function duskwingAttack(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;

  if (ai.grounded) { // wingless: scramble away on foot, no attacks left
    turnToward(m, m.group.position.x * 2 - pp.x, m.group.position.z * 2 - pp.z, 4, dt);
    advanceAvoid(m, 3.4, dt);
    return;
  }

  if (ai.atk === 'telegraph') { // screech + growing ground-shadow mark
    ai.phaseT += dt;
    const k = clamp(ai.phaseT / DUSKWING_TELEGRAPH, 0, 1);
    const sh = a.shadowMesh;
    if (sh) {
      sh.visible = true;
      sh.scale.setScalar(lerp(0.6, 2.4, k));
      a.shadowMat.opacity = 0.15 + 0.35 * k;
      sh.position.set(ai.diveTarget.x, heightAt(ai.diveTarget.x, ai.diveTarget.z) + 0.06, ai.diveTarget.z);
    }
    hoverToward(m, ai.diveTarget.x, ai.diveTarget.z, 6, dt); // drift over the mark
    if (ai.phaseT >= DUSKWING_TELEGRAPH) {
      ai.atk = 'dive';
      ai.phaseT = 0;
      ai.diveU = 0;
      ai.diveStart.copy(m.group.position);
    }
    return;
  }

  if (ai.atk === 'dive') { // accelerating stoop onto the marked spot
    ai.diveU = Math.min(1, ai.diveU + dt / 0.55);
    const u = ai.diveU;
    const ty = Math.max(heightAt(ai.diveTarget.x, ai.diveTarget.z), CONFIG.waterLevel); // never stoop onto the lakebed
    m.group.position.x = lerp(ai.diveStart.x, ai.diveTarget.x, u);
    m.group.position.z = lerp(ai.diveStart.z, ai.diveTarget.z, u);
    m.group.position.y = lerp(ai.diveStart.y, ty, u * u);
    m.moveSpeed = m.maxSpeed;
    turnToward(m, ai.diveTarget.x, ai.diveTarget.z, 10, dt);
    if (ai.diveU >= 1) {
      m.group.position.y = ty; // touchdown
      if (a.shadowMesh) a.shadowMesh.visible = false;
      sfx('machineStep', { pos: m.group.position, size: 1.4 });
      const dx = pp.x - m.group.position.x;
      const dz = pp.z - m.group.position.z;
      if (dx * dx + dz * dz < 2.4 * 2.4) {
        damagePlayer(DUSKWING_DIVE_DMG * (m.damageMul || 1), m.group.position);
      }
      m.staggerTimer = DUSKWING_STUN; // grounded + stunned after each dive
      ai.atk = null;
      ai.climbT = DUSKWING_CLIMB_LOCK; // must climb back up before diving again
    }
    return;
  }

  // circle above the player; dive when the climb lock has elapsed
  ai.anchor.lerp(pp, clamp(1.2 * dt, 0, 1)); // lazy chase toward the player
  ai.circleAng += dt * 0.9;
  hoverToward(
    m,
    ai.anchor.x + Math.cos(ai.circleAng) * DUSKWING_ORBIT,
    ai.anchor.z + Math.sin(ai.circleAng) * DUSKWING_ORBIT,
    STATS.duskwing.run,
    dt,
  );
  if (ai.climbT <= 0 && ai.cd <= 0 && dist < 34) {
    if (heightAt(pp.x, pp.z) <= CONFIG.waterLevel + 0.3) {
      ai.cd = 1.2; // wet mark: a touchdown there would strand us - keep circling
      return;
    }
    ai.atk = 'telegraph';
    ai.phaseT = 0;
    ai.diveTarget.copy(pp); // mark where the player stands right now
    ai.cd = 1.2;
    sfx('screech', { pos: m.group.position }); // audio-v2 synth; silently skipped if absent
  }
}

function bulwarkAttack(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;

  if (ai.atk === 'rollWind') { // 0.7s quake telegraph, line locked at the end
    ai.phaseT += dt;
    a.roar = 0.7;
    turnToward(m, pp.x, pp.z, 1.6, dt);
    if (ai.phaseT >= 0.7) {
      a.roar = 0;
      ai.atk = 'roll';
      ai.phaseT = 0;
      ai.dashHit = false;
      const yaw = m.group.rotation.y;
      ai.dashDir.set(Math.sin(yaw), 0, Math.cos(yaw));
    }
    return;
  }

  if (ai.atk === 'roll') { // tucked roll along the locked line
    ai.phaseT += dt;
    a.rollSpin = 14; // pill-body tumble, consumed by machines.updateMachine
    const nx = m.group.position.x + ai.dashDir.x * 13 * dt;
    const nz = m.group.position.z + ai.dashDir.z * 13 * dt;
    if (!blockedAt(nx, nz)) {
      m.group.position.x = nx;
      m.group.position.z = nz;
      m.moveSpeed = 13;
    } else {
      ai.atk = 'rollEnd'; // slammed into water/edge
      ai.phaseT = 0;
    }
    if (!ai.dashHit && dist < m.radius + 1.1) {
      ai.dashHit = true;
      damagePlayer(BULWARK_ROLL_DMG * (m.damageMul || 1), m.group.position);
    }
    if (ai.phaseT >= 1.1) {
      ai.atk = 'rollEnd';
      ai.phaseT = 0;
    }
    return;
  }

  if (ai.atk === 'rollEnd') { // unrolling recovery
    ai.phaseT += dt;
    a.rollSpin = 0;
    if (ai.phaseT >= 0.6) {
      ai.atk = null;
      ai.rollCd = BULWARK_ROLL_CD;
    }
    return;
  }

  if (ai.atk === 'crush') { // rear up, then slam down
    ai.phaseT += dt;
    a.rear = damp(a.rear, 1, 8, dt);
    turnToward(m, pp.x, pp.z, 2, dt);
    if (ai.phaseT >= 0.5 && !ai.dashHit) {
      ai.dashHit = true;
      a.rear = 0;
      if (dist < 3.4) {
        damagePlayer(BULWARK_CRUSH_DMG * (m.damageMul || 1), m.group.position);
      }
      sfx('machineStep', { pos: m.group.position, size: 1.8 });
    }
    if (ai.phaseT >= 0.9) {
      a.rear = 0;
      ai.atk = null;
      ai.cd = 3;
    }
    return;
  }

  // pursuit
  const misalign = turnToward(m, pp.x, pp.z, STATS.bulwark.turn, dt);
  if (misalign < 1.0) advanceAvoid(m, STATS.bulwark.run, dt);
  const canRoll = !hasBroken(m, 'vents'); // shattered vents disable the roll
  if (canRoll && ai.rollCd <= 0 && dist > 5 && dist < 30) {
    ai.atk = 'rollWind';
    ai.phaseT = 0;
  } else if (ai.cd <= 0 && dist < 3.2) {
    ai.atk = 'crush';
    ai.phaseT = 0;
    ai.dashHit = false;
  }
}

// ------------------------------------------------------------ v3: mirefang -
// Lurks submerged on the lake bottom (only the glow crests the surface);
// ambushes anything entering the water within 14u with a burst lunge plus a
// brief death-roll drag, hauls out for a sluggish short chase, then swims
// back to its lair once the player breaks away.

function startMireAmbush(m) {
  const ai = m._ai;
  const dist = distToPlayer(m);
  // alert cue only on the lurk->strike escalation; re-ambushes mid-chase are
  // not new transitions (mirrors enterAttack's re-entry guard)
  if (ai.state !== 'attack') bus.emit('machineAlert', { pos: m.group.position.clone() });
  ai.state = 'attack';
  ai.atk = 'lunge';
  ai.phaseT = 0;
  ai.lungeDur = clamp(dist / 12, 0.3, 1.2);
  ai.leapHit = false;
  ai.leapStart.copy(m.group.position);
  ai.leapEnd.set(G.player.pos.x, 0, G.player.pos.z);
  m.aggro = true;
  m.jawTarget = 0.95;
  noteDebug(m, 'ambush'); // v5
  sfx('screech', { pos: m.group.position }); // hiss before the strike
  bus.emit('noise', { pos: m.group.position.clone(), radius: 24 }); // surface splash
}

function mirefangTick(m, dt) {
  const ai = m._ai;
  const p = G.player;
  const pp = p.pos;
  const dist = distToPlayer(m);
  const inWater = pp.y < CONFIG.waterLevel - 0.3; // feet below the surface
  const lairDist = distXZto(m, ai.anchor);

  // being shot provokes it even on land
  if (m.hitFlag) {
    m.hitFlag = false;
    if (ai.state !== 'attack') {
      ai.state = 'attack';
      ai.atk = null;
      m.aggro = true;
      bus.emit('machineAlert', { pos: m.group.position.clone() });
    }
  }

  switch (ai.atk) {
    case 'lunge': { // burst straight at the marked splash point
      ai.phaseT += dt;
      const u = Math.min(1, ai.phaseT / ai.lungeDur);
      m.group.position.x = lerp(ai.leapStart.x, ai.leapEnd.x, u);
      m.group.position.z = lerp(ai.leapStart.z, ai.leapEnd.z, u);
      m.moveSpeed = 12;
      m.jawTarget = 0.95;
      if (!ai.leapHit && dist < 2.1) {
        ai.leapHit = true;
        damagePlayer(MIRE_LUNGE_DMG * (m.damageMul || 1), m.group.position);
        bus.emit('camShake', { amp: 0.45 });
        ai.atk = 'drag';
        ai.phaseT = 0;
        ai.dragTick = 0;
        return;
      }
      if (u >= 1) { // missed: brief recovery, then chase
        ai.atk = 'recover';
        ai.phaseT = 0;
        ai.cd = 2.5;
        m.jawTarget = null;
      }
      return;
    }
    case 'drag': { // clamped on: death-roll bites while hauling the player about
      ai.phaseT += dt;
      m.jawTarget = 0.9;
      const misalign = turnToward(m, pp.x, pp.z, 6, dt);
      if (misalign < 1.2) advanceWater(m, 6.5, dt);
      else m.moveSpeed = 6.5;
      ai.dragTick -= dt;
      if (ai.dragTick <= 0 && dist < 2.6) {
        ai.dragTick = 0.45;
        damagePlayer(MIRE_DRAG_DMG * (m.damageMul || 1), m.group.position);
      }
      if (ai.phaseT >= MIRE_DRAG_TIME) {
        m.jawTarget = null;
        ai.atk = 'recover';
        ai.phaseT = 0;
        ai.cd = 3;
      }
      return;
    }
    case 'recover':
      ai.phaseT += dt;
      if (ai.phaseT > 0.5) ai.atk = null;
      return;
    case 'home': { // swim back to the lair and resubmerge
      const misalign = turnToward(m, ai.anchor.x, ai.anchor.z, 2.5, dt);
      if (misalign < 0.8) advanceWater(m, STATS.mirefang.run, dt);
      else m.moveSpeed = STATS.mirefang.run;
      if (!p.dead && inWater && dist < 10) { // swimmer cuts it off: re-ambush
        ai.atk = null;
        startMireAmbush(m);
      } else if (lairDist < 2.5) {
        ai.atk = null;
        ai.state = 'dormant';
        m.aggro = false;
      }
      return;
    }
  }

  if (ai.state === 'dormant') { // lurking: only a swimmer stirs it
    if (!p.dead && inWater && dist < MIRE_STRIKE_DIST) startMireAmbush(m);
    return;
  }

  // attacking: pursue; give up when the player escapes or it strays too far
  if (p.dead || dist > 40 || (!inWater && lairDist > MIRE_HAULOUT)) {
    ai.atk = 'home';
    return;
  }
  const spd = inWater ? MIRE_SWIM : STATS.mirefang.run;
  const misalign = turnToward(m, pp.x, pp.z, STATS.mirefang.turn + 1, dt);
  if (misalign < 1.1) advanceWater(m, spd, dt);
  else m.moveSpeed = spd;
  m.jawTarget = dist < 5 ? 0.8 : null;
  if (inWater && ai.cd <= 0 && dist < 7 && dist > 1.2) startMireAmbush(m);
}

// ------------------------------------------------------------ v3: monarch --
// Colossal border-walker: never sprints along its huge loop, stomps when the
// player crowds its feet, tail-swipes rear loiterers, enrages once per 25%
// hp lost and dies in a 2s explosion chain (see boss death spectacle below).

/** Huge fixed border loop; starts on the leg nearest the spawn point. */
function makeMonarchLoop(m) {
  const rng = m._ai.rng;
  const n = 10;
  const ang0 = rng() * Math.PI * 2;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = ang0 + (i / n) * Math.PI * 2;
    let wx = Math.cos(ang) * randRange(rng, 195, 225);
    let wz = Math.sin(ang) * randRange(rng, 195, 225);
    for (let t = 0; t < 8; t++) { // pull illegal points inward until legal
      const rr = Math.hypot(wx, wz);
      if (rr > CONFIG.playRadius - 18) {
        wx *= 0.92;
        wz *= 0.92;
        continue;
      }
      if (heightAt(wx, wz) < CONFIG.waterLevel + 0.4) {
        wx *= 0.88;
        wz *= 0.88;
        continue;
      }
      break;
    }
    pts.push(new THREE.Vector3(wx, 0, wz));
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = pts[i].x - m.group.position.x;
    const dz = pts[i].z - m.group.position.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  m._ai.wpIndex = best;
  return pts;
}

/** Stomp warning disc, owned by ai.js (removed on death via machineDied). */
const TELE_GEO = new THREE.CircleGeometry(1, 24);

function ensureTeleGraph(m) {
  if (m._ai.teleMesh || !G.scene) return;
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff8c3a, transparent: true, opacity: 0,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(TELE_GEO, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;
  mesh.visible = false;
  G.scene.add(mesh);
  m._ai.teleMesh = mesh;
  m._ai.teleMat = mat;
}

function removeTeleGraph(m) {
  if (!m._ai || !m._ai.teleMesh) return;
  m._ai.teleMesh.removeFromParent();
  m._ai.teleMat.dispose();
  m._ai.teleMesh = null;
  m._ai.teleMat = null;
}

function monarchStomp(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  ai.phaseT += dt;
  a.rear = damp(a.rear, 1, 5, dt); // weight rocks back: the foot-raise tell
  turnToward(m, pp.x, pp.z, 1.0, dt);
  const k = clamp(ai.phaseT / MONARCH_STOMP_TELE, 0, 1);
  if (ai.teleMesh) {
    ai.teleMesh.visible = true;
    ai.teleMesh.scale.setScalar(Math.max(0.4, MONARCH_STOMP_R * k));
    ai.teleMat.opacity = 0.12 + 0.3 * k;
    ai.teleMesh.position.set(ai.target.x, heightAt(ai.target.x, ai.target.z) + 0.08, ai.target.z);
  }
  if (ai.phaseT >= MONARCH_STOMP_TELE) {
    a.rear = 0;
    if (ai.teleMesh) ai.teleMesh.visible = false;
    sfx('machineStep', { pos: m.group.position, size: 2.4 });
    bus.emit('camShake', { amp: clamp(1.2 - dist * 0.04, 0.15, 0.9) });
    bus.emit('noise', { pos: m.group.position.clone(), radius: 40 });
    const dx = pp.x - ai.target.x;
    const dz = pp.z - ai.target.z;
    if (dx * dx + dz * dz <= MONARCH_STOMP_R * MONARCH_STOMP_R) {
      damagePlayer(MONARCH_STOMP_DMG * (m.damageMul || 1), m.group.position);
    }
    ai.atk = 'recover';
    ai.phaseT = 0;
    ai.cd = MONARCH_STOMP_CD;
  }
}

function monarchTail(m, dt, dist) {
  const ai = m._ai;
  const a = m._anim;
  const pp = G.player.pos;
  ai.phaseT += dt;
  if (ai.phaseT < 0.45) { // coil to one side
    a.lean = damp(a.lean, -ai.swipeSide, 8, dt);
  } else { // whip across the rear arc
    a.lean = damp(a.lean, ai.swipeSide, 14, dt);
    if (!ai.dashHit) {
      ai.dashHit = true;
      const d = dist || 1;
      const fx = Math.sin(m.group.rotation.y);
      const fz = Math.cos(m.group.rotation.y);
      const dot = (fx * (pp.x - m.group.position.x) + fz * (pp.z - m.group.position.z)) / d;
      if (dist < MONARCH_TAIL_REACH && dot < 0.15) { // anything not well in front
        damagePlayer(MONARCH_TAIL_DMG * (m.damageMul || 1), m.group.position);
        bus.emit('camShake', { amp: 0.4 });
      }
      sfx('machineStep', { pos: m.group.position, size: 1.4 });
    }
  }
  if (ai.phaseT >= 0.95) {
    a.lean = 0;
    ai.atk = null;
    ai.tailCd = MONARCH_TAIL_CD;
    ai.behindT = 0;
  }
}

function monarchTick(m, dt) {
  const ai = m._ai;
  const a = m._anim;
  const p = G.player;
  const pp = p.pos;
  const dist = distToPlayer(m);

  // enrage: every 25% hp lost -> faster walk + bellow heard across the map
  const step = Math.floor((1 - m.hp / m.maxHp) / 0.25 + 1e-6);
  if (step > ai.enrageStep && m.hp > 0) {
    ai.enrageStep = step;
    ai.roarT = 1.1;
    noteDebug(m, 'enrage'); // v5
    bus.emit('noise', { pos: m.group.position.clone(), radius: 60 });
    bus.emit('notify', { text: 'THE MONARCH ENRAGES', tone: 'bad' });
    sfx('growl', { pos: m.group.position });
  }
  if (ai.roarT > 0) {
    ai.roarT -= dt;
    a.roar = 1;
  } else {
    a.roar = 0;
  }
  if (ai.tailCd > 0) ai.tailCd -= dt;

  if (ai.atk === 'recover') {
    ai.phaseT += dt;
    if (ai.phaseT >= 0.6) ai.atk = null;
    return;
  }
  if (ai.atk === 'stomp') {
    monarchStomp(m, dt, dist);
    return;
  }
  if (ai.atk === 'tail') {
    monarchTail(m, dt, dist);
    return;
  }

  // relentless loop walk at plain walk speed (enrage multiplies it)
  const speed = STATS.monarch.run * Math.pow(MONARCH_ENRAGE_MUL, ai.enrageStep);
  const tgt = ai.waypoints[ai.wpIndex];
  if (!tgt) {
    ai.waypoints = makeMonarchLoop(m);
    return;
  }
  const misalign = turnToward(m, tgt.x, tgt.z, STATS.monarch.turn, dt);
  if (misalign < 0.7) {
    if (!advanceAvoid(m, speed, dt)) {
      ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length; // blocked -> skip leg
      return;
    }
    if (distXZto(m, tgt) < 3) ai.wpIndex = (ai.wpIndex + 1) % ai.waypoints.length;
  }

  if (p.dead) return;

  // is the player lingering behind it?
  const d = dist || 1;
  const fx = Math.sin(m.group.rotation.y);
  const fz = Math.cos(m.group.rotation.y);
  const dot = (fx * (pp.x - m.group.position.x) + fz * (pp.z - m.group.position.z)) / d;
  if (dist < 16 && dot < -0.35) ai.behindT += dt;
  else ai.behindT = 0;

  if (dist < MONARCH_STOMP_RANGE && ai.cd <= 0) {
    ai.atk = 'stomp';
    ai.phaseT = 0;
    ai.dashHit = false;
    noteDebug(m, 'stomp'); // v5
    // mark the slam spot partway toward the player
    const k = Math.min(1, (MONARCH_STOMP_RANGE - 1) / d);
    ai.target.set(
      m.group.position.x + (pp.x - m.group.position.x) * k,
      0,
      m.group.position.z + (pp.z - m.group.position.z) * k,
    );
    ensureTeleGraph(m);
  } else if (ai.behindT > MONARCH_BEHIND_TIME && ai.tailCd <= 0 &&
    dist < MONARCH_TAIL_REACH + 2) {
    ai.atk = 'tail';
    ai.phaseT = 0;
    ai.dashHit = false;
    ai.swipeSide = ai.strafeDir;
    noteDebug(m, 'tail'); // v5
  }
}

// ---------------------------------------------------------- spark bolts ----

const BOLT_GEO = new THREE.SphereGeometry(0.13, 8, 6);
const BOLT_MAT = new THREE.MeshBasicMaterial({ color: 0x59e3ff });
const bolts = []; // { mesh, vel: Vector3, life, mul }

function fireBolt(m) {
  _v1.set(0, 1.5, 1.3); // muzzle just in front of the chassis
  m.group.localToWorld(_v1);
  _v2.copy(G.player.pos);
  _v2.y += 1.1; // aim at chest height
  _v3.subVectors(_v2, _v1);
  const len = _v3.length();
  if (len < 0.001 || !G.scene) return;
  _v3.multiplyScalar(1 / len);
  const mesh = new THREE.Mesh(BOLT_GEO, BOLT_MAT);
  mesh.position.copy(_v1);
  G.scene.add(mesh);
  bolts.push({ mesh, vel: _v3.clone().multiplyScalar(26), life: 2, mul: m.damageMul || 1 });
}

function updateBolts(dt) {
  const p = G.player;
  for (let i = bolts.length - 1; i >= 0; i--) {
    const b = bolts[i];
    b.life -= dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    let dead = b.life <= 0;
    if (!dead && b.mesh.position.y < heightAt(b.mesh.position.x, b.mesh.position.z) + 0.05) dead = true;
    if (!dead && p && !p.dead) {
      _bv.copy(p.pos);
      _bv.y += 0.9;
      if (b.mesh.position.distanceToSquared(_bv) < 0.81) { // hit sphere r=0.9
        damagePlayer(14 * b.mul, b.mesh.position);
        dead = true;
      }
    }
    if (dead) {
      b.mesh.removeFromParent();
      bolts.splice(i, 1);
    }
  }
}

// --------------------------------------------------------------- hearing ---

bus.on('noise', ({ pos, radius }) => {
  for (const m of G.machines) {
    if (!m.alive || !m._ai) continue;
    if (m.type === 'vantage') continue; // peaceful scanners ignore the racket
    if (m.type === 'mirefang' || m.type === 'monarch') continue; // v3: scripted hunters
    const ai = m._ai;
    if (ai.state === 'attack') continue;
    if (m.group.position.distanceToSquared(pos) > radius * radius) continue;
    if (ai.state === 'suspicious') enterAttack(m); // already wary -> aggro
    else enterSuspicious(m, pos);
  }
});

// ------------------------------------------------------- kill streak chain -

let streakCount = 0;
let lastKillAt = -1e9;

bus.on('machineDied', () => {
  if (G.elapsed - lastKillAt <= KILL_STREAK_WINDOW) streakCount += 1;
  else streakCount = 1;
  lastKillAt = G.elapsed;
  if (streakCount >= 2) bus.emit('killStreak', { count: streakCount });
});

// -------------------------------------------------------- corpse harvest ---
// Dead machines stay harvestable for CARCASS_LIFE seconds: stand within 2.5u,
// hold E for 1.2s -> bonus shards/oil straight into the inventory. The prompt
// arbitrates with props.js pickups (whoever emitted most recently wins; we
// re-assert ours once they clear theirs).

let harvTarget = null;
let harvHold = 0;
let myPrompt = null;
let myPromptAt = -1e9;
let otherPrompt = null;
let otherPromptAt = -1e9;
let inSelfPrompt = false;

bus.on('prompt', (p) => {
  if (inSelfPrompt) return;
  otherPrompt = p && p.text ? p.text : null;
  otherPromptAt = G.elapsed;
  if (otherPrompt) myPrompt = null; // someone took the HUD slot: drop our claim so we re-emit once they clear theirs
});

function emitPrompt(text) {
  myPrompt = text;
  myPromptAt = G.elapsed;
  inSelfPrompt = true;
  bus.emit('prompt', { source: 'carcass', priority: 1, text });
  inSelfPrompt = false;
}

function findCarcass() {
  let best = null;
  let bestD2 = HARVEST_RANGE_SQ;
  const pp = G.player.pos;
  for (let i = 0; i < G.machines.length; i++) {
    const m = G.machines[i];
    if (m.alive || m._disposed || !m._anim) continue;
    const a = m._anim;
    if (a.harvested || a.deathT < 1 || a.fadeT >= 0) continue;
    const dx = pp.x - m.group.position.x;
    const dy = pp.y - m.group.position.y;
    const dz = pp.z - m.group.position.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = m;
    }
  }
  return best;
}

function completeHarvest(m) {
  const mult = G.skills.scavenger ? 2 : 1;
  const shards = 3 * mult;
  const oil = 1 * mult;
  const wood = 1 * mult; // salvaged frame struts - wood has no other renewable source
  const hide = 1 * mult; // v4: armor crafting material (ui/menus.js EQUIPMENT section)
  G.inventory.shards += shards;
  G.inventory.oil += oil;
  G.inventory.wood += wood;
  G.inventory.hide += hide;
  bus.emit('pickup', { type: 'shards', amount: shards });
  bus.emit('pickup', { type: 'oil', amount: oil });
  bus.emit('pickup', { type: 'wood', amount: wood });
  bus.emit('pickup', { type: 'hide', amount: hide });
  bus.emit('notify', { text: 'Carcass harvested (+wood, +hide)', tone: 'good' });
  m._anim.harvested = true;
  m._anim.deadTime = CARCASS_LIFE; // jump past the persist window -> fade + despawn
  harvHold = 0;
  hideHarvestRing();
}

function updateHarvest(dt) {
  const target = findCarcass();
  if (target !== harvTarget) {
    harvTarget = target;
    harvHold = 0;
  }

  const want = target ? CARCASS_PROMPT : null;
  if (want === null) {
    if (myPrompt !== null) emitPrompt(null);
  } else if (!(otherPrompt && otherPromptAt > myPromptAt) && myPrompt !== want) {
    emitPrompt(want); // defer to a fresher external prompt, else show ours
  }

  if (target && Input.isAction('interact')) { // v5: harvest-hold via action layer
    harvHold += dt;
    _bv.set(target.group.position.x, target.group.position.y + 1.7, target.group.position.z);
    showHarvestRing(_bv, harvHold / HARVEST_TIME);
    if (harvHold >= HARVEST_TIME) completeHarvest(target);
  } else {
    if (harvHold > 0) hideHarvestRing();
    harvHold = 0;
  }
}

// ------------------------------------------------- vantage focus scanning --
// While a focus scan is active (timeScale dropped), aiming the crosshair at a
// Vantage emits machineScanned - once per machine per 30s cooldown, shared
// with focus.js's own scanner via m._scanCd so whoever fires first gates the
// other. A short dedupe window guards the same-frame ordering race.

let selfScanEmit = false;
let extScanMachine = null;
let extScanAt = -1e9;

/** First-time scan reward: reveal the map + 2 skill points, once per Vantage. */
function grantScanReward(m) {
  if (m._ai.scanRewarded) return;
  m._ai.scanRewarded = true;
  G.mapRevealed = true;
  G.inventory.skillPoints += 2;
  bus.emit('notify', { text: 'VANTAGE UPLINK — MAP REVEALED · +2 SKILL POINTS', tone: 'good' });
}

bus.on('machineScanned', (p) => {
  const m = p && p.machine ? p.machine : null;
  // Map-reveal + 2 SP is a Vantage-only reward; guard explicitly rather than
  // relying on every future emitter of this event to already filter by type.
  if (!m || !m._ai || m.type !== 'vantage') return;
  if (selfScanEmit) return;
  extScanMachine = m;
  extScanAt = G.elapsed;
  m._ai.scanCd = SCAN_COOLDOWN; // focus.js fired first: adopt its cooldown so we never double-emit
  grantScanReward(m);
});

function updateScans() {
  if (G.timeScale > CONFIG.focusTimeScale + 0.02 || !G.cam) return;
  for (let i = 0; i < G.machines.length; i++) {
    const m = G.machines[i];
    if (!m.alive || m.type !== 'vantage' || !m._ai || m._ai.scanCd > 0) continue;
    const wp = m.weakPoints.length ? m.weakPoints[0] : null; // 'uplink' dish
    if (!wp || !wp.mesh) continue;
    wp.mesh.getWorldPosition(_v1);
    _v2.subVectors(_v1, G.cam.aimOrigin);
    const d = _v2.length();
    if (d > SCAN_RANGE || d < 0.001) continue;
    _v2.multiplyScalar(1 / d);
    if (_v2.dot(G.cam.aimDir) < SCAN_COS) continue;
    if (extScanMachine === m && G.elapsed - extScanAt < 2) continue;
    m._ai.scanCd = SCAN_COOLDOWN;
    m._scanCd = SCAN_COOLDOWN; // mirror onto focus.js's field so its scanner stays gated too
    grantScanReward(m);
    selfScanEmit = true;
    bus.emit('machineScanned', { machine: m });
    selfScanEmit = false;
  }
}

// ------------------------------------------------- v3: boss death spectacle -
// The Monarch goes out in a 2s chain of blasts layered over the standard
// tip-over; machineDied + loot already fired normally from machines.js.

const EXPL_POOL = 3;
const EXPL_PARTS = 26;
const EXPL_DUR = 0.6;
const expls = [];
let explCursor = 0;
const monarchDeaths = []; // { m, t, next }

function spawnExplosion(pos) {
  if (!G.scene) return;
  if (!expls.length) {
    for (let i = 0; i < EXPL_POOL; i++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(EXPL_PARTS * 3), 3)
          .setUsage(THREE.DynamicDrawUsage),
      );
      const mat = new THREE.PointsMaterial({
        color: 0xffa64d, size: 0.22, transparent: true, opacity: 1,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.visible = false;
      G.scene.add(pts);
      expls.push({ pts, vels: new Float32Array(EXPL_PARTS * 3), t: 0, active: false });
    }
  }
  const s = expls[explCursor];
  explCursor = (explCursor + 1) % EXPL_POOL;
  s.active = true;
  s.t = 0;
  s.pts.visible = true;
  s.pts.material.opacity = 1;
  const arr = s.pts.geometry.attributes.position.array;
  const vel = s.vels;
  for (let i = 0; i < EXPL_PARTS; i++) {
    const j = i * 3;
    arr[j] = pos.x;
    arr[j + 1] = pos.y;
    arr[j + 2] = pos.z;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    const sp = 3 + Math.random() * 7;
    vel[j] = Math.sin(ph) * Math.cos(th) * sp;
    vel[j + 1] = Math.abs(Math.cos(ph)) * sp * 0.9 + 1.5;
    vel[j + 2] = Math.sin(ph) * Math.sin(th) * sp;
  }
  s.pts.geometry.attributes.position.needsUpdate = true;
}

function updateExplosions(dt) {
  for (let i = 0; i < expls.length; i++) {
    const s = expls[i];
    if (!s.active) continue;
    s.t += dt;
    const k = s.t / EXPL_DUR;
    if (k >= 1) {
      s.active = false;
      s.pts.visible = false;
      continue;
    }
    const arr = s.pts.geometry.attributes.position.array;
    const vel = s.vels;
    for (let j = 0; j < arr.length; j += 3) {
      vel[j + 1] -= CONFIG.gravity * 0.8 * dt;
      arr[j] += vel[j] * dt;
      arr[j + 1] += vel[j + 1] * dt;
      arr[j + 2] += vel[j + 2] * dt;
    }
    s.pts.geometry.attributes.position.needsUpdate = true;
    s.pts.material.opacity = 1 - k;
  }
}

bus.on('machineDied', ({ machine }) => {
  if (!machine || machine.type !== 'monarch') return;
  removeTeleGraph(machine);
  monarchDeaths.push({ m: machine, t: 0, next: 0.05 });
});

function updateMonarchDeaths(dt) {
  for (let i = monarchDeaths.length - 1; i >= 0; i--) {
    const d = monarchDeaths[i];
    d.t += dt;
    if (d.t >= 2 || d.m._disposed) {
      monarchDeaths.splice(i, 1);
      continue;
    }
    d.next -= dt;
    if (d.next <= 0) {
      d.next = randRange(Math.random, 0.28, 0.42);
      _bv.copy(d.m.group.position);
      _bv.x += randRange(Math.random, -5, 5);
      _bv.z += randRange(Math.random, -5, 5);
      _bv.y += randRange(Math.random, 1.5, 5.5);
      spawnExplosion(_bv);
      bus.emit('camShake', { amp: 0.5 });
      sfx('machineStep', { pos: _bv, size: 2.2 });
    }
  }
}

// ------------------------------------------------------------ v3: respawns -
// Dead roster machines rebuild at their anchor with fresh state after 90s
// (alphas wait 240s); the Monarch and the Vantage are unique acts that never
// return. Respawned machines keep their alpha identity without consuming the
// seeded alpha roll stream, so v2 spawn determinism is untouched.

const respawnQueue = [];

bus.on('machineDied', ({ machine }) => {
  if (!machine || !machine._ai) return;
  if (machine.type === 'monarch' || machine.type === 'vantage') return;
  respawnQueue.push({
    type: machine.type,
    x: machine._ai.homeX, // spawn roost, not anchor - duskwings drift theirs
    z: machine._ai.homeZ,
    alpha: !!machine.alpha,
    at: G.elapsed + (machine.alpha ? RESPAWN_AFTER_ALPHA : RESPAWN_AFTER),
  });
});

function processRespawns() {
  for (let i = respawnQueue.length - 1; i >= 0; i--) {
    const r = respawnQueue[i];
    if (G.elapsed < r.at) continue;
    if (G.machines.length >= MACH_CAP) continue;
    const pp = G.player.pos;
    const dx = r.x - pp.x;
    const dz = r.z - pp.z;
    if (dx * dx + dz * dz < 12 * 12) continue; // never pop in on the player
    respawnQueue.splice(i, 1);
    const m = createMachine(r.type, r.x, r.z);
    initAI(m, G.machines.length);
    if (r.alpha) applyAlphaVariant(m);
    finishSpawn(m, r.type, r.x, r.z);
  }
}

// ----------------------------------------------------------- spawn/populate -

// Seeded stream for ~15% alpha rolls; deterministic because populateWorld's
// spawn order is deterministic.
const alphaRng = makeRng((CONFIG.seed ^ 0xa11a5) >>> 0);

/** Create a machine and register it in G.machines. Refuses at the cap. */
export function spawnMachine(type, x, z) {
  if (G.machines.length >= MACH_CAP) return null;
  const m = createMachine(type, x, z);
  initAI(m, G.machines.length);
  if (type !== 'monarch' && alphaRng() < 0.15) applyAlphaVariant(m); // boss is never an alpha
  finishSpawn(m, type, x, z);
  return m;
}

// v4: Hardened difficulty scales every spawn (initial population AND
// respawns), multiplying rather than overwriting so it compounds cleanly
// with the alpha variant's own damageMul/hp bump. Machines already alive
// when the setting changes keep their original numbers until they respawn.
const HARDENED_DMG_MUL = 1.3;
const HARDENED_HP_MUL = 1.2;

/** Shared tail of spawnMachine + respawn: placement tweak + registration. */
function finishSpawn(m, type, x, z) {
  if (type === 'duskwing') m.group.position.y = heightAt(x, z) + DUSKWING_CRUISE;
  // Wave E: BOTH machine-record creation points (spawnMachine above and
  // processRespawns) funnel through this tail, so attaching here gives every
  // new record exactly one animator - the idempotency guard inside
  // attachMachineAnimator is backup, not the primary invariant. Attach failure
  // must never block a spawn (subsystems never crash boot).
  try {
    attachMachineAnimator(m);
  } catch (err) {
    console.error('[ai] animator attach failed:', err);
  }
  if (G.settings.difficulty === 'hardened') {
    m.damageMul = (m.damageMul || 1) * HARDENED_DMG_MUL;
    m.maxHp = Math.round(m.maxHp * HARDENED_HP_MUL);
    m.hp = m.maxHp;
  }
  G.machines.push(m);
}

/**
 * Deterministic scenic spawn layout covering all nine roster types: the v2
 * layout (3 skitter, 3 bramblehorn, 2 rendclaw, 1 ironmaw, 2 duskwing,
 * 2 bulwark, 1 vantage) plus the v3 additions - 2 mirefang lairs in the
 * (0,-60) lake basin and 1 monarch on a fixed far spawn at (-180,150).
 * Legacy types keep their exact v2 rng draw order; everything keeps 15u clear
 * of the origin.
 */
export function populateWorld() {
  ensurePerception(); // v5: blackboards ready before the first machine thinks
  const rng = makeRng((CONFIG.seed ^ 0x51ab3e) >>> 0);
  const plan = [
    ['skitter', 3],
    ['bramblehorn', 3],
    ['rendclaw', 2],
    ['ironmaw', 1],
    ['duskwing', 2],
    ['bulwark', 2],
    ['vantage', 1],
    ['mirefang', 2],
    ['monarch', 1],
  ];
  const placed = [];
  for (const [type, count] of plan) {
    for (let i = 0; i < count; i++) {
      const spot = type === 'monarch'
        ? drySpotNear(-180, 150) // fixed far corner, nudged off water if needed
        : findSpot(rng, placed, type);
      if (!spot) continue;
      if (spawnMachine(type, spot.x, spot.z)) placed.push(spot);
    }
  }
}

/** Nearest dry landing for fixed spawns: spirals outward until above water. */
function drySpotNear(x, z) {
  if (heightAt(x, z) > CONFIG.waterLevel + 0.5) return { x, z };
  for (let r = 6; r <= 36; r += 6) {
    for (let a = 0; a < 12; a++) {
      const ang = (a / 12) * Math.PI * 2;
      const nx = x + Math.cos(ang) * r;
      const nz = z + Math.sin(ang) * r;
      if (Math.hypot(nx, nz) > CONFIG.playRadius - 20) continue;
      if (heightAt(nx, nz) > CONFIG.waterLevel + 0.5) return { x: nx, z: nz };
    }
  }
  return { x, z }; // trust terrain gen; moveGround keeps it sane regardless
}

function findSpot(rng, placed, type) {
  const shore = type === 'bramblehorn';
  const diver = type === 'mirefang';
  let fallback = null;
  for (let t = 0; t < 240; t++) {
    const ang = rng() * Math.PI * 2;
    let x;
    let z;
    if (shore && t < 160) {
      const r = randRange(rng, 18, 38); // ring around the lake basin
      x = Math.cos(ang) * r;
      z = -60 + Math.sin(ang) * r;
    } else if (diver) {
      const r = randRange(rng, 6, 26); // lake-bottom lairs in the same basin
      x = Math.cos(ang) * r;
      z = -60 + Math.sin(ang) * r;
    } else if (type === 'ironmaw' || type === 'bulwark') {
      const minR = type === 'ironmaw' ? 110 : 70; // far wilds
      const r = randRange(rng, minR, 190);
      x = Math.cos(ang) * r;
      z = Math.sin(ang) * r;
    } else if (type === 'vantage') {
      const r = randRange(rng, 30, 90); // open meadow room for its big loop
      x = Math.cos(ang) * r;
      z = Math.sin(ang) * r;
    } else {
      const r = randRange(rng, 35, CONFIG.playRadius * 0.72);
      x = Math.cos(ang) * r;
      z = Math.sin(ang) * r;
    }
    if (Math.hypot(x, z) < 15) continue; // keep the player spawn clear
    if (Math.hypot(x, z) > CONFIG.playRadius - 20) continue;
    const h = heightAt(x, z);
    if (diver) {
      if (h > CONFIG.waterLevel - 0.6) continue; // needs depth to stay submerged
      let spaced = true;
      for (const q of placed) {
        if (Math.hypot(q.x - x, q.z - z) < 22) {
          spaced = false;
          break;
        }
      }
      if (spaced) return { x, z };
      continue;
    }
    if (h < CONFIG.waterLevel + 0.6) continue; // dry land only
    let spaced = true;
    for (const q of placed) {
      if (Math.hypot(q.x - x, q.z - z) < 22) {
        spaced = false;
        break;
      }
    }
    if (!spaced) continue;
    if (shore && h < CONFIG.waterLevel + 5) return { x, z }; // proper shore spot
    if (!fallback) fallback = { x, z };
    if (!shore) return fallback;
  }
  if (diver) {
    // deterministic fallback lairs so the basin always has its ambushers
    const cands = [[4, -64], [-7, -57], [9, -61], [0, -60]];
    for (const [cx, cz] of cands) {
      if (heightAt(cx, cz) < CONFIG.waterLevel - 0.3) return { x: cx, z: cz };
    }
    return { x: 0, z: -60 };
  }
  return fallback;
}

// ---------------------------------------------------------- frame update ---

/**
 * v5: far machines (>90u) run their behavior FSM at <=10Hz on accumulated dt
 * while movement integrates in the same big step, so trajectories match
 * full-rate sim; moveSpeed stays warm between ticks so gaits don't stutter.
 * The Monarch is exempt (horizon spectacle + boss music need smooth motion)
 * and attack-state machines are naturally excluded - they break off at 70u.
 */
function lodFar(m, playerDistSq) {
  if (m.type === 'monarch') return false;
  return playerDistSq > LOD_DIST_SQ;
}

/** Called by main.js every frame with already-timeScaled dt. */
export function updateMachines(dt) {
  if (!G.player) return;
  ensurePerception().update(dt); // v5: blackboards think before FSMs read them
  let threatTarget = 0;
  let bossNear = false;
  for (let i = G.machines.length - 1; i >= 0; i--) {
    const m = G.machines[i];
    if (m.alive) {
      // LOD uses the distance at the start of this machine's tick. Threat and
      // boss checks share a second distance after movement so their behavior
      // remains identical to the previous post-tick checks.
      const lodDistanceSq = distSqToPlayer(m);
      if (m.staggerTimer > 0 || !m._ai) {
        m.moveSpeed = 0; // staggered: no movement, no attacks
      } else if (lodFar(m, lodDistanceSq)) {
        // v5 LOD: logic quantum accumulates, then ticks in one batch
        const ai = m._ai;
        ai._lodAcc = (ai._lodAcc || 0) + dt;
        if (ai._lodAcc >= LOD_INTERVAL) {
          tickMachine(m, ai._lodAcc);
          ai._lodAcc = 0;
        }
      } else {
        tickMachine(m, dt);
      }
      const playerDistSq = distSqToPlayer(m);
      if (m.aggro && playerDistSq < THREAT_DIST_SQ) threatTarget = 1;
      // v3: boss music layer reads this while the Monarch closes in
      if (m.type === 'monarch' && playerDistSq <= BOSS_NEAR_DIST_SQ) bossNear = true;
    }
    m.update(dt); // anim while alive, tip-over/fade/dispose while dead
    // Wave E: disposeMachine (machines.js) just dropped the record from the
    // roster + scene without knowing animators exist. Finalize ours here so an
    // authored mixer/root can never outlive its machine across kill -> respawn
    // cycles, and clear the slot so a reused record would get a FRESH animator
    // rather than silently resurrecting the disposed one. Procedural-mode
    // dispose only nulls refs; either way this runs at most once per record.
    if (m._disposed && m.animator) {
      try {
        m.animator.dispose();
      } catch (err) {
        console.error('[ai] animator dispose failed:', err);
      }
      m.animator = null;
    }
  }
  updateBolts(dt);
  updateDeflectFX(dt);
  updateScans();
  updateHarvest(dt);
  updateExplosions(dt);
  updateMonarchDeaths(dt);
  processRespawns();
  // v2: combat intensity meter for audio/hud (any aggro machine nearby -> 1)
  G.threat = damp(G.threat, threatTarget, 3, dt);
  G.bossNear = bossNear;
}
