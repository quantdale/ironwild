// Frontier expedition smoke: exercise the real scheduler, prompt claim, and
// interaction path without waiting for a long natural cooldown.
import { expect, test } from '@playwright/test';
import { gotoGame, tapKey, SWGL_POLL_MS, SWGL_SPEC_MS } from './helpers.js';

test('frontier expedition appears and completes through interact', async ({ page }) => {
  test.setTimeout(SWGL_SPEC_MS);
  await gotoGame(page);
  await page.locator('#iw-start').click();
  await expect.poll(() => page.evaluate(() => window.__IW.G.started), {
    timeout: SWGL_POLL_MS,
  }).toBe(true);

  const seeded = await page.evaluate(() => {
    const G = window.__IW.G;
    // Remove combat noise so a software-rendered smoke run cannot die while
    // validating the optional objective layer.
    for (const machine of G.machines) {
      let guard = 0;
      while (machine.alive && guard++ < 99) machine.hit(1e9, machine.group.position.clone(), null);
    }
    // Machine deaths can leave queued bolts/attack callbacks behind. Freeze
    // only the public damage boundary for this interaction smoke; production
    // gameplay and the save test keep the normal damage path untouched.
    G.player.takeDamage = () => {};
    G.player.dead = false;
    G.gameOver = false;
    const p = G.player.pos;
    G.expedition = {
      active: {
        id: 9001,
        type: 'salvage',
        x: p.x,
        z: p.z,
        label: 'Smoke Cache',
        radius: 3.2,
        maxTime: 30,
        timeLeft: 30,
        progress: 0,
      },
      completed: 0,
      nextId: 9002,
      cooldown: 0,
    };
    return { shards: G.inventory.shards, xp: G.xp.cur };
  });

  await expect(page.locator('#iw-expedition')).toHaveClass(/show/, { timeout: SWGL_SPEC_MS });
  await expect(page.locator('#iw-expedition .iw-exp-title')).toContainText('SALVAGE CACHE');
  await tapKey(page, 'KeyE');
  await expect.poll(() => page.evaluate(() => window.__IW.G.expedition.completed), {
    timeout: SWGL_POLL_MS,
  }).toBe(1);

  const result = await page.evaluate(() => ({
    active: window.__IW.G.expedition.active,
    shards: window.__IW.G.inventory.shards,
    xp: window.__IW.G.xp.cur,
  }));
  expect(result.active).toBeNull();
  expect(result.shards).toBeGreaterThan(seeded.shards);
  expect(result.xp).toBeGreaterThan(seeded.xp);
});
