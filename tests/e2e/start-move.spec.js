// Start + movement: clicking the title screen starts the run, the HUD fades
// in, WASD moves the player (forward + both strafes) and mouse look drives
// camera yaw in BOTH control modes (pointer lock engaged, or the game's
// free-cursor fallback after lock denial). Never asserts pointerLockElement.
import { expect, test } from "@playwright/test";
import {
 playerPos,
 startGame,
 SWGL_POLL_MS,
 SWGL_SPEC_MS,
 waitControlSettled,
} from "./helpers.js";

/**
 * Hold a movement key until the player has actually moved `delta` units
 * horizontally from `from`, then release. State-driven: at 60fps this is one
 * or two frames; under software GL the poll simply waits longer instead of a
 * fixed wall-clock hold guessing how far N milliseconds should move you.
 */
async function holdUntilMoved(page, code, from, delta, timeout = SWGL_POLL_MS) {
 await page.keyboard.down(code);
 try {
  await expect
   .poll(
    async () => {
     const p = await playerPos(page);
     return Math.hypot(p.x - from.x, p.z - from.z);
    },
    { timeout },
   )
   .toBeGreaterThan(delta);
 } finally {
  await page.keyboard.up(code);
 }
}

function dist2(a, b) {
 const dx = a.x - b.x;
 const dz = a.z - b.z;
 return Math.sqrt(dx * dx + dz * dz);
}

test("start screen click begins the run and shows the HUD", async ({
 page,
}) => {
 test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits in seconds
 await startGame(page);
 await expect(page.locator("#iw-start")).toHaveClass(/hidden/);
 // HUD root gets .show once started (opacity transition; class is the truth).
 await expect(page.locator("#iw-hud")).toHaveClass(/show/, { timeout: 5000 });
});

test("WASD moves: W forward, A/D strafe", async ({ page }) => {
 test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling: three displacement polls + boot
 await startGame(page);
 await waitControlSettled(page);

 // Pointer-lock acquisition can leave a synthetic mouse delta queued on slow
 // Chromium hosts. Establish the invariant this test documents before taking
 // the position snapshot: yaw 0, no pending look input.
 await page.evaluate(() => {
  window.__IW.G.cam.yaw = 0;
  window.__IW.G.cam.pitch = 0;
  window.__IW.G.player.yaw = 0;
  window.__IW.Input.consumeMouse();
 });

 // Fresh boot: yaw is 0 (facing -Z), so A/D map to -X/+X world strafe.
 // Each leg waits on the ACTUAL displacement (see holdUntilMoved) and the
 // assertions then verify DIRECTION, which is the invariant under test.
 const before = await playerPos(page);

 await holdUntilMoved(page, "KeyA", before, 0.8);
 const afterA = await playerPos(page);
 expect(afterA.x, "A strafes left (-X at yaw 0)").toBeLessThan(before.x - 0.4);

 await holdUntilMoved(page, "KeyD", afterA, 0.8); // cross back past the start point
 const afterD = await playerPos(page);
 expect(afterD.x, "D strafes right (+X at yaw 0)").toBeGreaterThan(
  afterA.x + 0.4,
 );

 await holdUntilMoved(page, "KeyW", afterD, 1.4);
 const afterW = await playerPos(page);
 expect(dist2(afterD, afterW), "W moves the player forward").toBeGreaterThan(
  1.0,
 );
});

test("mouse movement steers the camera yaw (locked or fallback)", async ({
 page,
}) => {
 test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits in seconds
 await startGame(page);
 await waitControlSettled(page);

 // This spec tests LOOK, not survivability: on a starved host the settle wait
 // can outlast several machine attack cycles and an idle player dies, which
 // pauses the sim and makes the yaw assertion meaningless. Clear threats the
 // same way the game's own damage path does (machine.hit -> killMachine), so
 // nothing can kill the standing player while we sweep.
 await page.evaluate(() => {
  const G = window.__IW.G;
  for (const m of G.machines) {
   let guard = 0;
   while (m.alive && guard++ < 99) m.hit(1e9, m.group.position.clone(), null);
  }
 });

 const yawBefore = await page.evaluate(() => window.__IW.G.cam.yaw);

 // Center first, then sweep. Under pointer lock these arrive as movementX/Y;
 // in lockBroken fallback the same events feed the free-cursor path. Dispatch
 // the movement events through the real DOM listener so SwiftShader's
 // absolute-coordinate mouse synthesis cannot emit cancelling pairs.
 await page.evaluate(() => {
  for (const [movementX, movementY] of [[180, 0], [-60, 20]]) {
   window.dispatchEvent(new MouseEvent("mousemove", { movementX, movementY }));
  }
 });

 await expect
  .poll(
   () => page.evaluate((y0) => Math.abs(window.__IW.G.cam.yaw - y0), yawBefore),
   { timeout: SWGL_POLL_MS }, // mouse deltas land on the next sim frame
  )
  .toBeGreaterThan(0.05);

 // Gameplay must still be live (look never pauses the game).
 expect(await page.evaluate(() => window.__IW.G.paused)).toBe(false);
});
