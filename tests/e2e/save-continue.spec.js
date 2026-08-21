// Quicksave / Continue: KeyP writes the 'ironwild-save' slot, a reload shows
// the CONTINUE button, and continuing restores the saved position.
import { expect, test } from '@playwright/test';
import { playerPos, startGame, tapKey } from './helpers.js';

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test('KeyP quicksave -> reload -> Continue restores position', async ({ page }) => {
  await startGame(page);

  // Walk away from spawn (0, ?, 8) so the save clearly differs from boot state.
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(1200);
  await page.keyboard.up('KeyW');

  await tapKey(page, 'KeyP'); // manual quicksave (src/systems/save.js updateSave)

  await expect.poll(() =>
    page.evaluate(() => !!localStorage.getItem('ironwild-save')),
  ).toBe(true);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('ironwild-save')));
  expect(Array.isArray(saved.pos)).toBe(true);
  expect(saved.v).toBeGreaterThanOrEqual(2);

  // Fresh navigation: title screen must now offer CONTINUE (menus renders it
  // only when systems/save.js hasSave() is true at buildDom time).
  const posBeforeReload = await playerPos(page);
  await page.goto('/');
  await page.waitForFunction(() => !!(window.__IW && window.__IW.G && window.__IW.G.player));
  const continueBtn = page.locator('#iw-continue');
  await expect(continueBtn).toBeVisible();

  await continueBtn.click();
  await expect.poll(() => page.evaluate(() => window.__IW.G.started)).toBe(true);

  // loadGame() applies the saved position synchronously inside the click
  // handler; sample immediately so live AI cannot drift the comparison.
  const restored = await playerPos(page);
  expect(dist(restored, { x: saved.pos[0], y: saved.pos[1], z: saved.pos[2] }))
    .toBeLessThan(0.5);
  expect(dist(restored, posBeforeReload)).toBeGreaterThan(3); // really left spawn
});
