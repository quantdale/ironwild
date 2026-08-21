// IRONWILD - Wave E animation runtime: standardized machine animators.
// Wraps every roster machine in a uniform animation API so combat/VFX/audio
// code can ask for attacks, hit reactions and sockets without knowing whether
// the machine is the current procedural build or a future authored GLB.
//
// Dual-path contract:
//   - procedural (default): machines.js owns all motion channels (_anim.*);
//     this module only exposes timing metadata + socket anchors derived from
//     those builds. Damage authority stays in machines/ai.js - we never apply
//     hit damage here, we only describe WHEN it lands.
//   - authored (opt-in): only when the integrator sets machine.assetId AND
//     window.__IW_ASSETS.instantiate() resolves. The upgrade is attempted
//     asynchronously after attach; boot is never blocked and any failure just
//     keeps the procedural path. Authored rigs are assumed to share the
//     procedural convention: origin at feet, facing +Z (see machines.js).

import * as THREE from 'three';
import { G } from '../core/state.js';
import { createAnimGraph } from './graph.js';
import {
  attachEvents, attachAttackWindows, activeWindowProgress, parseClipName,
} from './events.js';

/**
 * Attack windows synthesized for the procedural roster, measured off the AI
 * state machines in machines/ai.js (telegraph length -> damage moment ->
 * recovery tail). Keyed '<type>:<attack>'; unknown combos fall through to
 * DEFAULT_WINDOW so new attacks stay playable before art lands.
 */
const ATTACK_WINDOWS = {
  'skitter:lunge':      { anticipation: 0.5, active: 0.55, recovery: 0.4 },  // crouch squat -> arcing leap -> recover
  'rendclaw:swipeL':    { anticipation: 0.3, active: 0.12, recovery: 0.35 }, // combo strike 1
  'rendclaw:swipeR':    { anticipation: 0.35, active: 0.12, recovery: 0.35 }, // combo strike 2
  'bramblehorn:kick':   { anticipation: 0.4, active: 0.15, recovery: 0.35 }, // rear-up -> hind-leg kick
  'ironmaw:dash':       { anticipation: 0.8, active: 1.1, recovery: 0.2 },   // roar telegraph -> line dash w/ contact dmg
  'ironmaw:bolt':       { anticipation: 0.6, active: 0.05, recovery: 0.25 }, // spark wind-up -> bolt release
  'duskwing:dive':      { anticipation: 0.85, active: 0.55, recovery: 0.5 }, // shadow-circle telegraph -> stoop
  'bulwark:roll':       { anticipation: 0.7, active: 1.1, recovery: 0.6 },   // quake telegraph -> tucked roll -> unroll
  'bulwark:crush':      { anticipation: 0.5, active: 0.15, recovery: 0.4 },  // rear up -> slam down
  'monarch:tail':       { anticipation: 0.4, active: 0.2, recovery: 0.35 },  // rear-arc whip (phaseT total 0.95)
};
const DEFAULT_WINDOW = { anticipation: 0.4, active: 0.15, recovery: 0.35 };

/** Metadata event beat placed mid-active-window; shape matches the bus contract. */
function windowEvents(w, attackName) {
  return [{ t: w.anticipation + w.active * 0.5, name: 'hit', data: { attack: attackName } }];
}

/**
 * Procedural anchor sockets per machine type, in machine-local coordinates
 * (feet at y=0, facing +Z) - transcribed from the body plans in machines.js.
 * Used by getSocket() when no authored rig supplies real socket_* nodes.
 */
const PROC_SOCKETS = {
  skitter:     { head: [0, 0.97, 0.87], mouth: [0, 0.78, 0.94], chest: [0, 0.75, 0], back: [0, 1.05, -0.3] },
  bramblehorn: { head: [0, 1.93, 0.79], neck: [0, 1.55, 0.56], chest: [0, 1.1, 0.32], back: [0, 1.47, -0.22] },
  rendclaw:    { head: [0, 1.52, 1.02], mouth: [0, 1.4, 1.28], chest: [0, 1.1, 0.5], back: [0, 1.36, -0.45], tail: [0, 1.26, -1.6] },
  ironmaw:     { head: [0, 0.82, 1.14], mouth: [0, 0.82, 1.14], chest: [0, 1.05, 0.85], back: [0, 1.86, -0.38] },
  duskwing:    { head: [0, 0.78, 0.66], chest: [0, 0.64, 0], wingL: [-1.36, 0.78, -0.12], wingR: [1.36, 0.78, -0.12] },
  bulwark:     { head: [0, 0.98, 1.55], chest: [0, 0.95, 0], back: [0, 1.1, -1.28] },
  vantage:     { head: [0, 4.5, 0.86], chest: [0, 2.5, 0], back: [0, 4.62, 0.7] },
  mirefang:    { head: [0, 0.66, 1.25], mouth: [0, 0.54, 2.0], chest: [0, 0.6, -0.05], back: [0, 0.92, -0.05], tail: [0, 0.62, -1.9] },
  monarch:     { head: [0, 8.85, 1.75], mouth: [0, 8.62, 2.2], chest: [0, 5.6, 1.32], back: [0, 6.93, 0.15], tail: [0, 5.0, -3.6], legL: [-1.15, 2.1, 0], legR: [1.15, 2.1, 0] },
};

/**
 * Swap an animator onto its authored rig. Accepts either the asset-pipeline
 * shape { root, clips } or a GLTF-style { scene, animations }. Returns false
 * (staying procedural) when anything is missing or no convention clips exist.
 */
function installAuthored(machine, animator, inst) {
  const root = inst && (inst.root || inst.scene);
  const clips = inst && (inst.clips || inst.animations);
  if (!root || !Array.isArray(clips) || !clips.length) return false;
  const graph = createAnimGraph(root, clips);
  if (!graph.mixer) return false; // no loc_*/act_*/react_* clips -> nothing to drive
  machine.group.add(root);
  animator.graph = graph;
  animator.root = root;
  animator.mode = 'authored';
  return true;
}

/** Locate an authored attack clip key '<family>_<move>' with graceful fallbacks. */
function findActionKey(graph, type, attackName) {
  const acts = graph.clips.actions;
  if (acts[`${type}_${attackName}`]) return `${type}_${attackName}`;
  if (acts[attackName]) return attackName;
  for (const key of Object.keys(acts)) {
    const info = parseClipName(`act_${key}`);
    if (info.family === type || info.move === attackName) return key;
  }
  return null;
}

/**
 * Attach the unified animator to `machine` SYNCHRONOUSLY (machine.animator is
 * set before this returns, always). opts: { assetOpts } forwarded to
 * window.__IW_ASSETS.instantiate(). Idempotent per machine.
 */
export function attachMachineAnimator(machine, opts = {}) {
  if (!machine || machine.animator) return machine.animator;

  const animator = {
    mode: 'procedural',      // flipped to 'authored' only if/when assets resolve
    graph: null,             // AnimGraph (authored mode only)
    root: null,              // authored scene root (socket lookups)
    assetId: machine.assetId || null,
    _machine: machine,       // backref for the per-frame locomotion feed
    _locoSpeed: null,        // explicit playLocomotion request (null = passthrough)
    _eventCtl: null,         // timeline controller of the live authored attack
    _lastAction: null,       // live attack action (for attackProgress())

    /**
     * Report desired locomotion speed. Procedural path: metadata only - ai.js
     * already writes machine.moveSpeed each frame and machines.js reads it to
     * drive the gait, so writing it here would fight the AI. Authored path:
     * consumed by the graph on the next updateMachineAnimators tick, taking
     * precedence over the machine.moveSpeed passthrough.
     */
    playLocomotion(speed) {
      animator._locoSpeed = Number(speed) || 0;
    },

    /**
     * Trigger an attack by name ('lunge', 'dash', 'bolt', 'dive'...).
     * Returns timing metadata { anticipation, active, recovery, events:[{t,name,data}] }
     * - the shared attack-timing contract. Authored path plays act_<type>_<name>
     * and attaches windows/events to the action; when the clip is missing it
     * degrades to the synthesized procedural windows so combat timing stays valid.
     * Procedural path plays nothing visually (ai.js drives channels) and still
     * returns the same contract shape.
     */
    playAttack(attackName) {
      if (!attackName) return { ...DEFAULT_WINDOW, events: [] };
      if (animator.mode === 'authored' && animator.graph) {
        const key = findActionKey(animator.graph, machine.type, attackName);
        if (key) {
          const handle = animator.graph.playAction(key, { fade: 0.08 });
          if (handle.action) {
            const clip = handle.action.getClip();
            // Authored clips carry no embedded metadata yet; split the clip
            // proportionally (35% windup / 25% active / 40% follow-through).
            // Replace with real curves when GLB extras ship timing data.
            const meta = {
              anticipation: clip.duration * 0.35,
              active: clip.duration * 0.25,
              recovery: clip.duration * 0.4,
            };
            attachAttackWindows(handle.action, meta);
            animator._eventCtl = attachEvents(handle.action, windowEvents(meta, attackName));
            animator._lastAction = handle.action;
            return { ...meta, events: windowEvents(meta, attackName) };
          }
        }
        // fall through: no such clip -> synthesized windows keep combat honest
      }
      const w = ATTACK_WINDOWS[`${machine.type}:${attackName}`] || DEFAULT_WINDOW;
      return { ...w, events: windowEvents(w, attackName) };
    },

    /** Progress (-1..1) through the ACTIVE window of the last played attack. */
    attackProgress() {
      return activeWindowProgress(animator._lastAction);
    },

    /**
     * Hit reaction. Authored: react_hit one-shot at priority scaled by strength
     * (light taps don't interrupt heavy reactions). Procedural: nudge the
     * existing flinch channel - machines.updateMachine decays it and flashes
     * the hull; applyHit() sets the same channel, this just re-emphasizes.
     */
    playHitReact(strength = 1) {
      const s = Math.min(1, Math.max(0, Number(strength) || 0));
      if (animator.mode === 'authored' && animator.graph) {
        animator.graph.playReaction('hit', { priority: s >= 0.75 ? 3 : 1 });
        return;
      }
      const a = machine._anim;
      if (a) a.flinch = Math.max(a.flinch || 0, 0.25 * s);
    },

    /**
     * Death performance. Authored: react_death at top priority. Procedural:
     * deliberate no-op - killMachine()/updateDeath() own the tip-over and fade.
     */
    playDeath() {
      if (animator.mode === 'authored' && animator.graph) {
        animator.graph.playReaction('death', { priority: 100, fade: 0.25 });
      }
    },

    /** Release authored resources (integrator may call alongside dispose()). */
    dispose() {
      if (animator.graph) {
        animator.graph.dispose();
        if (animator.root) animator.root.removeFromParent();
      }
      animator.graph = null;
      animator.root = null;
      animator.mode = 'procedural';
      animator._eventCtl = null;
      animator._lastAction = null;
    },
  };

  machine.animator = animator;

  // Optional authored upgrade. Feature-detected, promise-safe, failure-tolerant:
  // instantiate() may be sync or async; either way boot continues untouched.
  const assets = typeof window !== 'undefined' ? window.__IW_ASSETS : null;
  if (machine.assetId && assets && typeof assets.instantiate === 'function') {
    try {
      Promise.resolve(assets.instantiate(machine.assetId, opts.assetOpts || {}))
        .then((inst) => {
          if (machine._disposed) return; // died before assets landed
          installAuthored(machine, animator, inst); // false -> silently stay procedural
        })
        .catch((err) => console.error('[anim] authored rig failed, staying procedural:', err));
    } catch (err) {
      console.error('[anim] asset instantiate threw, staying procedural:', err);
    }
  }

  return animator;
}

/** Tick one animator: advance its graph, then drain its timeline events. */
function updateAnimator(animator, dt) {
  if (animator.mode !== 'authored' || !animator.graph || !(dt > 0)) return;
  // Locomotion speed source: explicit playLocomotion() request wins; otherwise
  // pass machine.moveSpeed through (ai.js writes it every frame). Machines are
  // always treated as grounded/swim-free - duskwing flight is just fast ground
  // locomotion since the AI moves the group directly.
  const m = animator._machine;
  const speed = animator._locoSpeed != null
    ? animator._locoSpeed
    : (m && m.moveSpeed) || 0;
  animator.graph.update(dt, { speed, grounded: true });
  if (animator._eventCtl) animator._eventCtl.update();
}

/**
 * Advance every attached machine animator. The integrator adds ONE call to the
 * main loop after machines tick. Per-machine isolation: a broken animator must
 * never take down the frame.
 */
export function updateMachineAnimators(dt) {
  const machines = G.machines;
  for (let i = 0; i < machines.length; i++) {
    const m = machines[i];
    if (!m || m._disposed || !m.animator) continue;
    try {
      updateAnimator(m.animator, dt);
    } catch (err) {
      console.error('[anim] machine animator update failed:', err);
    }
  }
}

/**
 * Resolve a named socket to a WORLD-space position (fresh Vector3).
 * Order: authored 'socket_<name>' node -> curated procedural anchor table ->
 * matching weak-point mesh. Returns null when nothing matches.
 */
export function getSocket(machine, name) {
  if (!machine || !name) return null;
  const an = machine.animator;
  if (an && an.mode === 'authored' && an.root) {
    const node = an.root.getObjectByName(`socket_${name}`) || an.root.getObjectByName(name);
    if (node) {
      node.updateWorldMatrix(true, false);
      return node.getWorldPosition(new THREE.Vector3());
    }
  }
  const table = PROC_SOCKETS[machine.type];
  const off = table && table[name];
  if (off) {
    machine.group.updateWorldMatrix(true, false);
    return machine.group.localToWorld(new THREE.Vector3(off[0], off[1], off[2]));
  }
  const wp = (machine.weakPoints || []).find((w) => w.name === name && w.mesh);
  if (wp) {
    wp.mesh.updateWorldMatrix(true, false);
    return wp.mesh.getWorldPosition(new THREE.Vector3());
  }
  return null;
}
