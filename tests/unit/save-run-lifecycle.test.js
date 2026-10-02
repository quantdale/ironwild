// Run-lifecycle (permadeath) coverage for src/systems/save.js - the behavior
// INTRODUCED by the `enforce-permadeath-run-model` OpenSpec change. These pin
// the NEW contract: a death ends the run's save (run.ended marker), while
// live-run saves stay exactly as before. Contrast tests/unit/save.test.js,
// which pins pre-existing loadGame() boundary behavior. The two suites may
// want merging once `harden-core-verification` lands; kept standalone here
// because that change is not on this worktree.
//
// Pattern follows tests/unit/save.test.js: node env (tests/setup.dom.js
// supplies localStorage), vi.resetModules() per test, and ../core/input.js
// mocked (only used by the save tick's quicksave poll; absent otherwise).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

vi.mock('../../src/core/input.js', () => ({
  Input: {
    wasActionPressed: vi.fn(() => false),
    pressed: vi.fn(() => false),
    isAction: vi.fn(() => false),
  },
}));

const SAVE_KEY = 'ironwild-save';

// Fresh module instance + a live-run G with a player at a known position.
async function freshSave() {
  vi.resetModules();
  const [stateMod, saveMod, eventsMod] = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/systems/save.js'),
    import('../../src/core/events.js'),
  ]);
  const { G } = stateMod;
  G.started = true;
  G.gameOver = false;
  G.elapsed = 42;
  G.player = {
    pos: new THREE.Vector3(4, 2, -6),
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
  };
  return { G, save: saveMod, bus: eventsMod.bus };
}

function baseSave(overrides = {}) {
  return {
    v: 4,
    pos: [0, 0, 0],
    hp: 75,
    stamina: 90,
    inventory: {},
    skills: {},
    quests: { completed: 0, genCount: 0, slots: [] },
    xp: { level: 1, cur: 0, next: 100 },
    bestiary: {},
    ...overrides,
  };
}

function readSlot() {
  return JSON.parse(localStorage.getItem(SAVE_KEY));
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('run lifecycle - live run (NEW behavior)', () => {
  // Task 4.2: mid-run save round-trips and is restorable.
  it('mid-run save restores via loadGame() and is restorable', async () => {
    const { G, save } = await freshSave();
    save.initSave();
    expect(save.saveGame(true)).toBe(true);
    expect(save.hasSave()).toBe(true);
    expect(save.hasRestorableRun()).toBe(true);

    const slot = readSlot();
    expect(slot.run).toBeUndefined(); // live runs carry no marker
    expect(slot.pos).toEqual([4, 2, -6]);

    // Mutate G, then restore: loadGame() accepts and applies the snapshot.
    G.player.pos.set(99, 2, 99);
    expect(save.loadGame()).toBe(true);
    expect(G.player.pos.toArray()).toEqual([4, 2, -6]);
  });
});

describe('run lifecycle - ended run (NEW behavior)', () => {
  // Task 4.3: ended runs are refused at the data layer; slot presence is kept.
  it('rejects run.ended === true in loadGame() without mutating G', async () => {
    const { G, save } = await freshSave();
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify(baseSave({ run: { ended: true, endedAt: 123 } })),
    );
    const before = G.player.pos.clone();

    expect(save.loadGame()).toBe(false);
    expect(G.player.pos.equals(before)).toBe(true);
    expect(G.inventory.shards).toBe(0); // no partial restore either
    expect(save.hasSave()).toBe(true); // slot presence unchanged
    expect(save.hasRestorableRun()).toBe(false);
  });

  // Task 4.4: backward compatibility - pre-marker saves load and are restorable.
  it('loads a save without a run field (backward compatibility)', async () => {
    const { G, save } = await freshSave();
    localStorage.setItem(SAVE_KEY, JSON.stringify(baseSave({ hp: 55 })));

    expect(save.hasRestorableRun()).toBe(true);
    expect(save.loadGame()).toBe(true);
    expect(G.player.hp).toBe(55);
  });

  // Task 4.5: a corrupt run field must never brick a live run - strict === true
  // is the only "ended" reading.
  it.each([
    ['a string', 'ended'],
    ['a number', 1],
    ['an empty object', {}],
    ['null', null],
    ['an array', []],
    ['a truthy non-boolean ended flag', { ended: 1 }],
    ['a truthy string ended flag', { ended: 'true' }],
  ])('treats run as %s as not ended', async (_label, runValue) => {
    const { G, save } = await freshSave();
    localStorage.setItem(SAVE_KEY, JSON.stringify(baseSave({ hp: 60, run: runValue })));

    expect(save.hasRestorableRun()).toBe(true);
    expect(save.loadGame()).toBe(true);
    expect(G.player.hp).toBe(60);
  });

  // Task 4.6: the death mark writes exactly one ended slot; repeat emissions
  // neither duplicate the write nor throw.
  it("bus 'playerDied' marks the run ended exactly once", async () => {
    const { save, bus } = await freshSave();
    save.initSave();
    expect(save.saveGame(false)).toBe(true);

    bus.emit('playerDied', {});
    const marked = readSlot();
    expect(marked.run).toEqual({ ended: true, endedAt: 42 }); // G.elapsed
    expect(marked.pos).toEqual([4, 2, -6]); // final-state snapshot, not cleared

    const rawAfterFirst = localStorage.getItem(SAVE_KEY);
    bus.emit('playerDied', {});
    bus.emit('playerDied', {});
    expect(localStorage.getItem(SAVE_KEY)).toBe(rawAfterFirst); // exactly once

    expect(save.hasSave()).toBe(true);
    expect(save.hasRestorableRun()).toBe(false);
    expect(save.loadGame()).toBe(false);
  });

  // Task 4.7: with storage throwing, the death flow completes without throwing
  // and the clear-save fallback leaves no restorable slot.
  it('death flow is failure-safe: throwing storage falls back to clearSave()', async () => {
    const { save, bus } = await freshSave();
    save.initSave();
    localStorage.setItem(SAVE_KEY, JSON.stringify(baseSave())); // pre-death snapshot

    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('storage write refused');
    };
    expect(() => bus.emit('playerDied', {})).not.toThrow();
    localStorage.setItem = original;

    expect(localStorage.getItem(SAVE_KEY)).toBeNull(); // cleared, not restorable
    expect(save.hasSave()).toBe(false);
    expect(save.hasRestorableRun()).toBe(false);
  });

  it('death with a slot that stays unparsable falls back to clearSave()', async () => {
    const { save, bus } = await freshSave();
    save.initSave();
    localStorage.setItem(SAVE_KEY, JSON.stringify(baseSave())); // pre-death snapshot

    // A storage shim that accepts writes but stores garbage: the mark lands
    // unparseable, so the post-write verification must clear rather than trust
    // it (a stale pre-death snapshot must never stay restorable).
    const original = localStorage.setItem.bind(localStorage);
    localStorage.setItem = (k) => original(k, '{not-json');
    expect(() => bus.emit('playerDied', {})).not.toThrow();
    localStorage.setItem = original;

    expect(localStorage.getItem(SAVE_KEY)).toBeNull(); // cleared, not restorable
    expect(save.hasSave()).toBe(false);
    expect(save.hasRestorableRun()).toBe(false);
  });

  // Task 4.8: once the run is ended, every save trigger stays a no-op - the
  // ended run can never be overwritten with (or restored as) a live snapshot.
  it('autosave / quicksave / pause / panel-open are no-ops after the run ended', async () => {
    const { G, save, bus } = await freshSave();
    save.initSave();
    expect(save.saveGame(false)).toBe(true);
    bus.emit('playerDied', {});
    const marked = localStorage.getItem(SAVE_KEY);
    G.gameOver = true; // menus.onPlayerDied mirrors this after the mark

    bus.emit('ui', { action: 'open' }); // panel-open trigger
    bus.emit('ui', { action: 'open-panel' });
    save.updateSave(0.016);
    G.paused = true;
    save.updateSave(0.016); // pause rising edge
    G.paused = false;
    G.gameOver = false; // even the bare !gameOver guards must not reopen writing
    save.updateSave(1000); // autosave interval + quicksave poll

    expect(localStorage.getItem(SAVE_KEY)).toBe(marked); // untouched ended mark
    expect(readSlot().run).toEqual({ ended: true, endedAt: 42 });
    expect(save.hasRestorableRun()).toBe(false);
  });
});
