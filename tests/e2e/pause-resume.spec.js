// Pause/resume round-trips. Guards the pointer-lock grace fix: after RESUME
// the pause screen must NOT flash back while the relock settles, and repeated
// Esc -> resume cycles must stay stable. Works in both control modes (Esc
// exits pointer lock via the browser when locked; the game's own Esc handler
// covers the lockBroken fallback).
import { expect, test } from "@playwright/test";
import {
  startGame,
  SWGL_POLL_MS,
  SWGL_SPEC_MS,
  tapKey,
  waitControlSettled,
} from "./helpers.js";

test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits in seconds

test("two Esc-pause / resume cycles without flash-back", async ({ page }) => {
  await startGame(page);
  await waitControlSettled(page);

  for (let round = 1; round <= 2; round++) {
    // --- pause ---
    await tapKey(page, "Escape");
    await expect
      .poll(() => page.evaluate(() => window.__IW.G.paused), {
        timeout: SWGL_POLL_MS, // Esc edge lands on the next sim frame
      })
      .toBe(true);
    const resumeBtn = page.locator("#iw-resume");
    await expect(resumeBtn).toBeVisible({ timeout: SWGL_POLL_MS });

    // No flicker: it must STAY paused (no pause/unpause thrash).
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.__IW.G.paused)).toBe(true);
    await expect(resumeBtn).toBeVisible();

    // --- resume ---
    if (round === 1) {
      await resumeBtn.click();
    } else {
      // Second cycle exercises the Esc-again path (menus handles Escape
      // while the pause panel is open and the pointer is unlocked).
      await tapKey(page, "Escape");
    }
    await expect
      .poll(() => page.evaluate(() => window.__IW.G.paused), {
        timeout: SWGL_POLL_MS,
      })
      .toBe(false);
    await expect(page.locator("#iw-resume")).toBeHidden({
      timeout: SWGL_POLL_MS,
    });

    // Grace-window guard: 900ms after resume the game must still be live -
    // a regression in the relock grace shows up as an automatic pause flash.
    await page.waitForTimeout(900);
    expect(
      await page.evaluate(() => window.__IW.G.paused),
      `round ${round}: paused flashed back after resume`,
    ).toBe(false);
  }
});
