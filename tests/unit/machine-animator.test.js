// IRONWILD - unit tests for src/anim/machineAnim.js animator bookkeeping.
// Node env: no window (so the authored-asset branch is feature-detected off)
// and no WebGL - the procedural path is pure metadata, which is exactly what
// these tests pin. vi.resetModules() + dynamic imports give each test a fresh
// module registry (status-burn pattern).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

async function loadFresh() {
  vi.resetModules();
  const [state, anim] = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/anim/machineAnim.js'),
  ]);
  return { G: state.G, ...anim };
}

/** Machine double carrying only the surface machineAnim touches. */
function makeMachineDouble({ type = 'skitter' } = {}) {
  return {
    type,
    assetId: undefined, // falsy -> procedural path guaranteed
    group: new THREE.Group(),
    weakPoints: [],
    _disposed: false,
  };
}

describe('attach lifecycle', () => {
  beforeEach(() => vi.resetModules());

  it('attach sets .animator synchronously and is idempotent (same object returned)', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble();
    const a1 = attachMachineAnimator(m);
    expect(m.animator).toBe(a1); // synchronous contract: set before return
    expect(a1.mode).toBe('procedural'); // no assetId/window -> procedural now
    const a2 = attachMachineAnimator(m);
    expect(a2).toBe(a1); // second attach never builds a duplicate animator
  });

  it('repeated spawn/kill/respawn cycles keep exactly ONE live animator per record', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble();
    // Simulates the ai.js wiring: fresh record attaches; on roster removal the
    // record's animator is disposed + the slot cleared before any re-use.
    let prev = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      const a = attachMachineAnimator(m);
      expect(m.animator).toBe(a);
      expect(a._disposed).toBe(false);
      if (prev) expect(a).not.toBe(prev); // a new cycle means a new animator...
      prev = a;
      a.dispose(); // kill/roster-removal step
      expect(a._disposed).toBe(true); // ...and the old one stays finalized
    }
  });

  it('a disposed animator is never resurrected: re-attach hands out a fresh one', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble();
    const dead = attachMachineAnimator(m);
    dead.dispose();
    // Caller forgot to clear m.animator: attach must still yield clean state.
    const fresh = attachMachineAnimator(m);
    expect(fresh).not.toBe(dead);
    expect(fresh._disposed).toBe(false);
    expect(m.animator).toBe(fresh);
  });
});

describe('procedural attack contract', () => {
  beforeEach(() => vi.resetModules());

  it("playAttack('lunge') on a skitter returns numeric windows plus an events array", async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble({ type: 'skitter' });
    attachMachineAnimator(m);
    const meta = m.animator.playAttack('lunge');
    expect(typeof meta.anticipation).toBe('number');
    expect(typeof meta.active).toBe('number');
    expect(typeof meta.recovery).toBe('number');
    expect(Array.isArray(meta.events)).toBe(true);
    expect(meta.events.length).toBeGreaterThan(0);
    // ATTACK_WINDOWS['skitter:lunge'] - combat timing depends on these exact
    // values (crouch squat 0.5s -> arcing leap 0.55s -> recover 0.4s).
    expect(meta.anticipation).toBeCloseTo(0.5, 10);
    expect(meta.active).toBeCloseTo(0.55, 10);
    expect(meta.recovery).toBeCloseTo(0.4, 10);
    // The event beat sits mid-active-window and carries the shared shape.
    expect(meta.events[0].t).toBeCloseTo(0.5 + 0.55 * 0.5, 10);
    expect(meta.events[0].name).toBe('hit');
  });

  it('unknown attack names fall back to the DEFAULT_WINDOW shape', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble({ type: 'skitter' });
    attachMachineAnimator(m);
    const meta = m.animator.playAttack('notARealMove');
    expect(typeof meta.anticipation).toBe('number');
    expect(typeof meta.active).toBe('number');
    expect(typeof meta.recovery).toBe('number');
    expect(Array.isArray(meta.events)).toBe(true);
  });

  it('attackProgress() is -1 when nothing has played', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble({ type: 'rendclaw' });
    attachMachineAnimator(m);
    expect(m.animator.attackProgress()).toBe(-1);
  });
});

describe('updateMachineAnimators robustness', () => {
  beforeEach(() => vi.resetModules());

  it('no-throw on an empty G.machines roster', async () => {
    const { G, updateMachineAnimators } = await loadFresh();
    G.machines = [];
    expect(() => updateMachineAnimators(0.016)).not.toThrow();
  });

  it('no-throw when G.machines does not exist yet (pre-boot order)', async () => {
    const { G, updateMachineAnimators } = await loadFresh();
    const real = G.machines;
    G.machines = undefined; // boot-order defensive guard must absorb this
    try {
      expect(() => updateMachineAnimators(0.016)).not.toThrow();
    } finally {
      G.machines = real;
    }
  });

  it('skips machines lacking animators without disturbing attached ones', async () => {
    const { G, attachMachineAnimator, updateMachineAnimators } = await loadFresh();
    const bare = { type: 'ghost' }; // no .animator at all
    const good = makeMachineDouble();
    attachMachineAnimator(good);
    G.machines = [bare, good];
    expect(() => updateMachineAnimators(0.016)).not.toThrow();
    expect(good.animator.mode).toBe('procedural'); // untouched pass
  });

  it('a throwing authored graph is isolated: its machine logs, neighbours still tick', async () => {
    const { G, updateMachineAnimators } = await loadFresh();
    let badTicks = 0;
    let goodTicks = 0;
    G.machines = [
      {
        type: 'bad',
        _disposed: false,
        animator: {
          mode: 'authored',
          graph: { update() { badTicks++; throw new Error('mixer exploded'); } },
          root: null,
          _machine: null,
          _locoSpeed: null,
          _eventCtl: null,
          _disposed: false,
        },
      },
      {
        type: 'good',
        _disposed: false,
        animator: {
          mode: 'authored',
          graph: { update() { goodTicks++; } },
          root: null,
          _machine: null,
          _locoSpeed: null,
          _eventCtl: null,
          _disposed: false,
        },
      },
    ];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => updateMachineAnimators(0.016)).not.toThrow();
    } finally {
      errSpy.mockRestore();
    }
    expect(badTicks).toBe(1); // attempted exactly once, then contained
    expect(goodTicks).toBe(1); // per-machine isolation held
  });

  it('records flagged _disposed (roster removal) are skipped entirely', async () => {
    const { G, updateMachineAnimators } = await loadFresh();
    let ticks = 0;
    G.machines = [
      {
        type: 'corpse',
        _disposed: true, // disposeMachine already ran
        animator: {
          mode: 'authored',
          graph: { update() { ticks++; } },
          root: null,
          _machine: null,
          _locoSpeed: null,
          _eventCtl: null,
          _disposed: false,
        },
      },
    ];
    expect(() => updateMachineAnimators(0.016)).not.toThrow();
    expect(ticks).toBe(0);
  });
});

describe('dispose bookkeeping', () => {
  beforeEach(() => vi.resetModules());

  it('dispose releases the authored graph/root and clears every internal ref', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const m = makeMachineDouble();
    const a = attachMachineAnimator(m);
    let graphDisposals = 0;
    const root = new THREE.Group();
    m.group.add(root); // authored roots live under machine.group
    a.mode = 'authored';
    a.graph = { dispose() { graphDisposals++; } };
    a.root = root;
    a._lastAction = {};
    a._eventCtl = {};

    a.dispose();

    expect(graphDisposals).toBe(1); // mixer released exactly once
    expect(root.parent).toBeNull(); // removeFromParent ran
    expect(a.graph).toBeNull();
    expect(a.root).toBeNull();
    expect(a.mode).toBe('procedural'); // back to inert baseline mode
    expect(a._eventCtl).toBeNull();
    expect(a._lastAction).toBeNull();
    expect(a._disposed).toBe(true); // finalized marker for tickers
  });

  it('a disposed animator can never be ticked again by updateMachineAnimators', async () => {
    const { G, attachMachineAnimator, updateMachineAnimators } = await loadFresh();
    const m = makeMachineDouble();
    const a = attachMachineAnimator(m);
    let ticks = 0;
    a.mode = 'authored';
    a.graph = {
      update() { ticks++; },
      dispose() {}, // required so dispose() itself does not throw here
    };
    G.machines = [m];

    updateMachineAnimators(0.016);
    expect(ticks).toBe(1); // alive and ticking

    a.dispose(); // roster removal / death-without-respawn finalization
    updateMachineAnimators(0.016);
    updateMachineAnimators(0.016);
    expect(ticks).toBe(1); // frozen: disposed animators are inert by contract
  });

  it('disposing twice stays safe (idempotent teardown)', async () => {
    const { attachMachineAnimator } = await loadFresh();
    const a = attachMachineAnimator(makeMachineDouble());
    let disposals = 0;
    a.graph = { dispose() { disposals++; } };
    a.dispose();
    a.dispose(); // defensive double-dispose must not throw or re-release
    expect(disposals).toBe(1);
    expect(a._disposed).toBe(true);
  });
});
