// IRONWILD - unit tests for Wave E animation metadata + runtime contracts:
//   src/anim/events.js  - parseClipName / attachEvents / attachAttackWindows /
//                         activeWindowProgress
//   src/anim/graph.js   - createAnimGraph discovery + safe empty-clips mode
//
// Everything here runs headless: events.js needs only a duck-typed Action
// ({ time, getClip() }), and graph.js is exercised either in its no-mixer mode
// or against a plain THREE.Object3D root (AnimationMixer.update is pure math -
// no WebGL, no rAF). Timing assertions are limited to what mixer.update()
// determines synchronously; crossfade blending curves are NOT asserted.
//
// The bus is a module-level singleton, so every test unsubscribes its
// 'animEvent' recorder in afterEach to stay isolated.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { bus } from '../../src/core/events.js';
import {
  parseClipName,
  attachEvents,
  attachAttackWindows,
  activeWindowProgress,
} from '../../src/anim/events.js';
import { createAnimGraph } from '../../src/anim/graph.js';

/** Duck-typed AnimationAction: exactly what events.js reads. */
function fakeAction(name = 'clipA', time = 0) {
  return { time, getClip: () => ({ name }) };
}

describe('parseClipName variants', () => {
  it('splits loc_/act_/react_ prefixes into kind/family/move', () => {
    expect(parseClipName('loc_walk')).toEqual({ kind: 'loc', family: 'walk', move: null });
    expect(parseClipName('act_bow_draw')).toEqual({ kind: 'act', family: 'bow', move: 'draw' });
    expect(parseClipName('act_spear_thrust')).toEqual({ kind: 'act', family: 'spear', move: 'thrust' });
    expect(parseClipName('react_hit')).toEqual({ kind: 'react', family: 'hit', move: null });
    expect(parseClipName('react_hit_light')).toEqual({ kind: 'react', family: 'hit', move: 'light' });
  });

  it('joins multi-token moves back with underscores', () => {
    expect(parseClipName('react_death_big_machine')).toEqual({
      kind: 'react',
      family: 'death',
      move: 'big_machine',
    });
  });

  it('unknown prefixes yield kind:null but keep bucketable family/move', () => {
    expect(parseClipName('custom_beat_x')).toEqual({ kind: null, family: 'beat', move: 'x' });
    expect(parseClipName('vfx_burst')).toEqual({ kind: null, family: 'burst', move: null });
  });

  it('empty/garbage input degrades to all-null instead of throwing', () => {
    expect(parseClipName('')).toEqual({ kind: null, family: null, move: null });
    expect(parseClipName(null)).toEqual({ kind: null, family: null, move: null });
    expect(parseClipName(undefined)).toEqual({ kind: null, family: null, move: null });
  });

  it('lowercases only the kind token; family keeps author casing', () => {
    // Actual contract: `head.toLowerCase()` drives kind matching, everything
    // else passes through untouched.
    expect(parseClipName('LOC_Walk')).toEqual({ kind: 'loc', family: 'Walk', move: null });
  });
});

describe('attachEvents timeline firing', () => {
  let events;
  let unsub;
  beforeEach(() => {
    events = [];
    unsub = bus.on('animEvent', (e) => events.push(e));
  });
  afterEach(() => unsub());

  it('fires every beat crossed by a large forward step, ordered by t', () => {
    const action = fakeAction();
    const ctl = attachEvents(action, [
      { t: 0.9, name: 'c' },
      { t: 0.2, name: 'a', data: { pow: 3 } },
      { t: 0.5, name: 'b' },
    ]);
    action.time = 1.0;
    ctl.update();
    expect(events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(events.every((e) => e.source === 'clipA')).toBe(true);
    expect(events[0].data).toEqual({ pow: 3 }); // payload rides along untouched
  });

  it('never duplicates on repeated update() calls within one frame', () => {
    const action = fakeAction();
    const ctl = attachEvents(action, [{ t: 0.4, name: 'hit' }]);
    action.time = 0.5;
    ctl.update();
    ctl.update(); // same playhead: strictly-forward rule suppresses refire
    ctl.update();
    expect(events).toHaveLength(1);
  });

  it('drains the old loop tail BEFORE new-loop beats inside one wrap update', () => {
    // Constructed AT time 0.85 so the controller's baseline is mid-loop and
    // tail@0.9 is still pending when the seam is crossed.
    const action = fakeAction('loopClip', 0.85);
    const ctl = attachEvents(action, [
      { t: 0.1, name: 'head' },
      { t: 0.9, name: 'tail' },
    ]);
    ctl.update(); // t === last: nothing pending yet
    expect(events).toHaveLength(0);

    // One update spanning the loop seam: tail of the OLD loop first, then the
    // head of the NEW one - order matters for downstream swing/impact sync.
    action.time = 0.2;
    ctl.update();
    expect(events.map((e) => e.name)).toEqual(['tail', 'head']);
    expect(events[0].source).toBe('loopClip');
  });

  it('refires the beat on every playhead wrap (a backward jump IS the wrap signal)', () => {
    const action = fakeAction();
    const ctl = attachEvents(action, [{ t: 0.3, name: 'step' }]);
    // Real LoopRepeat actions wrap action.time to modulo duration, so each new
    // cycle shows up here as time going backwards; forward-only intervals
    // deliberately never refire on monotonic time.
    for (const t of [0.35, 0.15, 0.35, 0.15, 0.35]) {
      action.time = t;
      ctl.update();
    }
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.name === 'step')).toBe(true);
  });

  it('reset() re-arms at the current playhead and drops already-passed beats', () => {
    const action = fakeAction();
    const ctl = attachEvents(action, [{ t: 0.5, name: 'mid' }]);
    action.time = 0.45;
    ctl.update();
    expect(events).toHaveLength(0);

    // Beat 0.5 was crossed WITHOUT an update call; reset() adopts the new
    // playhead so the stale beat is dropped rather than fired late.
    action.time = 0.8;
    ctl.reset();
    ctl.update();
    expect(events).toHaveLength(0);
  });

  it('filters malformed defs and tolerates empty lists', () => {
    const action = fakeAction();
    const ctl = attachEvents(action, [
      null,
      { t: 'nope', name: 'bad-t' },
      { t: 0.3, name: 42 },
      { t: 0.3 }, // missing name
      { t: 0.3, name: 'good' },
    ]);
    action.time = 0.5;
    expect(() => attachEvents(null, [{ t: 0.1, name: 'x' }])).not.toThrow();
    expect(() => attachEvents(action, []).update()).not.toThrow();
    ctl.update();
    expect(events.map((e) => e.name)).toEqual(['good']);
  });

  it("falls back to source:'unknown' when getClip() throws", () => {
    const action = { time: 0, getClip: () => { throw new Error('detached'); } };
    const ctl = attachEvents(action, [{ t: 0.1, name: 'boom' }]);
    action.time = 0.2;
    ctl.update();
    expect(events[0].source).toBe('unknown');
  });
});

describe('attack windows (attachAttackWindows / activeWindowProgress)', () => {
  it('returns -1 without windows or with a zero-length active window', () => {
    const action = fakeAction(null, 0.5);
    expect(activeWindowProgress(action)).toBe(-1); // nothing attached
    attachAttackWindows(action, { anticipation: 0.5, active: 0, recovery: 0.2 });
    expect(activeWindowProgress(action)).toBe(-1); // active<=0: no damage window
  });

  it('progress spans [anticipation, anticipation+active] inclusive, 0..1', () => {
    const action = fakeAction(null, 0);
    attachAttackWindows(action, { anticipation: 0.5, active: 0.25 });
    action.time = 0.49;
    expect(activeWindowProgress(action)).toBe(-1); // before window
    action.time = 0.5; // exact start -> 0
    expect(activeWindowProgress(action)).toBe(0);
    action.time = 0.625; // midpoint
    expect(activeWindowProgress(action)).toBeCloseTo(0.5, 10);
    action.time = 0.75; // exact end stays INCLUSIVE -> 1
    expect(activeWindowProgress(action)).toBeCloseTo(1, 10);
    action.time = 0.76;
    expect(activeWindowProgress(action)).toBe(-1); // recovery phase
  });

  it('negative/NaN fields clamp to 0 (defensive against bad authoring data)', () => {
    const action = fakeAction(null, 0.5);
    const meta = attachAttackWindows(action, { anticipation: -0.5, active: -1, recovery: NaN });
    expect(meta).toEqual({ anticipation: 0, active: 0, recovery: 0 });
  });

  it('re-attaching overwrites the previous definition (idempotent single source)', () => {
    const action = fakeAction(null, 0.5);
    attachAttackWindows(action, { anticipation: 0.4, active: 0.3 });
    const meta = attachAttackWindows(action, { anticipation: 0, active: 1 });
    expect(meta).toEqual({ anticipation: 0, active: 1, recovery: 0 });
    // Only the LATEST declaration drives progress: 0.5 sits mid-window now.
    expect(activeWindowProgress(action)).toBeCloseTo(0.5, 10);
    expect(activeWindowProgress(null)).toBe(-1); // null action can't be in-window
  });
});

describe('createAnimGraph: empty-clips / no-root safety', () => {
  it.each([
    ['null root, undefined clips', () => createAnimGraph(null)],
    ['null root, empty array', () => createAnimGraph(null, [])],
    ['object root, empty array', () => createAnimGraph(new THREE.Object3D(), [])],
  ])('%s degrades every method to a safe no-op', (_label, make) => {
    const g = make();
    expect(g.mixer).toBeNull();
    expect(g.clips).toEqual({ locomotion: {}, actions: {}, reactions: {} });
    expect(g.currentState).toBeNull();
    expect(g.busyLocked).toBe(false);

    expect(() => g.update(0.016, { speed: 9 })).not.toThrow();
    expect(() => g.update(0)).not.toThrow(); // non-positive dt path too
    expect(g.crossFadeTo('idle')).toBe(false);

    const h = g.playAction('bow_draw');
    expect(h.done).toBeInstanceOf(Promise);
    expect(h.action).toBeNull();
    expect(() => h.setTimeScale(2)).not.toThrow();
    const r = g.playReaction('hit', { priority: 2 });
    expect(r.done).toBeInstanceOf(Promise);
    expect(r.action).toBeNull();

    expect(g.addAdditiveChannel('aim', 'aim_pose')).toBeNull();
    expect(() => g.dispose()).not.toThrow();
  });

  it('clips present but root null also stays in no-op mode', () => {
    const g = createAnimGraph(null, [new THREE.AnimationClip('loc_idle', 1, [])]);
    expect(g.mixer).toBeNull();
    // Discovery still ran (buckets are pure data), playback just cannot start.
    expect(Object.keys(g.clips.locomotion)).toEqual(['idle']);
    expect(g.playAction('bow_draw').action).toBeNull();
  });

  it('IK hooks fire even without a mixer, and one throwing hook cannot break update()', () => {
    const g = createAnimGraph(new THREE.Object3D(), []);
    const seen = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    g.setFootIK((graph, dt) => seen.push(['foot', dt]));
    g.setHandIK(() => { throw new Error('ik exploded'); });
    expect(() => g.update(0.05, {})).not.toThrow();
    expect(seen).toEqual([['foot', 0.05]]); // healthy hook unaffected
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
    g.setFootIK(null); // clearing hooks is part of the contract
    g.setHandIK('garbage'); // non-functions are ignored, not stored
    expect(() => g.update(0.05, {})).not.toThrow();
  });
});

describe('createAnimGraph: convention-driven clip discovery', () => {
  /** Build the hunter's canonical clip set plus decoys. */
  function makeClips() {
    return [
      new THREE.AnimationClip('loc_idle', 1, []),
      new THREE.AnimationClip('loc_walk_fwd', 1, []),
      new THREE.AnimationClip('act_bow_draw', 0.5, []),
      new THREE.AnimationClip('act_bow_release', 0.3, []),
      new THREE.AnimationClip('react_hit', 0.4, []),
      new THREE.AnimationClip('loc_idle', 2, []), // duplicate variant: first wins
      new THREE.AnimationClip('foo_bar', 1, []), // unknown prefix: ignored
    ];
  }

  it('buckets loc_/act_/react_ by family_move, deduping to the FIRST variant', () => {
    const clips = makeClips();
    const g = createAnimGraph(new THREE.Object3D(), clips);
    expect(g.mixer).toBeTruthy();
    expect(g.clips.locomotion).toEqual({ idle: clips[0], walk_fwd: clips[1] });
    expect(g.clips.actions).toEqual({ bow_draw: clips[2], bow_release: clips[3] });
    expect(g.clips.reactions).toEqual({ hit: clips[4] });
    // Duplicate dedupe kept the FIRST loc_idle, not the later variant.
    expect(g.clips.locomotion.idle.duration).toBe(1);
    // Unknown prefixes land nowhere.
    const allBuckets = { ...g.clips.locomotion, ...g.clips.actions, ...g.clips.reactions };
    expect(allBuckets.bar).toBeUndefined();
  });

  it('primes the base pose on construction (idle blended in before any update)', () => {
    const g = createAnimGraph(new THREE.Object3D(), makeClips());
    expect(g.currentState).toBe('idle');
  });

  it('one-shot lifecycle: handle shape, lock freeze, synchronous-math finish', async () => {
    const g = createAnimGraph(new THREE.Object3D(), makeClips());
    const handle = g.playAction('bow_draw', { fade: 0, lockLayers: true });
    expect(handle.action).toBeTruthy();
    expect(handle.action.isRunning()).toBe(true);
    expect(handle.setTimeScale).toBeInstanceOf(Function);
    expect(g.busyLocked).toBe(true); // locomotion switching frozen mid-action

    // Mixer.update is pure math: advancing past the 0.5s clip fires the
    // 'finished' path synchronously - no rAF involved.
    g.update(0.6, { speed: 0 });
    await handle.done; // resolves via the mixer's finished event
    expect(g.busyLocked).toBe(false);
  });

  it('reaction priority arbitration drops weaker requests deterministically', async () => {
    const g = createAnimGraph(new THREE.Object3D(), makeClips());
    const strong = g.playReaction('hit', { priority: 1, fade: 0 });
    expect(strong.action).toBeTruthy();
    const weak = g.playReaction('hit', { priority: 0, fade: 0 });
    expect(weak.action).toBeNull(); // dropped: below the running reaction
    expect(weak.done).toBeInstanceOf(Promise); // dropped requests still resolve

    g.update(0.5, {}); // let the strong reaction finish
    await strong.done;
  });

  it('additive channel registration returns a live controller when the clip exists', () => {
    const g = createAnimGraph(new THREE.Object3D(), [
      new THREE.AnimationClip('act_aim_pose', 1, []),
    ]);
    const ch = g.addAdditiveChannel('aim', 'aim_pose', { lambda: 8 });
    expect(ch).toBeTruthy();
    expect(ch.action.blendMode).toBe(THREE.AdditiveAnimationBlendMode);
    ch.setTarget(1);
    ch.setTarget(7); // clamped into [0,1]
    g.update(0.1, { aiming: true });
    expect(ch.action.getEffectiveWeight()).toBeGreaterThan(0);
    expect(g.addAdditiveChannel('aim', 'missing_clip')).toBeNull();
  });
});
