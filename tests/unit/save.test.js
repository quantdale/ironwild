// Save-boundary regression tests: malformed localStorage data must not poison
// runtime state, while valid legacy-shaped saves remain loadable.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

async function freshSave() {
  vi.resetModules();
  const [stateMod, saveMod] = await Promise.all([
    import('../../src/core/state.js'),
    import('../../src/systems/save.js'),
  ]);
  const { G } = stateMod;
  G.started = true;
  G.gameOver = false;
  G.player = {
    pos: new THREE.Vector3(4, 2, -6),
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
  };
  return { G, loadGame: saveMod.loadGame };
}

function baseSave(overrides = {}) {
  return {
    v: 4,
    pos: [0, 0, 0],
    hp: 100,
    stamina: 100,
    inventory: {},
    skills: {},
    quests: { completed: 0, genCount: 0, slots: [] },
    xp: { level: 1, cur: 0, next: 100 },
    bestiary: {},
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('loadGame hostile input boundary', () => {
  it('rejects out-of-world coordinates before mutating the player', async () => {
    const { G, loadGame } = await freshSave();
    const before = G.player.pos.clone();
    localStorage.setItem('ironwild-save', JSON.stringify(baseSave({
      pos: [9999, 0, 0],
    })));

    expect(loadGame()).toBe(false);
    expect(G.player.pos.equals(before)).toBe(true);
  });

  it('normalizes malformed expedition state instead of persisting unsafe values', async () => {
    const { G, loadGame } = await freshSave();
    localStorage.setItem('ironwild-save', JSON.stringify(baseSave({
      expedition: {
        completed: 1e9,
        nextId: -4,
        cooldown: -20,
        active: {
          id: 0,
          type: 'not-a-contract',
          x: 0,
          z: 0,
        },
      },
    })));

    expect(loadGame()).toBe(true);
    expect(G.expedition).toEqual({
      active: null,
      completed: 9999,
      nextId: 1,
      cooldown: 0,
    });
  });

  it('clamps bounded values and drops unknown bestiary records', async () => {
    const { G, loadGame } = await freshSave();
    localStorage.setItem('ironwild-save', JSON.stringify(baseSave({
      hp: 1e9,
      stamina: -50,
      inventory: {
        shards: 1e9,
        medicine: 1e9,
        arrows: -8,
        fireArrows: 1e9,
        armor: 99,
        unknownResource: 1e9,
      },
      quests: { completed: 1e9, genCount: -20, slots: [] },
      xp: { level: 1e9, cur: 1e9, next: 1 },
      bestiary: {
        skitter: { seen: true, killed: true },
        injected: { seen: true, killed: true },
      },
    })));

    expect(loadGame()).toBe(true);
    expect(G.player.hp).toBe(1000);
    expect(G.player.stamina).toBe(0);
    expect(G.inventory.shards).toBe(9999);
    expect(G.inventory.medicine).toBe(99);
    expect(G.inventory.arrows).toBe(0);
    expect(G.inventory.fireArrows).toBe(20);
    expect(G.inventory.armor).toBe(2);
    expect(G.inventory.unknownResource).toBeUndefined();
    expect(G.quests.completed).toBe(9999);
    expect(G.quests.genCount).toBe(0);
    expect(G.xp.level).toBe(100);
    expect(G.xp.cur).toBe(G.xp.next - 1);
    expect(G.bestiary.skitter).toEqual({ seen: true, killed: true });
    expect(G.bestiary.injected).toBeUndefined();
  });
});
