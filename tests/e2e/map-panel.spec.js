// Frontier map lifecycle: M opens the shared-terrain map, pauses gameplay,
// renders a usable canvas, and closes back to active play without console noise.
import { expect, test } from "@playwright/test";
import {
  startGame,
  SWGL_POLL_MS,
  SWGL_SPEC_MS,
  tapKey,
  watchConsole,
} from "./helpers.js";

test.setTimeout(SWGL_SPEC_MS);

test("M opens and closes the frontier map without pausing bugs", async ({ page }) => {
  const consoleLog = watchConsole(page);
  await startGame(page);

  await tapKey(page, "KeyM");
  const screen = page.locator(".iw-map-panel").locator("..");
  await expect(screen).not.toHaveClass(/hidden/, { timeout: SWGL_POLL_MS });
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.paused), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);

  const opened = await page.evaluate(() => ({
    width: document.querySelector("#iw-world-map").width,
    height: document.querySelector("#iw-world-map").height,
    minWidth: getComputedStyle(document.querySelector(".iw-map-panel")).minWidth,
  }));
  expect(opened.width).toBeGreaterThan(0);
  expect(opened.height).toBeGreaterThan(0);
  expect(opened.minWidth).not.toBe("0px");

  await tapKey(page, "KeyM");
  await expect(screen).toHaveClass(/hidden/, { timeout: SWGL_POLL_MS });
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.paused), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(false);

  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, "uncaught page errors during map lifecycle").toEqual([]);
  expect(consoleOffenses, "console errors/warnings during map lifecycle").toEqual([]);
});
