// Input rebinding (Wave J): the action layer must actually drive gameplay.
// Rebind 'jump' to KeyM: KeyM jumps, the old default Space does not (until
// reset), and a pre-seeded localStorage binding survives a reload.
//
// Headless SwiftShader note: the sim runs near 1fps with clamped dt, so a
// jump arc (~0.75s game time) can take tens of seconds of wall clock - every
// airborne->grounded wait gets a generous budget.
import { expect, test } from "@playwright/test";
import { startGame, SWGL_POLL_MS, SWGL_SPEC_MS, tapKey } from "./helpers.js";

test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling (was 240s: pre-evidence guess)

/** Poll until the player is grounded again (landing) with a long budget. */
async function waitLanded(page) {
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.player.grounded), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);
  await page.waitForTimeout(200); // let the pressed-edge clear
}

/** True if the player leaves the ground within the sampling window. */
async function jumpedAfterTap(page, code) {
  await tapKey(page, code);
  return page.evaluate(async () => {
    const G = window.__IW.G;
    const y0 = G.player.pos.y;
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
      if (!G.player.grounded && G.player.pos.y > y0 + 0.15) return true;
      if (G.elapsed === undefined) break;
    }
    return false;
  });
}

test("rebound key performs the action; default key stops doing it", async ({
  page,
}) => {
  await startGame(page);
  await page.evaluate(() => window.__IW.Input.setBinding("jump", "KeyM"));

  expect(await jumpedAfterTap(page, "KeyM")).toBe(true);
  await waitLanded(page);

  // The old default must no longer drive the action.
  await tapKey(page, "Space");
  const rose = await page.evaluate(() => window.__IW.G.player.pos.y);
  await page.waitForTimeout(500);
  const yNow = await page.evaluate(() => window.__IW.G.player.pos.y);
  expect(yNow).toBeLessThanOrEqual(rose + 0.05); // no upward motion from Space

  // Reset restores the default binding live.
  await page.evaluate(() => window.__IW.Input.resetBindings());
  expect(await jumpedAfterTap(page, "Space")).toBe(true);
});

test("bindings persist across reload", async ({ page }) => {
  // Seed through init script so the very first boot already merges the
  // persisted override - no double navigation needed.
  await page.addInitScript(() => {
    localStorage.setItem("ironwild-bindings", JSON.stringify({ jump: "KeyM" }));
  });
  await startGame(page);

  expect(await jumpedAfterTap(page, "KeyM")).toBe(true);
});
