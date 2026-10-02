// IRONWILD - bestiary discovery/completion contract
// (openspec/changes/fix-bestiary-discovery). Pins: engaging a machine (a
// resolved 'machineHit') reveals its species exactly once, a confirmed kill
// completes the entry and reveals lore, and discovery never pays the scan
// rewards (map reveal, skill points, scan XP). The final block pins the
// unchanged { seen, killed } save shape round-trip.
//
// The bus and the bestiary are module singletons whose handlers are never
// unsubscribed (createBestiary runs once per page lifetime), so each test
// boots a fresh module graph with vi.resetModules() + dynamic import. The
// sub() registry mirrors tests/unit/events.test.js so recording listeners
// never leak between tests either.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const registry = [];
function sub(bus, type, fn) {
  registry.push([bus, type, fn]);
  return bus.on(type, fn);
}
afterEach(() => {
  while (registry.length) {
    const [bus, type, fn] = registry.pop();
    bus.off(type, fn);
  }
});
beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

/** Fresh bus + fresh G + a freshly subscribed bestiary module. */
async function freshBestiary() {
  vi.resetModules();
  const [eventsMod, stateMod, bestiaryMod] = await Promise.all([
    import('../../src/core/events.js'),
    import('../../src/core/state.js'),
    import('../../src/systems/bestiary.js'),
  ]);
  bestiaryMod.createBestiary();
  return { bus: eventsMod.bus, G: stateMod.G, ...bestiaryMod };
}

/** Record every transition and toast in one ordered list each. */
function recordTransitions(bus) {
  const transitions = [];
  const notifies = [];
  sub(bus, 'bestiaryUnlock', (p) => transitions.push(p));
  sub(bus, 'notify', (p) => notifies.push(p));
  return { transitions, notifies };
}

// ---------------------------------------------------------------------------
// combat discovery: machineHit -> seen
// ---------------------------------------------------------------------------
describe('combat discovery (machineHit -> seen)', () => {
  it('a resolved hit reveals the species without completing it', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions, notifies } = recordTransitions(bus);

    bus.emit('machineHit', { machine: { type: 'skitter' }, damage: 22, weak: false, partName: null });

    expect(G.bestiary.skitter).toEqual({ seen: true, killed: false });
    expect(transitions).toEqual([{ type: 'skitter', kind: 'seen' }]);
    expect(notifies).toHaveLength(1);
    expect(notifies[0].text).toContain('Skitter');
  });

  it('repeated hits on the same species reveal and announce exactly once', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions, notifies } = recordTransitions(bus);

    bus.emit('machineHit', { machine: { type: 'skitter' } });
    bus.emit('machineHit', { machine: { type: 'skitter' } });
    bus.emit('machineHit', { machine: { type: 'skitter' } });

    expect(G.bestiary.skitter).toEqual({ seen: true, killed: false });
    expect(transitions).toEqual([{ type: 'skitter', kind: 'seen' }]);
    expect(notifies).toHaveLength(1);
  });

  it('combat reveal works for every species, including non-scannable ones', async () => {
    const { bus, G, SPECIES } = await freshBestiary();
    const { transitions } = recordTransitions(bus);

    for (const type of SPECIES) bus.emit('machineHit', { machine: { type } });

    for (const type of SPECIES) {
      expect(G.bestiary[type], `${type} revealed by combat`).toEqual({ seen: true, killed: false });
    }
    expect(transitions).toHaveLength(SPECIES.length);
    expect(new Set(transitions.map((t) => t.kind))).toEqual(new Set(['seen']));
  });

  it('a species the player never engaged stays undiscovered', async () => {
    const { bus, G, speciesLore } = await freshBestiary();
    bus.emit('machineHit', { machine: { type: 'skitter' } });

    expect(G.bestiary.bramblehorn).toEqual({ seen: false, killed: false });
    expect(speciesLore('bramblehorn')).toBe('');
  });

  it('discovery grants no scan rewards: map reveal, skill points and XP are untouched', async () => {
    const { bus, G } = await freshBestiary();
    const before = {
      map: G.mapRevealed,
      sp: G.inventory.skillPoints,
      xp: G.xp.cur,
    };

    bus.emit('machineHit', { machine: { type: 'skitter' } });

    expect(G.mapRevealed).toBe(before.map);
    expect(G.inventory.skillPoints).toBe(before.sp);
    expect(G.xp.cur).toBe(before.xp);
  });

  it('a machineHit with no machine field is ignored without throwing', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions } = recordTransitions(bus);

    expect(() => bus.emit('machineHit')).not.toThrow();
    expect(() => bus.emit('machineHit', {})).not.toThrow();
    expect(() => bus.emit('machineHit', { machine: null })).not.toThrow();

    expect(G.bestiary.skitter).toEqual({ seen: false, killed: false });
    expect(transitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// kill completion: machineDied -> killed (stronger than seen)
// ---------------------------------------------------------------------------
describe('kill completion (machineDied -> killed)', () => {
  it('a kill completes the entry, implies the reveal, and repeats announce once', async () => {
    const { bus, G, speciesLore } = await freshBestiary();
    const { transitions, notifies } = recordTransitions(bus);

    bus.emit('machineDied', { machine: { type: 'rendclaw' } });
    bus.emit('machineDied', { machine: { type: 'rendclaw' } });

    expect(G.bestiary.rendclaw).toEqual({ seen: true, killed: true });
    expect(transitions).toEqual([{ type: 'rendclaw', kind: 'killed' }]);
    expect(notifies).toHaveLength(1);
    expect(speciesLore('rendclaw')).not.toBe('');
  });

  it('reveal-then-kill transitions in order: exactly one seen, then one killed', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions } = recordTransitions(bus);

    bus.emit('machineHit', { machine: { type: 'ironmaw' } });
    bus.emit('machineHit', { machine: { type: 'ironmaw' } });
    bus.emit('machineDied', { machine: { type: 'ironmaw' } });
    bus.emit('machineDied', { machine: { type: 'ironmaw' } });

    expect(G.bestiary.ironmaw).toEqual({ seen: true, killed: true });
    expect(transitions).toEqual([
      { type: 'ironmaw', kind: 'seen' },
      { type: 'ironmaw', kind: 'killed' },
    ]);
  });

  it('lore stays hidden while the entry is only revealed', async () => {
    const { bus, speciesLore } = await freshBestiary();

    bus.emit('machineHit', { machine: { type: 'duskwing' } });
    expect(speciesLore('duskwing')).toBe('');

    bus.emit('machineDied', { machine: { type: 'duskwing' } });
    expect(speciesLore('duskwing')).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Vantage scan path preserved (the reward-bearing event stays as it was)
// ---------------------------------------------------------------------------
describe('Vantage scan path (machineScanned)', () => {
  it('a scan reveals without killing', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions } = recordTransitions(bus);

    bus.emit('machineScanned', { machine: { type: 'vantage' } });

    expect(G.bestiary.vantage).toEqual({ seen: true, killed: false });
    expect(transitions).toEqual([{ type: 'vantage', kind: 'seen' }]);
  });

  it('scan XP flows from machineScanned only, never from machineHit', async () => {
    const { bus, G } = await freshBestiary();
    const xpMod = await import('../../src/systems/xp.js');
    xpMod.createXp();
    const gains = [];
    sub(bus, 'xpGain', (p) => gains.push(p));

    bus.emit('machineHit', { machine: { type: 'skitter' } });
    expect(gains).toHaveLength(0);

    bus.emit('machineScanned', { machine: { type: 'vantage' } });
    expect(gains).toEqual([{ amount: 15, reason: 'scan' }]);
    expect(G.xp.cur).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// malformed payloads and unknown types
// ---------------------------------------------------------------------------
describe('malformed payloads and unknown types', () => {
  it('unknown machine types are ignored: no entry created, no throw', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions, notifies } = recordTransitions(bus);

    expect(() => bus.emit('machineHit', { machine: { type: 'not-a-species' } })).not.toThrow();
    expect(() => bus.emit('machineDied', { machine: { type: 'not-a-species' } })).not.toThrow();

    expect(G.bestiary['not-a-species']).toBeUndefined();
    expect(transitions).toHaveLength(0);
    expect(notifies).toHaveLength(0);
  });

  it('a machine without a type is ignored without throwing', async () => {
    const { bus, G } = await freshBestiary();
    const { transitions } = recordTransitions(bus);

    expect(() => bus.emit('machineHit', { machine: {} })).not.toThrow();
    expect(() => bus.emit('machineDied', { machine: {} })).not.toThrow();

    expect(G.bestiary).toEqual({
      skitter: { seen: false, killed: false },
      bramblehorn: { seen: false, killed: false },
      rendclaw: { seen: false, killed: false },
      ironmaw: { seen: false, killed: false },
      duskwing: { seen: false, killed: false },
      bulwark: { seen: false, killed: false },
      vantage: { seen: false, killed: false },
      mirefang: { seen: false, killed: false },
      monarch: { seen: false, killed: false },
    });
    expect(transitions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// lookup helpers (menus.js consumers)
// ---------------------------------------------------------------------------
describe('speciesName / speciesLore', () => {
  it('speciesName maps known keys and falls back to the raw key', async () => {
    const { speciesName } = await freshBestiary();
    expect(speciesName('skitter')).toBe('Skitter');
    expect(speciesName('monarch')).toBe('the Monarch');
    expect(speciesName('not-a-species')).toBe('not-a-species');
  });

  it('speciesLore returns a line only for completed entries, else the empty string', async () => {
    const { bus, speciesLore } = await freshBestiary();
    expect(speciesLore('bulwark')).toBe('');

    bus.emit('machineHit', { machine: { type: 'bulwark' } });
    expect(speciesLore('bulwark')).toBe('');

    bus.emit('machineDied', { machine: { type: 'bulwark' } });
    expect(typeof speciesLore('bulwark')).toBe('string');
    expect(speciesLore('bulwark').length).toBeGreaterThan(0);
    expect(speciesLore('not-a-species')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// createBestiary seeding / idempotence
// ---------------------------------------------------------------------------
describe('createBestiary', () => {
  it('seeds every SPECIES entry undiscovered and is idempotent on re-entry', async () => {
    const { bus, G, SPECIES, createBestiary } = await freshBestiary();
    for (const type of SPECIES) {
      expect(G.bestiary[type], `${type} seeded`).toEqual({ seen: false, killed: false });
    }

    // A discovery survives the re-entry (ensureEntry never clobbers).
    bus.emit('machineHit', { machine: { type: 'skitter' } });
    expect(() => createBestiary()).not.toThrow();
    expect(G.bestiary.skitter).toEqual({ seen: true, killed: false });

    // Re-entry must not double-subscribe: one hit -> one transition.
    const { transitions } = recordTransitions(bus);
    bus.emit('machineHit', { machine: { type: 'bramblehorn' } });
    expect(transitions).toEqual([{ type: 'bramblehorn', kind: 'seen' }]);
  });
});

// ---------------------------------------------------------------------------
// save round-trip: the persisted shape is exactly { seen, killed }
// ---------------------------------------------------------------------------
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

/** Boot order mirror: state -> bestiary seeding -> save, with a live player. */
async function freshSaveRig() {
  vi.resetModules();
  const [eventsMod, stateMod, saveMod, bestiaryMod] = await Promise.all([
    import('../../src/core/events.js'),
    import('../../src/core/state.js'),
    import('../../src/systems/save.js'),
    import('../../src/systems/bestiary.js'),
  ]);
  const { G } = stateMod;
  G.started = true;
  G.gameOver = false;
  G.player = {
    pos: new THREE.Vector3(0, 1, 0),
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
  };
  bestiaryMod.createBestiary();
  return {
    G,
    bus: eventsMod.bus,
    saveGame: saveMod.saveGame,
    loadGame: saveMod.loadGame,
    ...bestiaryMod,
  };
}

describe('save round-trip ({ seen, killed } shape unchanged)', () => {
  it('a revealed-only entry serializes and restores as { seen: true, killed: false }', async () => {
    const a = await freshSaveRig();
    a.bus.emit('machineHit', { machine: { type: 'skitter' } });
    expect(a.saveGame()).toBe(true);

    const raw = JSON.parse(localStorage.getItem('ironwild-save'));
    expect(raw.bestiary.skitter).toEqual({ seen: true, killed: false });

    const b = await freshSaveRig();
    expect(b.loadGame()).toBe(true);
    expect(b.G.bestiary.skitter).toEqual({ seen: true, killed: false });
    // Lore stays kill-gated across a save/continue (a reveal alone never pays it).
    expect(b.speciesLore('skitter')).toBe('');
  });

  it('malformed bestiary records restore to safe booleans or are dropped', async () => {
    const rig = await freshSaveRig();
    localStorage.setItem('ironwild-save', JSON.stringify(baseSave({
      bestiary: {
        skitter: { seen: 1, killed: 'x' },   // junk values coerce to real booleans
        bramblehorn: { seen: null, killed: 0 },
        rendclaw: 'junk',                    // non-object record: dropped
        ironmaw: null,
        injected: { seen: true, killed: true }, // unknown type: dropped
      },
    })));

    expect(rig.loadGame()).toBe(true);
    expect(rig.G.bestiary.skitter).toEqual({ seen: true, killed: true });
    expect(rig.G.bestiary.bramblehorn).toEqual({ seen: false, killed: false });
    expect(rig.G.bestiary.rendclaw).toEqual({ seen: false, killed: false });
    expect(rig.G.bestiary.ironmaw).toEqual({ seen: false, killed: false });
    expect(rig.G.bestiary.injected).toBeUndefined();
  });

  it('a save without a bestiary field loads and the module defaults stand in', async () => {
    const rig = await freshSaveRig();
    const saved = baseSave();
    delete saved.bestiary;
    localStorage.setItem('ironwild-save', JSON.stringify(saved));

    expect(rig.loadGame()).toBe(true);
    for (const type of rig.SPECIES) {
      expect(rig.G.bestiary[type], `${type} keeps its undiscovered default`)
        .toEqual({ seen: false, killed: false });
    }
  });
});
