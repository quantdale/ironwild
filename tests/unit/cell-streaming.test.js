// IRONWILD - unit tests for src/world/cells.js (world-streaming capability).
// The streaming manager is pure bookkeeping (Map + counters + group.visible),
// so it runs headless here with plain stub groups - no WebGL, no THREE.
// Pattern (matches status-burn.test.js): vi.resetModules() + dynamic import
// per test so the module-level singleton (cellsMap + counters) is fresh each
// time.
//
// These cases pin the FIXED behavior of the fix-cell-streaming-initial-hide
// change: a cell outside the band is hidden from the FIRST streamed pass,
// even if the player never walked into it (the old code could only hide a
// cell it had first seen become active, so every never-visited cell stayed
// visible forever and the whole world was submitted at spawn).
//
// Counter comments below describe what the getter reports at each step, not
// an independently observable truth; where the source-of-truth is ambiguous
// the assertion counts shown live records directly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

async function loadCells() {
  vi.resetModules();
  return import('../../src/world/cells.js');
}

const CELL_SIZE = 60;
// Band geometry mirrored from src/world/cells.js tuning (read before writing):
// activate within 2 cells, hide past 2.6 (hysteresis), rect distance to the
// cell's XZ rectangle. Cell 'cx,cz' covers [cx*60, cx*60+60) x [cz*60, cz*60+60).

/** Minimal group stub: the manager only ever writes .visible (and .castShadow). */
function makeGroup() {
  return { visible: true, castShadow: false, parent: null };
}

const pos = (x, z) => ({ x, z });

/** Center of cell (cx, cz) - safely inside the cell's rect. */
const center = (cx, cz) => pos(cx * CELL_SIZE + CELL_SIZE / 2, cz * CELL_SIZE + CELL_SIZE / 2);

/** Count live records whose shown flag is true (the counter invariant). */
function countShown(recs) {
  return recs.filter((r) => !r.retired && r.shown).length;
}

/** Count live records. */
function countLive(recs) {
  return recs.filter((r) => !r.retired).length;
}

beforeEach(() => vi.resetModules());

describe('initial hide: out-of-band cells hide on the first streamed pass', () => {
  it('hides a freshly-registered far cell on the first updateCells() pass, keeps near visible', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const nearGroup = makeGroup();
    const farGroup = makeGroup();
    register('0,0', { group: nearGroup, kind: 'treeTrunk' });
    register('5,5', { group: farGroup, kind: 'treeTrunk' });

    // Pre-adoption parity: both visible until the first pass runs.
    expect(nearGroup.visible).toBe(true);
    expect(farGroup.visible).toBe(true);

    updateCells(center(0, 0), 1 / 60);

    // The far cell was never active - it must still hide on this first pass.
    expect(nearGroup.visible).toBe(true);
    expect(farGroup.visible).toBe(false);
    expect(getCellStats()).toEqual({ registered: 2, active: 1, retired: 0 });
  });

  it('keeps a registered batch visible before any updateCells() call (pre-adoption parity)', async () => {
    const { register, getCellStats } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'groundcover' });
    expect(group.visible).toBe(true);
    expect(getCellStats().active).toBe(1);
  });

  it('hides on the first pass regardless of which cell the anchor sits in', async () => {
    // The defect (per the audit): cells.js only ever hid cells it first saw
    // become active, so at spawn all 279 content batches stayed visible.
    // Here the anchor is far from every registered cell at the first pass -
    // nothing was ever active - and everything must hide immediately.
    const { register, updateCells, getCellStats } = await loadCells();
    const groups = [makeGroup(), makeGroup(), makeGroup()];
    register('0,0', { group: groups[0], kind: 'a' });
    register('3,3', { group: groups[1], kind: 'b' });
    register('-2,4', { group: groups[2], kind: 'c' });

    updateCells(pos(10000, -10000), 1 / 60);

    expect(groups.map((g) => g.visible)).toEqual([false, false, false]);
    expect(getCellStats()).toEqual({ registered: 3, active: 0, retired: 0 });
  });
});

describe('band crossings toggle both directions', () => {
  it('shows a hidden cell when the anchor enters the band, hides it again when it leaves', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'treeCone1' });

    updateCells(center(0, 0), 1 / 60); // in band
    expect(group.visible).toBe(true);

    updateCells(pos(10000, 10000), 1 / 60); // far out
    expect(group.visible).toBe(false);

    updateCells(center(0, 0), 1 / 60); // back in
    expect(group.visible).toBe(true);
    expect(getCellStats()).toEqual({ registered: 1, active: 1, retired: 0 });
  });

  it('a never-active far cell stays hidden while the anchor moves around far away', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'groundcover' });

    updateCells(center(3, 3), 1 / 60); // hides it, never active
    expect(group.visible).toBe(false);
    updateCells(center(5, 5), 1 / 60); // even further
    expect(group.visible).toBe(false);
    updateCells(pos(0, 400), 1 / 60); // ~400z away, still past DEACT
    expect(group.visible).toBe(false);
  });

  it('a cell that was visible becomes hidden once the anchor leaves the band', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'treeTrunk' });

    updateCells(center(0, 0), 1 / 60);
    expect(group.visible).toBe(true);
    updateCells(pos(200, 200), 1 / 60); // rect distance > DEACT
    expect(group.visible).toBe(false);
  });
});

describe('counter and visible-state agreement', () => {
  it('active equals the number of shown live records after passes with a moving anchor', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const recs = [];
    for (let cx = -1; cx <= 1; cx++) {
      for (let cz = -1; cz <= 1; cz++) {
        recs.push(register(`${cx},${cz}`, { group: makeGroup(), kind: 'batch' }));
      }
    }

    const path = [center(0, 0), pos(200, 0), pos(200, 200), pos(-200, 200), center(0, 0), pos(500, -500)];
    for (const p of path) {
      updateCells(p, 1 / 60);
      const stats = getCellStats();
      expect(stats.registered).toBe(countLive(recs));
      expect(stats.active).toBe(countShown(recs));
      // Invariant: every live record's shown flag agrees with its group's
      // visible flag (no callback records here, so they are the same thing).
      for (const r of recs) {
        if (!r.retired) expect(r.group.visible).toBe(r.shown);
      }
    }
  });

  it('setRecordShown cannot drive active above registered or below zero across cycles', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const rec = register('0,0', { group: makeGroup(), kind: 'batch' });
    for (let i = 0; i < 5; i++) {
      updateCells(center(0, 0), 1 / 60);
      updateCells(pos(1000, 1000), 1 / 60);
    }
    const stats = getCellStats();
    expect(stats).toEqual({ registered: 1, active: 0, retired: 0 });
    expect(rec.shown).toBe(false);
    expect(stats.active).toBeGreaterThanOrEqual(0);
    expect(stats.active).toBeLessThanOrEqual(stats.registered);
    expect(countShown([rec])).toBe(0);
  });

  it('callbacks drive visibility and counters symmetrically across toggles', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    let shown = 0;
    const rec = register('0,0', {
      kind: 'callback',
      onActivate: () => { shown++; },
      onDeactivate: () => { shown--; },
    });

    updateCells(center(0, 0), 1 / 60);
    expect(shown).toBe(1);
    expect(rec.shown).toBe(true);
    updateCells(pos(1000, 1000), 1 / 60);
    expect(shown).toBe(0);
    expect(rec.shown).toBe(false);
    updateCells(center(0, 0), 1 / 60);
    expect(shown).toBe(1);
    expect(getCellStats().active).toBe(1);
  });

  it('retiring all records of a cell removes the cell and decrements registered/active', async () => {
    const { register, updateCells, retire, getCellStats } = await loadCells();
    const group = makeGroup();
    const rec = register('0,0', { group, kind: 'decal' });
    const onRetire = vi.fn();
    rec.onRetire = onRetire;

    updateCells(center(0, 0), 1 / 60); // in band: shown
    expect(getCellStats()).toEqual({ registered: 1, active: 1, retired: 0 });

    expect(retire('0,0')).toBe(true);
    expect(onRetire).toHaveBeenCalledTimes(1);
    expect(getCellStats()).toEqual({ registered: 0, active: 0, retired: 1 });
    expect(group.visible).toBe(false);

    // Empty cell is gone: a fresh register at the same key works normally.
    const group2 = makeGroup();
    register('0,0', { group: group2, kind: 'decal' });
    expect(getCellStats()).toEqual({ registered: 1, active: 1, retired: 1 });
  });

  it('retiring a record that was hidden decrements registered only', async () => {
    const { register, updateCells, retire, getCellStats } = await loadCells();
    register('0,0', { group: makeGroup(), kind: 'decal' });
    updateCells(pos(1000, 1000), 1 / 60); // hidden
    retire('0,0');
    expect(getCellStats()).toEqual({ registered: 0, active: 0, retired: 1 });
  });
});

describe('hysteresis: no boundary thrash (tasks 3.6)', () => {
  it('an anchor just past the entry radius keeps the cell visible; only past the exit radius hides it', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    // Cell '1,0' = x [60,120), z [0,60).
    register('1,0', { group, kind: 'treeTrunk' });

    // Inside the entry band: active.
    updateCells(pos(60, 30), 1 / 60);
    expect(group.visible).toBe(true);

    // Between ACTIVE_DIST and DEACT_DIST from the rect: still active (this is
    // the hysteresis gap - an inactive cell would NOT activate here).
    // Cell '1,0' = x [60,120): rect distance from x=270 is 150, inside the
    // gap [120, 156) = (ACTIVE, DEACT).
    updateCells(pos(270, 30), 1 / 60);
    expect(group.visible).toBe(true);

    // Oscillating inside the gap must not toggle: inactive would stay hidden,
    // active must stay shown on every pass.
    for (let i = 0; i < 3; i++) {
      updateCells(pos(260, 30), 1 / 60); // dx = 140, in the gap
      expect(group.visible).toBe(true);
    }

    // Past the exit radius: hidden.
    updateCells(pos(300, 30), 1 / 60); // dx = 180 > 156
    expect(group.visible).toBe(false);

    // Oscillating inside the gap while hidden must not show it (only an
    // anchor within ACTIVE_DIST re-activates).
    for (let i = 0; i < 3; i++) {
      updateCells(pos(270, 30), 1 / 60); // dx = 150, in the gap
      expect(group.visible).toBe(false);
    }

    // Back inside the entry band: shown again.
    updateCells(pos(60, 30), 1 / 60);
    expect(group.visible).toBe(true);
  });

  it('the wider exit threshold governs an active cell (rect distance semantics preserved)', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'batch' });
    updateCells(pos(30, 30), 1 / 60); // inside the cell: active
    expect(group.visible).toBe(true);

    // Rect distance is 0 anywhere inside the cell's XZ rectangle - a point
    // far from the cell CENTRE but inside the rect never deactivates.
    updateCells(pos(59, 59), 1 / 60);
    expect(group.visible).toBe(true);
  });
});

describe('robustness guards', () => {
  it('a missing or non-finite anchor is ignored and content stays visible (no throw)', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const group = makeGroup();
    register('0,0', { group, kind: 'batch' });

    expect(() => updateCells(undefined, 1 / 60)).not.toThrow();
    expect(() => updateCells(null, 1 / 60)).not.toThrow();
    expect(() => updateCells(pos(NaN, 0), 1 / 60)).not.toThrow();
    expect(() => updateCells(pos(0, Infinity), 1 / 60)).not.toThrow();
    expect(group.visible).toBe(true);
    expect(getCellStats().active).toBe(1);

    // ... and the first valid pass is still authoritative.
    updateCells(pos(1000, 1000), 1 / 60);
    expect(group.visible).toBe(false);
  });

  it('updateCells before createCells() is a no-op guard (lazy-init contract)', async () => {
    const { updateCells, register, getCellStats } = await loadCells();
    const group = makeGroup();
    // register() lazy-inits the manager, so this path is the register-before-
    // createCells order the module documents as supported.
    register('0,0', { group, kind: 'batch' });
    expect(() => updateCells(center(0, 0), 1 / 60)).not.toThrow();
    expect(getCellStats().registered).toBe(1);
  });

  it('registering the same cell key twice accumulates records; each toggles independently of kind', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    const g1 = makeGroup();
    const g2 = makeGroup();
    register('0,0', { group: g1, kind: 'treeTrunk' });
    register('0,0', { group: g2, kind: 'treeCone1' });

    updateCells(pos(1000, 1000), 1 / 60);
    expect(g1.visible).toBe(false);
    expect(g2.visible).toBe(false);
    expect(getCellStats()).toEqual({ registered: 2, active: 0, retired: 0 });
  });

  it('a record registered into an already-hidden cell joins hidden (counter agreement at register)', async () => {
    const { register, updateCells, getCellStats } = await loadCells();
    register('0,0', { group: makeGroup(), kind: 'treeTrunk' });
    updateCells(pos(1000, 1000), 1 / 60); // cell judged out of band: hidden

    const lateGroup = makeGroup();
    register('0,0', { group: lateGroup, kind: 'groundcover' });
    // The record joins shown first (pre-adoption parity) then follows its
    // already-judged cell in the same call - never a frame of false visibility.
    expect(lateGroup.visible).toBe(false);
    expect(getCellStats()).toEqual({ registered: 2, active: 0, retired: 0 });
  });

  it('steady state with a static anchor performs no writes (no per-frame churn)', async () => {
    const { register, updateCells } = await loadCells();
    let activations = 0;
    let deactivations = 0;
    register('0,0', {
      kind: 'callback',
      onActivate: () => { activations++; },
      onDeactivate: () => { deactivations++; },
    });

    for (let i = 0; i < 50; i++) updateCells(center(0, 0), 1 / 60);
    // One transition into the band at most; the remaining 49 passes must be
    // pure comparisons - no callback fires, no group write happens. This is
    // the observable face of "no per-frame full-tree work": the pass never
    // touches the scene graph, and the idempotent helper absorbs the rest.
    expect(activations).toBeLessThanOrEqual(1);
    expect(deactivations).toBe(0);

    for (let i = 0; i < 50; i++) updateCells(pos(1000, 1000), 1 / 60);
    expect(deactivations).toBe(1);
    expect(activations).toBe(1);
  });
});

describe('shadow-caster budget is independent of the visibility fix (tasks 1.5)', () => {
  it('toggles castShadow only on transitions, with 1.18x exit hysteresis', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    const writes = [];
    const rec = register('0,0', { group, kind: 'treeTrunk', shadowRadius: 100 });
    // Spy on the state write the manager performs.
    let shadowState = false;
    Object.defineProperty(group, 'castShadow', {
      get: () => shadowState,
      set: (v) => { shadowState = v; writes.push(v); },
      configurable: true,
    });

    updateCells(pos(30, 30), 1 / 60); // d=0 <= 100: cast
    expect(shadowState).toBe(true);
    expect(writes).toEqual([true]);

    updateCells(pos(30, 30), 1 / 60); // no change, no write
    expect(writes).toEqual([true]);

    // Cell '0,0' = x [0,60): anchor x = 60+d gives rect distance d.
    // d = 110 is outside 100 but inside 1.18x = 118: keeps whatever it had.
    updateCells(pos(60 + 110, 30), 1 / 60);
    expect(writes).toEqual([true]);

    // d = 130 is past 118: stops casting.
    updateCells(pos(60 + 130, 30), 1 / 60);
    expect(writes).toEqual([true, false]);

    // Back inside 100: casts again - the visibility fix must not have coupled
    // this block to cell.active/streamed.
    updateCells(pos(30, 30), 1 / 60);
    expect(writes).toEqual([true, false, true]);
    expect(rec.shadowRadius).toBe(100);
    expect(rec.shadowing).toBe(true);
  });

  it('runs the shadow budget even for hidden cells (invisible draws skip both passes)', async () => {
    const { register, updateCells } = await loadCells();
    const group = makeGroup();
    register('3,3', { group, kind: 'treeTrunk', shadowRadius: 50 });
    updateCells(center(0, 0), 1 / 60); // far: hidden
    expect(group.visible).toBe(false);
    expect(group.castShadow).toBe(false); // far from the shadow ring too
    updateCells(center(3, 3), 1 / 60); // near: shown + casting
    expect(group.visible).toBe(true);
    expect(group.castShadow).toBe(true);
  });
});

describe('grouping contract with lod.groupInstancesByCell (read-only pin)', () => {
  it('cellKeyAt and groupInstancesByCell agree on the same positions at CELL_SIZE', async () => {
    // The fix must not break instance grouping: props.js groups matrices with
    // lod.groupInstancesByCell and registers under the returned key, so the
    // two key spaces must match 1:1. This imports lod.js (untouched by this
    // change) purely to pin the pairing.
    const { cellKeyAt, CELL_SIZE: size } = await loadCells();
    const { groupInstancesByCell } = await import('../../src/world/lod.js');
    expect(size).toBe(CELL_SIZE);

    const matrixAt = (x, z) => ({ elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1] });
    const xs = [0, 1, -1, 59.999, 60, -0.001, -60, -60.5, 1234.5, -1234.5];
    const mats = xs.map((x) => matrixAt(x, x));
    const groups = groupInstancesByCell(mats, CELL_SIZE);
    for (const [key, arr] of groups) {
      for (const m of arr) {
        expect(cellKeyAt(m.elements[12], m.elements[14])).toBe(key);
      }
    }
    expect(groups.size).toBeGreaterThan(0);
  });
});
