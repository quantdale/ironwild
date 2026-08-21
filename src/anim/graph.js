// IRONWILD - Wave E animation runtime: AnimGraph over THREE.AnimationMixer.
// A thin game-specific graph for authored GLB clips discovered purely by naming
// convention (loc_* / act_* / react_*), with a clean procedural fallback: with
// zero clips every method degrades to a safe no-op instead of throwing, so
// callers can wire this up before any animation art lands.
//
// Layering limitation (three r166 has no runtime bone-mask system): an Action
// cannot be restricted to a bone subset after load, so the "upper-body layer"
// relies on either (a) authored upper-body-only clips played at full weight on
// top of locomotion, or (b) clips imported with AdditiveAnimationBlendMode and
// weight-blended over the base pose. Both are supported here; full-body
// one-shots simply draw over the legs visually while the locomotion state
// machine keeps driving the root.

import * as THREE from 'three';
import { CONFIG } from '../core/state.js';
import { parseClipName } from './events.js';

const LOCO_FADE = 0.18;  // ground-to-ground crossfade
const AIR_FADE = 0.12;   // airborne/swim transitions read better snappy
const LAND_HOLD = 0.28;  // seconds kept in 'land' after touchdown
const IDLE_SPEED = 0.4;  // planar speed below which we fold back to idle

// Speed brackets for walk/run/sprint. Machines report wildly different
// moveSpeed ranges, so brackets are anchored on the hunter's own speeds
// (CONFIG) rather than absolute units: anything up to a brisk walk -> walk,
// up to sprint pace -> run, beyond -> sprint.
const WALK_TOP = CONFIG.playerSpeedWalk + 1.2;
const RUN_TOP = CONFIG.playerSpeedSprint + 0.4;

// Fallback chains when a specific clip is missing (e.g. no sprint clip yet).
const LOCO_FALLBACK = {
  idle: [],
  walk: ['idle'],
  run: ['walk', 'idle'],
  sprint: ['run', 'walk', 'idle'],
  crouch: ['walk', 'idle'],
  swim: ['idle'],
  jump: ['idle'],
  land: ['idle'],
};

const KIND_MAP = { loc: 'locomotion', act: 'actions', react: 'reactions' };

/** Shared inert handle so empty-clips mode allocates nothing per call. */
const DUMMY_HANDLE = { done: Promise.resolve(), setTimeScale() {}, action: null };

/**
 * Build an AnimGraph for `root` from an optional array of AnimationClips.
 * Clips are bucketed by prefix:
 *   loc_<state>            -> locomotion states (idle/walk/run/sprint/crouch/
 *                             swim/jump/land)
 *   act_<family>_<move>    -> one-shot upper-body/full-body actions
 *   react_<family>_<move>  -> interruptible reaction one-shots (hit/death...)
 * Duplicate keys keep the first occurrence (variant dedupe).
 */
export function createAnimGraph(root, clips) {
  const list = Array.isArray(clips) ? clips : [];
  const maps = { locomotion: {}, actions: {}, reactions: {} };
  for (const clip of list) {
    if (!clip || !clip.name) continue;
    const info = parseClipName(clip.name);
    const bucket = KIND_MAP[info.kind];
    if (!bucket) continue;
    const key = [info.family, info.move].filter(Boolean).join('_');
    if (key && !(key in maps[bucket])) maps[bucket][key] = clip;
  }
  const hasClips =
    Object.keys(maps.locomotion).length +
    Object.keys(maps.actions).length +
    Object.keys(maps.reactions).length > 0;

  // No usable clips -> mixer stays null; every method checks it once and bails.
  const mixer = hasClips && root ? new THREE.AnimationMixer(root) : null;

  // ---- playback registries -------------------------------------------------
  const locoActs = new Map();     // clip -> looping AnimationAction
  const oneshots = new Map();     // action -> record (see playAction/playReaction)
  let lockCount = 0;              // live lockLayers one-shots; >0 freezes loco switching

  // ---- locomotion state machine -------------------------------------------
  let curState = null;            // currently blended-in loco state name
  let airbornePrev = false;       // edge detector for jump -> land
  let landHold = 0;               // countdown spent pinned in 'land'

  // ---- reaction stack -------------------------------------------------------
  // Highest-priority recent reaction plays; preempted ones park here with their
  // clip time and resume (from the same instant) when the stack unwinds.
  let reactCur = null;
  const reactPaused = [];

  // ---- additive channels + IK hooks -----------------------------------------
  const channels = {};            // name -> { action, weight, target, lambda }
  let footIK = null;
  let handIK = null;

  if (mixer) {
    mixer.addEventListener('finished', (e) => {
      const rec = oneshots.get(e.action);
      if (!rec) return;
      settle(rec);
      if (rec.isReact) resumeNextReaction();
    });
  }

  function settle(rec) {
    if (rec.settled) return;
    rec.settled = true;
    oneshots.delete(rec.action);
    if (rec.lockLayers) lockCount--;
    rec.resolve(); // resolves early on preemption - awaiters just want "it's over"
  }

  function resumeNextReaction() {
    const top = reactPaused.pop();
    if (!top) {
      reactCur = null;
      return;
    }
    const rec = top.rec;
    reactCur = rec;
    rec.settled = false;
    const a = rec.action;
    a.reset();
    a.setEffectiveWeight(1);
    // Resume from where the preemption froze us, clamped inside the clip.
    a.time = Math.min(top.time, Math.max(0, a.getClip().duration - 1e-3));
    a.play();
    oneshots.set(a, rec);
  }

  function locoClip(state) {
    for (const s of [state, ...(LOCO_FALLBACK[state] || [])]) {
      if (maps.locomotion[s]) return { state: s, clip: maps.locomotion[s] };
    }
    return null;
  }

  function locoAction(clip) {
    let a = locoActs.get(clip);
    if (!a) {
      a = mixer.clipAction(clip);
      locoActs.set(clip, a);
    }
    return a;
  }

  /**
   * Blend `nextState` in over `fade` seconds from `prevAction`. Falls down the
   * fallback chain when the exact state clip is absent. Returns false when
   * nothing can play.
   */
  function crossfadeFrom(prevAction, nextState, fade) {
    const found = locoClip(nextState);
    if (!found) return false;
    const next = locoAction(found.clip);
    curState = found.state;
    if (prevAction === next) return true;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (prevAction) {
      prevAction.crossFadeTo(next, Math.max(fade, 1e-4), false);
    }
    return true;
  }

  /** Pick the loco state implied by the movement params. */
  function desiredState(p) {
    if (p.swimming) return 'swim';
    if (!p.grounded) return 'jump';
    if (p.crouching) return 'crouch';
    const s = Math.max(0, Number(p.speed) || 0);
    if (s < IDLE_SPEED) return 'idle';
    if (s <= WALK_TOP) return 'walk';
    if (s <= RUN_TOP) return 'run';
    return 'sprint';
  }

  const graph = {
    /** Live clip buckets (read-only by convention): {locomotion, actions, reactions}. */
    clips: maps,
    mixer,

    get currentState() {
      return curState;
    },

    get busyLocked() {
      return lockCount > 0;
    },

    /**
     * Drive the base locomotion state machine, additive channels and IK hooks.
     * params: { speed, grounded, crouching, swimming, aiming } - all optional.
     */
    update(dt, params = {}) {
      if (!mixer || !(dt > 0)) {
        runIK(dt);
        return;
      }

      // Locomotion switching is suppressed while a lockLayers one-shot plays,
      // but the mixer keeps ticking so the action itself animates.
      if (lockCount === 0) {
        const p = {
          speed: params.speed,
          grounded: params.grounded !== false,
          crouching: !!params.crouching,
          swimming: !!params.swimming,
        };
        let want;
        if (!p.grounded) {
          want = 'jump';
          airbornePrev = true;
        } else {
          if (airbornePrev) {
            airbornePrev = false;
            landHold = LAND_HOLD; // just touched down: hold the landing pose
          }
          if (landHold > 0 && locoClip('land')) {
            landHold -= dt;
            want = 'land';
          } else {
            want = desiredState(p);
          }
        }
        if (want !== curState) {
          const found = curState != null ? locoClip(curState) : null;
          crossfadeFrom(found ? locoAction(found.clip) : null, want,
            want === 'jump' || want === 'land' || want === 'swim' ? AIR_FADE : LOCO_FADE);
        }
      }

      // Auto-drive the 'aim' additive channel from the aiming flag when the
      // integrator registered one (manual setTarget() still wins per-frame).
      if (channels.aim && params.aiming != null) {
        channels.aim.target = params.aiming ? 1 : 0;
      }
      for (const name in channels) {
        const ch = channels[name];
        ch.weight += (ch.target - ch.weight) * (1 - Math.exp(-ch.lambda * dt));
        ch.action.setEffectiveWeight(ch.weight);
      }

      mixer.update(dt);
      runIK(dt);
    },

    /** Manual locomotion switch (also used by tests/debug tooling). */
    crossFadeTo(name, fade = LOCO_FADE) {
      if (!mixer) return false;
      const prev = curState != null ? locoClip(curState) : null;
      return crossfadeFrom(
        prev ? locoAction(prev.clip) : null,
        name,
        fade,
      );
    },

    /**
     * Play a one-shot from the act_* bucket. Returns
     * { done: Promise, setTimeScale(s), action } - done resolves when the clip
     * finishes (immediately in empty-clips mode). With lockLayers the base
     * locomotion machine holds its current state until the action ends.
     */
    playAction(name, { fade = 0.12, lockLayers = false } = {}) {
      const clip = maps.actions[name];
      if (!mixer || !clip) return DUMMY_HANDLE;
      const action = mixer.clipAction(clip);
      const prior = oneshots.get(action);
      if (prior) settle(prior); // same clip replayed: release the stale handle
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      oneshots.set(action, { action, isReact: false, priority: 0, settled: false, lockLayers, resolve });
      if (lockLayers) lockCount++;
      action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
      if (fade > 0) action.fadeIn(fade);
      return { done, setTimeScale: (s) => action.setEffectiveTimeScale(s), action };
    },

    /**
     * Play a react_* one-shot with priority arbitration: a new reaction with
     * priority >= the running one preempts it (its `done` resolves early) and
     * the preempted clip resumes from the frozen instant when the newcomer
     * finishes. Lower-priority requests are dropped while something stronger
     * is on screen.
     */
    playReaction(name, { priority = 0, fade = 0.06 } = {}) {
      const clip = maps.reactions[name];
      if (!mixer || !clip) return DUMMY_HANDLE;
      if (reactCur && priority < reactCur.priority) return DUMMY_HANDLE;
      if (reactCur) {
        // Park the interrupted reaction (equal priority replaces: latest wins).
        reactPaused.push({ rec: reactCur, time: reactCur.action.time });
        reactCur.action.stop();
        settle(reactCur);
      }
      const action = mixer.clipAction(clip);
      const prior = oneshots.get(action);
      if (prior) settle(prior); // same clip replayed: release the stale handle
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      let resolve;
      const done = new Promise((r) => { resolve = r; });
      const rec = { action, isReact: true, priority, settled: false, lockLayers: false, resolve };
      oneshots.set(action, rec);
      reactCur = rec;
      action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
      if (fade > 0) action.fadeIn(fade);
      return { done, setTimeScale: (s) => action.setEffectiveTimeScale(s), action };
    },

    /**
     * Register an additive overlay channel ('aim', 'look', 'breathe'...). The
     * clip must be authored to *add* onto the base pose (small deltas), since
     * additive blending sums joint rotations on top of locomotion. Returns
     * { setTarget(w), action } or null when the clip/mixer is missing.
     */
    addAdditiveChannel(name, clipName, { lambda = 8 } = {}) {
      const clip = maps.actions[clipName] || maps.reactions[clipName];
      if (!mixer || !clip) return null;
      const action = mixer.clipAction(clip, undefined, THREE.AdditiveAnimationBlendMode);
      action.setEffectiveWeight(0);
      action.play();
      channels[name] = { action, weight: 0, target: 0, lambda: Math.max(0.001, lambda) };
      return { setTarget: (w) => { channels[name].target = Math.min(1, Math.max(0, Number(w) || 0)); }, action };
    },

    /** Post-update foot-IK hook; receives (graph, dt). Default none. */
    setFootIK(fn) {
      footIK = typeof fn === 'function' ? fn : null;
    },

    /** Post-update weapon-hand-IK hook; receives (graph, dt). Default none. */
    setHandIK(fn) {
      handIK = typeof fn === 'function' ? fn : null;
    },

    /** Release all mixer bindings. The graph is unusable afterwards. */
    dispose() {
      if (!mixer) return;
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      locoActs.clear();
      oneshots.clear();
      reactPaused.length = 0;
      reactCur = null;
      curState = null;
    },
  };

  function runIK(dt) {
    // One bad IK callback must never take down the frame loop.
    if (footIK) {
      try { footIK(graph, dt); } catch (err) { console.error('[anim] footIK error:', err); }
    }
    if (handIK) {
      try { handIK(graph, dt); } catch (err) { console.error('[anim] handIK error:', err); }
    }
  }

  // Prime the base state so the very first visible frame is posed (idle or
  // whatever fallback exists) instead of T-posing until the first transition.
  if (mixer) {
    const prime = locoClip('idle') || locoClip(Object.keys(maps.locomotion)[0] || '');
    if (prime) {
      const a = locoAction(prime.clip);
      a.reset().setEffectiveWeight(1).play();
      curState = prime.state;
    }
  }

  return graph;
}
