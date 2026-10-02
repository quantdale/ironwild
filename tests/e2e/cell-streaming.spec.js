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
  await expect
    .poll(async () => (await cellStats(page)).active, { timeout: SWGL_POLL_MS })
    .toBeLessThan((await cellStats(page)).registered);

  await page.evaluate(() => {
    const p = window.__IW.G.player.pos;
    p.x = 600;
    p.z = 0;
  });
  await expect
    .poll(async () => (await cellStats(page)).active, { timeout: SWGL_POLL_MS })
    .toBeLessThan((await cellStats(page)).registered);
  const atFar = await cellStats(page);
  expect(atFar.active).toBeLessThan(atFar.registered);
});
