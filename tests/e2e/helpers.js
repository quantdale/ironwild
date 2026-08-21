// Shared E2E helpers for the IRONWILD smoke suite.
//
// Conventions used across every spec:
// - Console discipline: attach watchConsole(page) BEFORE page.goto('/') so
//   module-evaluation errors are captured too.
// - One-shot keys: the game polls Input.pressed() once per animation frame
//   (src/core/input.js endFrame clears the set), so a synthetic down+up in the
//   same frame would be missed. tapKey() holds each key >=100ms (~6 frames).
// - State polling: never sleep-and-hope; poll window.__IW.* via expect.poll.

import { expect } from '@playwright/test';

/**
 * Console allowlist. Keep EMPTY unless a benign browser/GPU informational
 * line proves unavoidable in headless Chromium. Every entry must carry a
 * `why` that can be quoted verbatim in the test report.
 */
export const CONSOLE_ALLOWLIST = [];

/**
 * Attach console + pageerror collectors. Returns an object whose `offenses()`
 * yields every console error/warning not covered by CONSOLE_ALLOWLIST plus
 * all uncaught page errors.
 */
export function watchConsole(page) {
  const messages = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    messages.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err instanceof Error ? err.message : String(err));
  });
  return {
    messages,
    pageErrors,
    offenses() {
      const consoleOffenses = messages.filter(
        (m) =>
          (m.type === 'error' || m.type === 'warning') &&
          !CONSOLE_ALLOWLIST.some((a) => a.re.test(m.text)),
      );
      return { console: consoleOffenses, pageErrors };
    },
  };
}

/** Navigate to the game and wait until boot has fully run (debug handle live). */
export async function gotoGame(page) {
  await page.goto('/');
  await page.waitForFunction(
    () => !!(window.__IW && window.__IW.G && window.__IW.G.player),
    null,
    { timeout: 20_000 },
  );
}

/** Dismiss the title screen and wait for G.started. */
export async function startGame(page) {
  await gotoGame(page);
  await page.locator('#iw-start').click();
  await expect.poll(() => page.evaluate(() => window.__IW.G.started)).toBe(true);
}

/**
 * Wait until mouse look has a working control path: pointer lock engaged OR
 * the game's free-cursor fallback (Input.lockBroken) tripped. Never assert
 * which one - specs must pass in both modes.
 */
export async function waitControlSettled(page) {
  await expect.poll(() =>
    page.evaluate(() => window.__IW.Input.locked || window.__IW.Input.lockBroken),
  ).toBe(true);
}

/** Hold a key down long enough for the frame-scoped pressed() poll to see it. */
export async function tapKey(page, code, holdMs = 120) {
  await page.keyboard.down(code);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(code);
}

/** Snapshot the player feet position as plain data. */
export function playerPos(page) {
  return page.evaluate(() => {
    const p = window.__IW.G.player.pos;
    return { x: p.x, y: p.y, z: p.z };
  });
}
