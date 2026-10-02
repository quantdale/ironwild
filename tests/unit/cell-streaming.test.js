// Cell streaming regression tests: a freshly-registered out-of-band cell must
// be hidden on the first updateCells pass, counters must agree with visibility,
// and pre-adoption parity holds until the first decision.
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshCells() {
  vi.resetModules();
  return import('../../src/world/cells.js');
}

function stubGroup() {
  return { visible: true, castShadow: true, parent: null };
}

function registerAt(cells, x, z, kind = 'tree') {
  return cells.register(cells.cellKeyAt(x, z), { group: stubGroup(), kind });
}

beforeEach(() => {
  vi.resetModules();
});

describe('updateCells first-pass behavior', () => {
  it('hides a far batch on the first pass while showing a near one', async () => {
    const cells = await freshCells();
    const near = registerAt(cells, 30, 30);
    const far = registerAt(cells, 600, 0);

    cells.updateCells({ x: 0, z: 0 }, 0.016);

    expect(near.group.visible).toBe(true);
    expect(far.group.visible).toBe(false);
  });

  it('leaves registered content visible before any updateCells call', async () => {
    const cells = await freshCells();
    const rec = registerAt(cells, 600, 0);

    expect(rec.group.visible).toBe(true);
    expect(cells.getCellStats().active).toBe(1);
  });

  it('keeps a never-active cell hidden when the anchor moves away, and hides a cell that leaves the band', async () => {
    const cells = await freshCells();
    const far = registerAt(cells, 600, 0);
    const near = registerAt(cells, 30, 30);

    cells.updateCells({ x: 0, z: 0 }, 0.016);
    expect(far.group.visible).toBe(false);

    cells.updateCells({ x: -600, z: 0 }, 0.016);
    expect(far.group.visible).toBe(false);
    expect(near.group.visible).toBe(false);
  });

  it('keeps active equal to the number of shown live records across moving-anchor passes', async () => {
    const cells = await freshCells();
    const recs = [
      registerAt(cells, 30, 30),
      registerAt(cells, 600, 0),
      registerAt(cells, -600, 300),
      registerAt(cells, 90, 90),
    ];

    for (const [x, z] of [[0, 0], [200, 0], [-400, 200], [60, 60], [0, 0]]) {
      cells.updateCells({ x, z }, 0.016);
      const shown = recs.filter((r) => r.group.visible).length;
      expect(cells.getCellStats().active).toBe(shown);
    }
  });

  it('uses the entry radius on first pass and hysteresis afterwards', async () => {
    const cells = await freshCells();
    // Cell '2,0' spans x 120..180, z 0..60.
    const edge = registerAt(cells, 150, 30);

    // Anchor (-30, 30): rect dx = 150, d2 = 22500 -> inside the gap
    // (14400 < d2 <= 24336). A never-evaluated cell is hidden here.
    cells.updateCells({ x: -30, z: 30 }, 0.016);
    expect(edge.group.visible).toBe(false);

    // Oscillating inside the band must not toggle a hidden cell visible.
    cells.updateCells({ x: -20, z: 30 }, 0.016);
    expect(edge.group.visible).toBe(false);

    // Now evaluate a fresh cell that IS in band, then slide it into the gap:
    // it must stay shown (exit hysteresis) until past the exit radius.
    vi.resetModules();
    const cells2 = await freshCells();
    const edge2 = registerAt(cells2, 150, 30);
    cells2.updateCells({ x: 0, z: 30 }, 0.016); // d2 = 14400 -> entry shows
    expect(edge2.group.visible).toBe(true);
    cells2.updateCells({ x: -30, z: 30 }, 0.016); // gap -> stays shown
    expect(edge2.group.visible).toBe(true);
    cells2.updateCells({ x: -60, z: 30 }, 0.016); // dx=180, d2=32400 > exit -> hidden
    expect(edge2.group.visible).toBe(false);
  });

  it('ignores a non-finite or missing anchor and leaves content visible', async () => {
    const cells = await freshCells();
    const rec = registerAt(cells, 600, 0);

    expect(() => cells.updateCells({ x: Number.NaN, z: 0 }, 0.016)).not.toThrow();
    cells.updateCells(null, 0.016);
    cells.updateCells(undefined, 0.016);
    expect(rec.group.visible).toBe(true);
  });

  it('decrements registered and active when a cell is retired', async () => {
    const cells = await freshCells();
    const a = registerAt(cells, 30, 30);
    registerAt(cells, 35, 35);
    registerAt(cells, 600, 0);

    cells.updateCells({ x: 0, z: 0 }, 0.016);
    const before = cells.getCellStats();
    expect(before.registered).toBe(3);
    expect(before.active).toBe(2);

    cells.retire(cells.cellKeyAt(30, 30));
    const after = cells.getCellStats();
    expect(after.registered).toBe(1);
    expect(after.active).toBe(0);
    expect(a.group.visible).toBe(false);
  });
});
