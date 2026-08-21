// IRONWILD - machine perception + per-machine blackboards (v5 strangler layer).
// Sits UNDER the archetype FSMs in ai.js: builds awareness from sight and
// hearing on a staggered think tick, then publishes last-seen / investigate
// data that ai.js reads where it used to sight-test every machine every frame.
// Instant-reaction paths (dormant proximity wake, mirefang ambush lunge,
// monarch scripts, already-aggro pursuit) intentionally bypass this module
// and read G.player directly - see ai.js for those call sites.

import { bus } from '../core/events.js';
import { G, CONFIG } from '../core/state.js';
import { heightAt } from '../world/terrain.js';

// ------------------------------------------------------------------ tuning --

export const AWARE_SEEK = 0.35;    // crossed -> walk to the last known point
export const AWARE_AGGRO = 0.85;   // crossed -> enterAttack (legacy sight trigger)
export const INVESTIGATE_TIME = 6; // s spent closing on the last seen point
export const SEARCH_TIME = 8;      // s sweeping around it before giving up

const DECAY_RATE = 0.15;           // awareness/s bled without stimulus
const HEARD_CAP = 4;               // rolling noise memory per machine
const LOS_BUDGET = 6;              // terrain segment tests per frame, round-robin
const LOS_SAMPLES = 4;             // interior heightfield samples per segment
const LOS_CACHE_T = 1.0;           // s a terrain verdict stays trusted
const SLOTS = 8;                   // think slots; machines hash index % SLOTS

/** Think interval widens with player distance; dead/dormant machines skip. */
function thinkInterval(dist) {
  if (dist <= 40) return 0.1;
  if (dist <= 90) return 0.25;
  return 0.5;
}

// Per-type vision cones (deg) + sight ranges. Deliberately tighter than the
// legacy flat 45u SIGHT_RANGE - that tightening IS the stealth feature - but
// the <6u omni-sense cone-bypass and the concealed x0.35 falloff carry over
// from ai.js's old canSeePlayer verbatim.
const VISION = {
  skitter:     { fov: 140, range: 26 },
  rendclaw:    { fov: 120, range: 30 },
  bramblehorn: { fov: 110, range: 24 }, // data only: ai.js exempts it from initiating
  ironmaw:     { fov: 100, range: 34 },
  duskwing:    { fov: 150, range: 44 },
  bulwark:     { fov: 90,  range: 28 },
  // Lurker: surface-line eyes - swimmers are its ai.js ambush script's job,
  // so vision only registers dry-land targets
  mirefang:    { fov: 75,  range: 18, dryOnly: true },
  monarch:     { fov: 180, range: 60 }, // data only: its script never sight-aggros
};

// ------------------------------------------------------------------ factory --

/**
 * One perception instance serves the whole roster (ai.js owns the singleton).
 * Returns { update, getBlackboard, peekBlackboard, forgetMachine,
 * takeSeekHint, debugStats }.
 */
export function createPerception() {
  const boards = new Map();  // machine -> blackboard
  const losQueue = [];       // blackboards awaiting a terrain segment test
  let clock = 0;             // local accumulated (scaled) seconds
  let slotCursor = 0;
  let losUsed = 0;           // segment tests consumed by the last drain
  let pruneAt = 2;           // periodic sweep for disposed machines

  /** Create-on-demand blackboard. Fields ai.js is allowed to touch are the
   *  awareness/phase/pendingSeekPos/investigationPoint cluster. */
  function getBlackboard(m) {
    let bb = boards.get(m);
    if (!bb) {
      bb = {
        slot: slotCursor++ % SLOTS,
        lastThink: 0,
        nextThink: 0,
        lastSeenPlayerPos: null,  // Vector3 | null
        lastSeenTime: -1,
        awareness: 0,             // 0..1
        investigationPoint: null, // Vector3 | null
        lostTargetTimer: 0,
        phase: 'lost',            // track | investigate | search | lost
        heard: [],                // [{ pos, time, strength }] oldest first
        modifiers: {},            // reserved: alpha senses, weather, skills
        // internals below - not part of the published contract
        visible: false,
        lastLosAt: -1e9,
        lastLosClear: false,
        queuedLos: false,
        pendingSeekPos: null,     // edge-triggered; ai.js consumes + clears
      };
      boards.set(m, bb);
    }
    return bb;
  }

  /** Read-only lookup: undefined when no blackboard exists yet (no side effect). */
  function peekBlackboard(m) {
    return boards.get(m);
  }

  function forgetMachine(m) {
    boards.delete(m);
  }

  // -- sight ----------------------------------------------------------------

  /** Effective sight range after concealment falloff, -1 for non-roster types.
   *  Same G.player.concealed rule the legacy canSeePlayer used (x0.35 unless
   *  already aggro); plain crouching adds a milder x0.8 (new, tunable). */
  function coneRange(m, p) {
    const v = VISION[m.type];
    if (!v) return -1;
    let range = v.range;
    if (p.concealed && !m.aggro) range *= 0.35;
    else if (p.crouched && !m.aggro) range *= 0.8;
    return range;
  }

  /** FOV + range gate only - no terrain test here (that is the budgeted part). */
  function seesByCone(m, p, dist) {
    const v = VISION[m.type];
    if (!v || p.dead) return false;
    const range = coneRange(m, p);
    if (dist > range) return false;
    if (v.dryOnly && p.pos.y < CONFIG.waterLevel - 0.3) return false; // swimmer: invisible to a lurker
    if (dist < 6) return true; // close-range sense ignores the cone (legacy rule)
    const yaw = m.group.rotation.y;
    const dx = (p.pos.x - m.group.position.x) / dist;
    const dz = (p.pos.z - m.group.position.z) / dist;
    return Math.sin(yaw) * dx + Math.cos(yaw) * dz > Math.cos((v.fov * Math.PI) / 360);
  }

  /** Heightfield segment test: midpoint sampling only, no THREE.Raycaster. */
  function losClear(m, p) {
    const ax = m.group.position.x;
    const ay = m.group.position.y + 1.2; // nominal eye/chassis height
    const az = m.group.position.z;
    const bx = p.pos.x;
    const by = p.pos.y + 1.0;            // chest height
    const bz = p.pos.z;
    for (let i = 1; i <= LOS_SAMPLES; i++) {
      const t = i / (LOS_SAMPLES + 1);
      if (heightAt(ax + (bx - ax) * t, az + (bz - az) * t) >
          ay + (by - ay) * t + 0.4) return false; // 0.4 forgives brush-scale bumps
    }
    return true;
  }

  /** Drain last frame's LOS requests under the hard per-frame budget.
   *  Starved machines fall back to cone-trust for one think (see think()). */
  function drainLos() {
    losUsed = 0;
    if (!G.player) { // defensive: never leave stale queuedLos flags behind
      for (const bb of losQueue) bb.queuedLos = false;
      losQueue.length = 0;
      return;
    }
    for (let i = 0; i < losQueue.length && losUsed < LOS_BUDGET; i++) {
      const bb = losQueue[i];
      bb.queuedLos = false;
      losUsed++;
      bb.lastLosClear = losClear(bb.owner, G.player);
      bb.lastLosAt = clock;
    }
    losQueue.length = 0;
  }

  /** One staggered think for a single machine. dtThink = since last think. */
  function think(m, bb, dtThink) {
    const p = G.player;
    const mp = m.group.position;
    const dx = p.pos.x - mp.x;
    const dz = p.pos.z - mp.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Combined sight verdict: cone gate every think; terrain verdict comes
    // from the budgeted queue (fresh result trusted, else cone-trusted once).
    let visible = false;
    if (seesByCone(m, p, dist)) {
      visible = clock - bb.lastLosAt < LOS_CACHE_T ? bb.lastLosClear : true;
      if (!bb.queuedLos) {
        bb.queuedLos = true;
        bb.owner = m;
        losQueue.push(bb);
      }
    }

    if (visible) {
      if (bb.lastSeenPlayerPos) bb.lastSeenPlayerPos.copy(p.pos);
      else bb.lastSeenPlayerPos = p.pos.clone();
      bb.lastSeenTime = clock;
      bb.lostTargetTimer = 0;
      // Rise: faster up close, faster vs a moving/sprinting target, slower
      // vs cover. Tuned so point-blank aggro lands in ~0.3s (near-legacy)
      // while edge-of-cone spotting takes a couple of seconds.
      const speed = Math.sqrt(p.vel.x * p.vel.x + p.vel.z * p.vel.z);
      const moveK = 0.6 + Math.min(1, speed / 6) * 0.9 + (p.sprinting ? 0.5 : 0);
      const proxK = 1.6 - 1.1 * Math.min(1, dist / coneRange(m, p));
      const hideK = p.concealed ? 0.55 : p.crouched ? 0.8 : 1;
      bb.awareness = Math.min(1, bb.awareness + dtThink * moveK * proxK * hideK);
    } else {
      bb.awareness = Math.max(0, bb.awareness - DECAY_RATE * dtThink);
      bb.lostTargetTimer += dtThink;
    }

    // Target-loss phase machine (pure data; ai.js consumes the edges it cares
    // about - the FSM itself keeps its own suspicious timeout).
    if (bb.awareness >= AWARE_SEEK) {
      if (visible) {
        bb.phase = 'track';
        bb.investigationPoint = null;
      } else if (bb.phase === 'track') {
        bb.phase = 'investigate';
        bb.investigationPoint = bb.lastSeenPlayerPos
          ? bb.lastSeenPlayerPos.clone()
          : null;
        bb.pendingSeekPos = bb.investigationPoint
          ? bb.investigationPoint.clone()
          : null;
      } else if (bb.phase === 'investigate' && bb.lostTargetTimer >= INVESTIGATE_TIME) {
        bb.phase = 'search';
        if (bb.investigationPoint) {
          // sweep anchor drifts to a fresh offset so the search isn't static
          const rng = m._ai ? m._ai.rng : Math.random;
          const ang = rng() * Math.PI * 2;
          bb.investigationPoint.x += Math.cos(ang) * 6;
          bb.investigationPoint.z += Math.sin(ang) * 6;
        }
      } else if (bb.phase === 'search' &&
        bb.lostTargetTimer >= INVESTIGATE_TIME + SEARCH_TIME) {
        bb.phase = 'lost';
        bb.investigationPoint = null;
      }
    } else if (bb.phase !== 'lost') {
      // faded below seek: whatever we were doing, we lost the thread
      bb.phase = 'lost';
      bb.investigationPoint = null;
      bb.lostTargetTimer = 0;
    }

    bb.lastThink = clock;
    bb.nextThink = clock + thinkInterval(dist);
  }

  // -- hearing ----------------------------------------------------------------
  // Data-only mirror of ai.js's legacy noise listener (which keeps driving the
  // FSM exactly as before). We record the cue and bump awareness so the
  // blackboard stays truthful; bumps alone seek, they never insta-aggro.
  bus.on('noise', ({ pos, radius }) => {
    for (const [m, bb] of boards) {
      if (!m.alive || m.type === 'vantage') continue; // peaceful scanners ignore the racket
      const d = m.group.position.distanceTo(pos);
      if (d > radius) continue; // legacy hard-radius gate, now with decay data
      const strength = Math.min(1, Math.max(0.4, radius / 40)); // bigger racket = harder cue
      const prox = 1 - d / radius;                              // 0 at the fringe, 1 on top of it
      bb.heard.push({ pos: pos.clone(), time: clock, strength: strength * prox });
      if (bb.heard.length > HEARD_CAP) bb.heard.shift();
      bb.awareness = Math.min(1, bb.awareness + 0.5 * strength * prox);
      if (bb.awareness >= AWARE_SEEK && bb.phase === 'lost') {
        bb.phase = 'investigate';
        bb.investigationPoint = pos.clone();
        bb.pendingSeekPos = pos.clone();
      }
    }
  });

  // -- frame update --------------------------------------------------------------

  function update(dt) {
    if (!G.player) return;
    clock += dt;
    drainLos(); // resolve last frame's requests before scheduling new thinks
    if (clock >= pruneAt) {
      pruneAt = clock + 2;
      for (const m of boards.keys()) {
        if (m._disposed) boards.delete(m); // safe to delete during Map iteration
      }
    }
    for (const [m, bb] of boards) {
      if (!m.alive || !m._ai) continue;
      if (m.type === 'vantage') continue;       // peaceful scanner: no threat model
      if (m._ai.state === 'dormant') continue;  // asleep: proximity wake is ai.js's job
      if (clock < bb.nextThink) continue;
      think(m, bb, Math.min(clock - bb.lastThink, 0.6));
    }
  }

  /** Consume-and-clear seek hint; null when none pending (edge-triggered). */
  function takeSeekHint(m) {
    const bb = boards.get(m);
    if (!bb || !bb.pendingSeekPos) return null;
    const pos = bb.pendingSeekPos;
    bb.pendingSeekPos = null;
    return pos;
  }

  function debugStats() {
    let aggro = 0;
    let seek = 0;
    let sum = 0;
    for (const bb of boards.values()) {
      sum += bb.awareness;
      if (bb.awareness >= AWARE_AGGRO) aggro++;
      else if (bb.awareness >= AWARE_SEEK) seek++;
    }
    return {
      tracked: boards.size,
      aggroReady: aggro,
      seeking: seek,
      avgAwareness: boards.size ? sum / boards.size : 0,
      losTestsLastDrain: losUsed,
    };
  }

  return { update, getBlackboard, peekBlackboard, forgetMachine, takeSeekHint, debugStats };
}
