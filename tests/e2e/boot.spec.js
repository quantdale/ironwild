// Boot smoke: the production bundle must come up with a title screen and
// produce ZERO console errors/warnings and ZERO pageerrors before any user
// interaction. This guards the audio autoplay fix (no AudioContext before a
// gesture) and the inline favicon (no 404).
import { expect, test } from '@playwright/test';
import { gotoGame, watchConsole } from './helpers.js';

test('boots to title screen with a clean console', async ({ page }) => {
  const consoleLog = watchConsole(page); // attach BEFORE navigation

  await gotoGame(page);

  // Title screen is up with its call-to-action.
  const start = page.locator('#iw-start');
  await expect(start).toBeVisible();
  await expect(start.locator('.iw-title')).toHaveText('IRONWILD');
  await expect(start.locator('.iw-clickbegin')).toBeVisible();
  await expect(start).not.toHaveClass(/hidden/);

  // Favicon is inline (data URI) - no network request, no 404 possible.
  const favicon = await page.evaluate(() => {
    const link = document.querySelector('link[rel="icon"]');
    return link ? link.getAttribute('href') : null;
  });
  expect(favicon && favicon.startsWith('data:image/svg+xml')).toBe(true);

  // The world actually built: scene, renderer and a populated machine roster.
  const booted = await page.evaluate(() => ({
    scene: !!window.__IW.G.scene,
    renderer: !!window.__IW.G.renderer,
    machines: window.__IW.G.machines.length,
    pickups: window.__IW.G.pickups.length,
    started: window.__IW.G.started,
  }));
  expect(booted.scene).toBe(true);
  expect(booted.renderer).toBe(true);
  expect(booted.machines).toBeGreaterThan(0);
  expect(booted.pickups).toBeGreaterThan(0);
  expect(booted.started).toBe(false);

  // Zero-tolerance console check (allowlist is empty; see helpers.js).
  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, 'uncaught page errors').toEqual([]);
  expect(consoleOffenses, 'console errors/warnings before any interaction')
    .toEqual([]);
});
