// IRONWILD - unit tests for src/combat/status.js (burn DoT mechanics).
// Module-level init state (inited/tick pool) is reset per test via
// vi.resetModules() + dynamic imports. Most mechanics run scene-less
// (G.scene = null): tick DAMAGE logic is fully independent of the FX pool.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { installCanvasStub } from './helpers/canvas2d.js';

const BURN_DPS = 12;
const BURN_DURATION = 4;
const TICK_INTERVAL = 0.5;
const TICK_DMG = BURN_DPS * TICK_INTERVAL; // 6

async function loadFresh() {
  vi.resetModules();
  const mods = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/combat/status.js'),
  ]);
  return { G: mods[0].G, ...mods[1] };
}

/** Minimal machine double matching the contract status.js consumes. */
function makeMachine({ hp = 100, alive = true, hitImpl } = {}) {
  const m = {
    type: 'grazer',
    name: 'test-grazer',
    hp,
    maxHp: 100,
    alive,
    radius: 2,
    group: { position: new THREE.Vector3(1, 2, 3) },
    hitCalls: [],
    hit(damage, point, weakPoint) {
      m.hitCalls.push({ damage, point, weakPoint });
      if (hitImpl) return hitImpl(damage, point, weakPoint);
      m.hp -= damage;
      if (m.hp <= 0) m.alive = false;
      return 'hit'; // any value other than false counts as landed
    },
  };
  return m;
}

describe('applyBurn validation (scene-less)', () => {
  beforeEach(() => vi.resetModules());

  it('rejects falsy machines', async () => {
    const { applyBurn } = await loadFresh();
    expect(applyBurn(null)).toBe(false);
    expect(applyBurn(undefined)).toBe(false);
  });

  it('rejects dead machines', async () => {
    const { applyBurn } = await loadFresh();
    const m = makeMachine({ alive: false });
    expect(applyBurn(m)).toBe(false);
    expect(m.burnT).toBeUndefined();
    expect(m.panic).toBeUndefined();
  });

  it('rejects machines without a hit function', async () => {
    const { applyBurn } = await loadFresh();
    const m = { alive: true }; // no hit()
    expect(applyBurn(m)).toBe(false);
    expect(m.burnT).toBeUndefined();
  });

  it('ignores negative/zero custom durations and falls back to the default', async () => {
    const { applyBurn } = await loadFresh();
    for (const seconds of [0, -1, -0.001]) {
      const m = makeMachine();
      expect(applyBurn(m, seconds)).toBe(true);
      expect(m.burnT).toBe(BURN_DURATION);
    }
  });

  it('honors positive custom durations', async () => {
    const { applyBurn } = await loadFresh();
    const m = makeMachine();
    expect(applyBurn(m, 2.5)).toBe(true);
    expect(m.burnT).toBe(2.5);
    expect(m.burnAcc).toBe(0);
  });

  it('sets the panic flag for the AI flee behavior on application', async () => {
    const { applyBurn } = await loadFresh();
    const m = makeMachine();
    applyBurn(m, 3);
    expect(m.panic).toBe(true);
    expect(m.panicT).toBe(3);
  });
});

describe('burn ticking (scene-less)', () => {
  beforeEach(() => vi.resetModules());

  it('applies one discrete tick of TICK_DMG per 0.5s of accumulated time', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine();
    G.machines = [m];
    applyBurn(m);

    updateStatusFX(TICK_INTERVAL);
    expect(m.hitCalls).toHaveLength(1);
    expect(m.hitCalls[0]).toEqual({ damage: TICK_DMG, point: null, weakPoint: null });

    updateStatusFX(TICK_INTERVAL / 2); // 0.25s: not enough to tick
    expect(m.hitCalls).toHaveLength(1);

    updateStatusFX(TICK_INTERVAL / 2); // accumulates to the next full interval
    expect(m.hitCalls).toHaveLength(2);
    expect(m.burnAcc).toBeCloseTo(0, 10);
  });

  it('a long frame yields floor(dt / interval) ticks while burn remains', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999 }); // cannot die mid-test
    G.machines = [m];
    applyBurn(m); // burnT = 4
    updateStatusFX(3); // burnT -> 1, acc 3.0 -> 6 ticks
    expect(m.hitCalls).toHaveLength(6);
    expect(m.burnT).toBeCloseTo(1, 10);
    expect(m.panicT).toBeCloseTo(1, 10);
    expect(m.panic).toBe(true);
  });

  it('refreshing restarts the full duration timer', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(1); // burnT 4 -> 3, exactly two ticks consumed
    expect(m.burnT).toBeCloseTo(3, 10);
    applyBurn(m); // refreshed
    expect(m.burnT).toBe(BURN_DURATION);
    updateStatusFX(TICK_INTERVAL);
    expect(m.hitCalls).toHaveLength(3); // 2 from the first second + 1 now
  });

  it('refreshing mid-interval resets the tick accumulator', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(0.75); // one tick fires, 0.25s carried toward the next
    expect(m.hitCalls).toHaveLength(1);
    expect(m.burnAcc).toBeCloseTo(0.25, 10);
    applyBurn(m); // refreshed: cadence restarts from zero
    expect(m.burnAcc).toBe(0);
    updateStatusFX(0.25); // stale carry would fire here; correct cadence does not
    expect(m.hitCalls).toHaveLength(1);
    updateStatusFX(0.25); // a full interval has now elapsed since the refresh
    expect(m.hitCalls).toHaveLength(2);
  });

  it('burn expires cleanly: the final fully-elapsed interval still lands', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m, 1);
    updateStatusFX(TICK_INTERVAL); // burnT 1 -> 0.5, one tick fires
    expect(m.hitCalls).toHaveLength(1);
    updateStatusFX(TICK_INTERVAL); // last 0.5s is a full elapsed interval: one more tick
    expect(m.hitCalls).toHaveLength(2);
    expect(m.burnT).toBe(0);
    expect(m.panicT).toBe(0);
    expect(m.panic).toBe(false);
  });

  it('machines without burn state are never touched', async () => {
    const { updateStatusFX } = await loadFresh();
    const m = makeMachine();
    const { G } = await import('../../src/core/state.js');
    G.machines = [m];
    updateStatusFX(2);
    expect(m.hitCalls).toHaveLength(0);
    expect(m.burnT).toBeUndefined();
  });

  it('machines burn independently of unburnt neighbors', async () => {
    const { applyBurn, updateStatusFX } = await loadFresh();
    const { G } = await import('../../src/core/state.js');
    const burning = makeMachine({ hp: 999 });
    const idle = makeMachine({ hp: 999 });
    G.machines = [burning, idle];
    applyBurn(burning);
    updateStatusFX(TICK_INTERVAL);
    expect(burning.hitCalls).toHaveLength(1);
    expect(idle.hitCalls).toHaveLength(0);
  });

  it('non-positive dt is a complete no-op for burn logic', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m);
    for (const dt of [0, -0.016]) {
      expect(() => updateStatusFX(dt)).not.toThrow();
      expect(m.burnT).toBe(BURN_DURATION);
      expect(m.hitCalls).toHaveLength(0);
    }
  });

  it('a hit() that returns false (e.g. deflect/i-frames) still advances the burn clock', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    const m = makeMachine({ hp: 999, hitImpl: () => false });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(1);
    expect(m.hitCalls).toHaveLength(2); // attempts were made...
    expect(m.burnT).toBeCloseTo(3, 10); // ...and time still elapsed
    expect(m.panic).toBe(true);
  });
});

describe('death during burn (kill-once interplay)', () => {
  beforeEach(() => vi.resetModules());

  it('stops ticking once the machine dies mid-frame and clears panic immediately', async () => {
    const { applyBurn, updateStatusFX } = await loadFresh();
    const { G } = await import('../../src/core/state.js');
    const m = makeMachine({ hp: 9 }); // two 6-dmg ticks kill it
    G.machines = [m];
    applyBurn(m); // burnT = 4
    updateStatusFX(1); // acc 1.0 -> tick1 (hp 3), tick2 (hp -3, dies)
    expect(m.alive).toBe(false);
    expect(m.hitCalls).toHaveLength(2); // no third tick attempted
    expect(m.panic).toBe(false);
    // Burn state is cleared in the same death path, not the next update pass.
    expect(m.burnT).toBe(0);
    expect(m.panicT).toBe(0);
  });

  it('the next update after death zeroes all burn state (corpses do not burn)', async () => {
    const { applyBurn, updateStatusFX } = await loadFresh();
    const { G } = await import('../../src/core/state.js');
    const m = makeMachine({ hp: 6 }); // single tick kills
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(TICK_INTERVAL);
    expect(m.alive).toBe(false);
    updateStatusFX(0.016); // corpse cleanup pass
    expect(m.burnT).toBe(0);
    expect(m.panicT).toBe(0);
    expect(m.panic).toBe(false);
    const callsAfterDeath = m.hitCalls.length;
    updateStatusFX(1); // corpse keeps taking no further burn damage
    expect(m.hitCalls).toHaveLength(callsAfterDeath);
  });
});

describe('tick-number FX pool (canvas path)', () => {
  let restore = () => {};
  beforeEach(() => {
    vi.resetModules();
    restore = installCanvasStub();
  });
  afterEach(() => restore());

  it('createStatusFX builds a 16-entry sprite pool once (idempotent)', async () => {
    const { createStatusFX } = await loadFresh();
    const { G } = await import('../../src/core/state.js');
    G.scene = new THREE.Scene();
    createStatusFX();
    expect(G.scene.children).toHaveLength(16);
    createStatusFX(); // second call must not duplicate
    expect(G.scene.children).toHaveLength(16);
    expect(G.scene.children.every((c) => c instanceof THREE.Sprite)).toBe(true);
    expect(G.scene.children.every((c) => c.visible === false)).toBe(true);
  });

  it('applyBurn lazily initializes the FX pool when a scene exists', async () => {
    const { applyBurn } = await loadFresh();
    const { G } = await import('../../src/core/state.js');
    G.scene = new THREE.Scene();
    const m = makeMachine();
    expect(applyBurn(m)).toBe(true);
    expect(G.scene.children).toHaveLength(16);
  });

  it('a landed tick spawns exactly one visible tick number', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    G.scene = new THREE.Scene();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(TICK_INTERVAL);
    const visible = G.scene.children.filter((c) => c.visible);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBeInstanceOf(THREE.Sprite);
  });

  it('a deflected tick (hit returns false) spawns no number', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    G.scene = new THREE.Scene();
    const m = makeMachine({ hp: 999, hitImpl: () => false });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(TICK_INTERVAL);
    expect(m.hitCalls).toHaveLength(1);
    expect(G.scene.children.filter((c) => c.visible)).toHaveLength(0);
  });

  it('tick numbers fade out after their 0.7s lifetime', async () => {
    const { G, applyBurn, updateStatusFX } = await loadFresh();
    G.scene = new THREE.Scene();
    const m = makeMachine({ hp: 999 });
    G.machines = [m];
    applyBurn(m);
    updateStatusFX(TICK_INTERVAL); // spawn one number
    expect(G.scene.children.filter((c) => c.visible)).toHaveLength(1);
    m.burnT = 0; // stop burning so no new numbers spawn
    updateStatusFX(0.75); // past TICK_DUR
    expect(G.scene.children.filter((c) => c.visible)).toHaveLength(0);
  });
});
