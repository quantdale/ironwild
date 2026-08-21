// Start + movement: clicking the title screen starts the run, the HUD fades
// in, WASD moves the player (forward + both strafes) and mouse look drives
// camera yaw in BOTH control modes (pointer lock engaged, or the game's
// free-cursor fallback after lock denial). Never asserts pointerLockElement.
import { expect, test } from '@playwright/test';
import {
  playerPos,
  startGame,
  tapKey,
  waitControlSettled,
} from './helpers.js';

function dist2(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

test('start screen click begins the run and shows the HUD', async ({ page }) => {
  await startGame(page);
  await expect(page.locator('#iw-start')).toHaveClass(/hidden/);
  // HUD root gets .show once started (opacity transition; class is the truth).
  await expect(page.locator('#iw-hud')).toHaveClass(/show/, { timeout: 5000 });
});

test('WASD moves: W forward, A/D strafe', async ({ page }) => {
  await startGame(page);
  await waitControlSettled(page);

  // Fresh boot: yaw is 0 (facing -Z), so A/D map to -X/+X world strafe.
  const before = await playerPos(page);

  await page.keyboard.down('KeyA');
  await page.waitForTimeout(450);
  await page.keyboard.up('KeyA');
  const afterA = await playerPos(page);
  expect(afterA.x, 'A strafes left (-X at yaw 0)').toBeLessThan(before.x - 0.4);

  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700); // cross back past the start point
  await page.keyboard.up('KeyD');
  const afterD = await playerPos(page);
  expect(afterD.x, 'D strafes right (+X at yaw 0)').toBeGreaterThan(
    afterA.x + 0.4,
  );

  const beforeW = await playerPos(page);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  const afterW = await playerPos(page);
  expect(dist2(beforeW, afterW), 'W moves the player forward').toBeGreaterThan(1.0);
});

test('mouse movement steers the camera yaw (locked or fallback)', async ({ page }) => {
  await startGame(page);
  await waitControlSettled(page);

  const yawBefore = await page.evaluate(() => window.__IW.G.cam.yaw);

  // Center first, then sweep. Under pointer lock these arrive as movementX/Y;
  // in lockBroken fallback the same events feed the free-cursor path.
  await page.mouse.move(640, 360);
  await page.mouse.move(940, 360, { steps: 8 });
  await page.mouse.move(340, 420, { steps: 8 });

  await expect.poll(() =>
    page.evaluate((y0) => Math.abs(window.__IW.G.cam.yaw - y0), yawBefore),
  ).toBeGreaterThan(0.05);

  // Gameplay must still be live (look never pauses the game).
  expect(await page.evaluate(() => window.__IW.G.paused)).toBe(false);
});
