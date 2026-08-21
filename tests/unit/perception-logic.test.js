// IRONWILD - unit tests for src/machines/perception.js (v5 strangler layer).
// Pure blackbook logic in a node env: vi.resetModules() + dynamic imports give
// each test a fresh bus/G/perception triple (status-burn pattern). terrain.js
// is mocked flat so the budgeted heightfield LOS is always clear and every
// simulated think is fully deterministic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

vi.mock('../../src/world/terrain.js', () => ({ heightAt: () => 0 }));

async function loadFresh() {
  vi.resetModules();
  const [events, state, perception] = await Promise.all([
    import('../../src/core/events.js'),
    import('../../src/core/state.js'),
    import('../../src/machines/perception.js'),
  ]);
  return { bus: events.bus, G: state.G, ...perception };
}

/** Player double covering every field perception reads (pos/vel/dead/conceal...). */
function makePlayer(x = 0, z = 10) {
  return {
    pos: new THREE.Vector3(x, 0, z),
    vel: new THREE.Vector3(), // stationary: baseline rise rate
    dead: false,
    concealed: false,
    crouched: false,
    sprinting: false,
  };
}

/**
 * Machine double with the minimum surface perception touches: alive flag,
 * group transform (seesByCone reads rotation.y; hearing reads position) and
 * the _ai.state gate ('dormant' boards are skipped by update()).
 */
function makeMachine({ type = 'skitter', x = 0, z = 0, yaw = 0, state = 'patrol' } = {}) {
  return {
    type,
    alive: true,
    aggro: false,
    group: { position: new THREE.Vector3(x, 0, z), rotation: { y: yaw } },
    _ai: { state },
  };
}

describe('perception tuning exports (contract pins)', () => {
  it('exposes the awareness thresholds and phase timers the FSM reads', async () => {
    const mod = await import('../../src/machines/perception.js');
    expect(typeof mod.AWARE_SEEK).toBe('number');
    expect(typeof mod.AWARE_AGGRO).toBe('number');
    expect(typeof mod.INVESTIGATE_TIME).toBe('number');
    expect(typeof mod.SEARCH_TIME).toBe('number');
    // Exact values pinned: ai.js escalation logic is tuned against them.
    expect(mod.AWARE_SEEK).toBe(0.35);
    expect(mod.AWARE_AGGRO).toBe(0.85);
    expect(mod.INVESTIGATE_TIME).toBe(6);
    expect(mod.SEARCH_TIME).toBe(8);
  });
});

describe('blackboard registry', () => {
  beforeEach(() => vi.resetModules());

  it('getBlackboard returns the identical board object on repeat lookups', async () => {
    const { createPerception } = await loadFresh();
    const P = createPerception();
    const m = makeMachine();
    const bb1 = P.getBlackboard(m);
    const bb2 = P.getBlackboard(m);
    expect(bb1).toBe(bb2);
    expect(P.peekBlackboard(m)).toBe(bb1);
  });

  it('each machine owns a separate board (no cross-talk)', async () => {
    const { createPerception } = await loadFresh();
    const P = createPerception();
    const a = makeMachine({ x: 0 });
    const b = makeMachine({ x: 50 });
    const bba = P.getBlackboard(a);
    const bbb = P.getBlackboard(b);
    expect(bba).not.toBe(bbb);
    bba.awareness = 1;
    expect(bbb.awareness).toBe(0);
  });

  it('peekBlackboard never creates a board as a side effect', async () => {
    const { createPerception } = await loadFresh();
    const P = createPerception();
    const m = makeMachine();
    expect(P.peekBlackboard(m)).toBeUndefined();
    expect(P.debugStats().tracked).toBe(0);
  });

  it('forgetMachine removes the board; the next getBlackboard builds a fresh zeroed one', async () => {
    const { createPerception } = await loadFresh();
    const P = createPerception();
    const m = makeMachine();
    const stale = P.getBlackboard(m);
    stale.awareness = 0.9;
    stale.pendingSeekPos = new THREE.Vector3(1, 0, 1);
    P.forgetMachine(m);
    expect(P.peekBlackboard(m)).toBeUndefined();
    const fresh = P.getBlackboard(m);
    expect(fresh).not.toBe(stale);
    expect(fresh.awareness).toBe(0);
    expect(fresh.phase).toBe('lost');
    expect(fresh.heard).toEqual([]);
  });
});

describe('awareness dynamics over simulated update(dt)', () => {
  beforeEach(() => vi.resetModules());

  it('rises monotonically toward 1 while the player stands in the vision cone', async () => {
    const { G, createPerception } = await loadFresh();
    G.player = makePlayer(0, 10); // 10u ahead of a +Z-facing skitter (range 26)
    const P = createPerception();
    const m = makeMachine(); // origin, yaw 0 -> player dead-center in the FOV
    const bb = P.getBlackboard(m);
    expect(bb.awareness).toBe(0);

    const samples = [];
    for (let i = 0; i < 40; i++) { // 4 simulated seconds @0.1s thinks (dist<=40)
      P.update(0.1);
      samples.push(bb.awareness);
    }
    expect(samples[0]).toBeGreaterThan(0); // very first think already gains
    expect(samples[9]).toBeGreaterThan(samples[0]); // monotonic climb...
    expect(samples[19]).toBeGreaterThanOrEqual(samples[9]);
    expect(bb.awareness).toBe(1); // capped exactly at 1 (crossed aggro earlier)
    expect(P.peekBlackboard(m).visible).toBe(true);
  });

  it('decays toward exactly 0 without stimulus and ends in the lost phase', async () => {
    const { G, createPerception, INVESTIGATE_TIME, SEARCH_TIME } = await loadFresh();
    G.player = makePlayer(0, 10);
    const P = createPerception();
    const m = makeMachine();
    const bb = P.getBlackboard(m);
    for (let i = 0; i < 40; i++) P.update(0.1); // fully alerted
    expect(bb.awareness).toBe(1);

    // player vanishes beyond every sight range -> pure DECAY_RATE bleed
    G.player.pos.set(400, 0, 400);
    for (let i = 0; i < 300; i++) P.update(0.1); // 30s: covers 6s investigate + 8s search
    expect(INVESTIGATE_TIME + SEARCH_TIME).toBeLessThan(30); // sanity on the sim length
    expect(bb.awareness).toBe(0); // floored at exactly 0
    expect(bb.phase).toBe('lost');
    expect(bb.investigationPoint).toBeNull();
    expect(P.takeSeekHint(m)).toBeNull(); // stale hints die with the thread
  });
});

describe('hearing buffer', () => {
  beforeEach(() => vi.resetModules());

  it('caps the rolling heard memory at 4 entries, dropping the oldest first', async () => {
    const { bus, createPerception } = await loadFresh();
    const P = createPerception();
    const m = makeMachine(); // 4u from the noise source, well inside radius 40
    const bb = P.getBlackboard(m);
    for (let i = 0; i < 6; i++) {
      bus.emit('noise', { pos: new THREE.Vector3(4, 0, 0), radius: 40 });
      expect(bb.heard.length).toBeLessThan(5); // never exceeds the cap mid-burst
    }
    expect(bb.heard).toHaveLength(4);
    // strength = min(1, 40/40) * prox(1 - 4/40) = 0.9 for every identical cue
    for (const h of bb.heard) expect(h.strength).toBeCloseTo(0.9, 10);
    // six bumps of 0.5*1*0.9 = 0.45 each push awareness past the cap
    expect(bb.awareness).toBe(1);
  });

  it('vantage scanners ignore noise entirely', async () => {
    const { bus, createPerception } = await loadFresh();
    const P = createPerception();
    const v = makeMachine({ type: 'vantage' });
    const bb = P.getBlackboard(v);
    bus.emit('noise', { pos: new THREE.Vector3(1, 0, 0), radius: 40 });
    expect(bb.heard).toHaveLength(0);
    expect(bb.awareness).toBe(0);
  });
});

describe('seek hints (edge-triggered)', () => {
  beforeEach(() => vi.resetModules());

  it('a strong-enough noise arms pendingSeekPos exactly once: first take wins, second is null', async () => {
    const { bus, createPerception } = await loadFresh();
    const P = createPerception();
    const m = makeMachine();
    P.getBlackboard(m);
    // bump = 0.5 * strength(1) * prox(0.9) = 0.45 >= AWARE_SEEK(0.35)
    bus.emit('noise', { pos: new THREE.Vector3(4, 0, 0), radius: 40 });
    const hint = P.takeSeekHint(m);
    expect(hint).not.toBeNull();
    expect(hint).toBeInstanceOf(THREE.Vector3);
    expect(hint.x).toBe(4);
    expect(hint.z).toBe(0);
    expect(P.takeSeekHint(m)).toBeNull(); // consume-and-clear: no double fire
  });

  it('returns null for unknown machines or quiet boards', async () => {
    const { createPerception } = await loadFresh();
    const P = createPerception();
    const stranger = makeMachine({ x: 999 });
    expect(P.takeSeekHint(stranger)).toBeNull(); // no board ever created
    const m = makeMachine();
    P.getBlackboard(m);
    expect(P.takeSeekHint(m)).toBeNull(); // board exists, nothing pending
  });

  it('debugStats buckets tracked machines by threshold', async () => {
    const { createPerception, AWARE_SEEK, AWARE_AGGRO } = await loadFresh();
    const P = createPerception();
    const calm = makeMachine({ x: 0 });
    const seeking = makeMachine({ x: 100 });
    const aggro = makeMachine({ x: 200 });
    P.getBlackboard(calm);
    P.getBlackboard(seeking).awareness = AWARE_SEEK + 0.01;
    P.getBlackboard(aggro).awareness = AWARE_AGGRO + 0.01;
    const stats = P.debugStats();
    expect(stats.tracked).toBe(3);
    expect(stats.seeking).toBe(1);
    expect(stats.aggroReady).toBe(1);
    expect(stats.avgAwareness).toBeGreaterThan(0);
  });
});
