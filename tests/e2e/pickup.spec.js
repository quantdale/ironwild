// Pickup collection: teleport the player onto a known world pickup, press the
// interact key (E - src/world/props.js updateProps), and assert the inventory
// count incremented EXACTLY once and the pickup record was removed.
import { expect, test } from '@playwright/test';
import { startGame, tapKey } from './helpers.js';

test('interact collects a wood pickup exactly once', async ({ page }) => {
  await startGame(page);

  // Choose a deterministic seeded pickup and teleport onto it. Scavenger is
  // forced off so the grant is exactly +1 (skill doubles it).
  const setup = await page.evaluate(() => {
    const G = window.__IW.G;
    G.skills.scavenger = 0;
    const rec = G.pickups.find((p) => p.type === 'wood' && !p.taken);
    if (!rec) return null;
    window.__iwPickupRef = rec;
    G.player.pos.set(rec.pos.x, rec.pos.y + 0.05, rec.pos.z);
    G.player.vel.set(0, 0, 0);
    return { woodBefore: G.inventory.wood, x: rec.pos.x, z: rec.pos.z };
  });
  expect(setup, 'seeded world must contain wood pickups').not.toBeNull();

  // Let one frame run so the proximity prompt path sees us in range.
  await page.waitForTimeout(250);
  const inRange = await page.evaluate(() => {
    const p = window.__IW.G.player.pos;
    const rec = window.__iwPickupRef;
    return Math.hypot(p.x - rec.pos.x, p.z - rec.pos.z);
  });
  expect(inRange).toBeLessThan(2.4); // PROMPT_DIST in src/world/props.js

  await tapKey(page, 'KeyE', 150);

  // Collection is splice-on-collect: record leaves G.pickups, count +1.
  await expect.poll(() =>
    page.evaluate(() => ({
      wood: window.__IW.G.inventory.wood,
      gone: !window.__IW.G.pickups.includes(window.__iwPickupRef),
    })),
  ).toEqual({ wood: setup.woodBefore + 1, gone: true });

  // Exactly once: a beat later nothing further may be granted.
  await page.waitForTimeout(400);
  const settled = await page.evaluate(() => ({
    wood: window.__IW.G.inventory.wood,
    pickups: window.__IW.G.pickups.length,
  }));
  expect(settled.wood).toBe(setup.woodBefore + 1);
});
