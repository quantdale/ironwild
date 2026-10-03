// World streaming (fix-cell-streaming-initial-hide): at spawn, the cell
// manager must report strictly fewer visible batches than registered ones,
// and walking/teleporting to another region must re-converge the counters.
import { expect, test } from '@playwright/test';
import { startGame, SWGL_POLL_MS, watchConsole } from './helpers.js';

function cellStats(page) {
  return page.evaluate(() => window.__IW_PERF_CELLS());
}

test('spawn meadow reports active batches below the registered total', async ({ page }) => {
  test.setTimeout(900_000);
  const watched = watchConsole(page);
  await startGame(page);

  await expect
    .poll(() => cellStats(page), { timeout: SWGL_POLL_MS })
    .toMatchObject({ registered: expect.any(Number) });

  const stats = await cellStats(page);
  expect(stats.registered).toBeGreaterThan(0);
  expect(stats.active).toBeLessThan(stats.registered);

  const visibleMeshes = await page.evaluate(() => {
    let visible = 0;
    let total = 0;
    window.__IW.scene.traverse((o) => {
      if (o.isInstancedMesh) {
        total++;
        if (o.visible) visible++;
      }
    });
    return { visible, total };
  });
  expect(visibleMeshes.total).toBeGreaterThan(0);
  expect(visibleMeshes.visible).toBeLessThan(visibleMeshes.total);

  const off = watched.offenses();
  expect(off.console).toEqual([]);
  expect(off.pageErrors).toEqual([]);
});

test('moving to another region re-converges the cell counters', async ({ page }) => {
  test.setTimeout(900_000);
  await startGame(page);

  async function visibleBatchIds() {
    return page.evaluate(() => {
      const ids = [];
      window.__IW.scene.traverse((o) => {
        if (o.isInstancedMesh && o.visible) ids.push(o.uuid);
      });
      return ids.sort();
    });
  }

  // Establish a stable out-of-band world at spawn before teleporting.
  await expect
    .poll(async () => (await cellStats(page)).active, { timeout: SWGL_POLL_MS })
    .toBeLessThan((await cellStats(page)).registered);
  const before = await visibleBatchIds();
  expect(before.length).toBeGreaterThan(0);

  // Reachable destination: ~240u from spawn (0,8), still inside the soft
  // world border (playRadius + 25 = 295), far enough that the active band
  // (120u) no longer overlaps the spawn band.
  await page.evaluate(() => {
    const p = window.__IW.G.player.pos;
    p.x = 240;
    p.z = 0;
  });

  // Require a real transition: the visible batch set must actually change,
  // not merely satisfy active < registered again at the same spot.
  await expect
    .poll(async () => (await visibleBatchIds()).join(','), { timeout: SWGL_POLL_MS })
    .not.toBe(before.join(','));

  const after = await visibleBatchIds();
  expect(after.length).toBeGreaterThan(0);
  const atFar = await cellStats(page);
  expect(atFar.active).toBeLessThan(atFar.registered);
  // Counters must stay coherent after the transition.
  expect(atFar.active).toBeGreaterThan(0);
  expect(atFar.active).toBeLessThan(atFar.registered);
});
