// Telemetry (Wave A): the F3 dev HUD must appear/disappear on toggle, never
// duplicate its DOM across repeated toggles, and show live-updating metrics.
// Drives the perf module directly through window.__IW.perf so the spec does
// not depend on keyboard focus.
import { expect, test } from '@playwright/test';
import { gotoGame, watchConsole } from './helpers.js';

const HUD_SELECTOR = '#iw-perf-hud';

test('F3 telemetry HUD toggles without DOM duplication', async ({ page }) => {
  const watched = watchConsole(page);
  await gotoGame(page);

  // Hidden by default (the element parks in the DOM with visibility off -
  // perf.js builds it once at create and toggles it).
  const count = () => page.locator(HUD_SELECTOR).count();
  await expect(page.locator(HUD_SELECTOR)).toBeHidden();

  // Toggle on via the module API (same path the F3 keydown handler uses).
  await page.evaluate(() => window.__IW.perf.toggleHud());
  await expect(page.locator(HUD_SELECTOR)).toHaveCount(1);
  await expect(page.locator(HUD_SELECTOR)).toBeVisible();

  // Metrics must be live: percentiles move as samples arrive. Under headless
  // software GL every real frame clamps to the same 50ms ceiling, so feed a
  // deterministic burst of varied synthetic frames through the module API and
  // require the HUD text to reflect them.
  const snap1 = await page.locator(HUD_SELECTOR).innerText();
  await page.evaluate(() => {
    for (let i = 0; i < 120; i++) window.__IW.perf.updatePerf(0.008);
  });
  const snap2 = await page.locator(HUD_SELECTOR).innerText();
  expect(snap2).not.toBe(snap1);
  expect(snap2).toContain('FPS');
  expect(snap2).toContain('draw');

  // Repeated toggles must never stack duplicate HUD nodes or listeners.
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.__IW.perf.toggleHud());
  expect(await count()).toBeLessThanOrEqual(1);

  // Final state: force ON, then OFF via the same API - ends hidden again,
  // still exactly one element (never duplicated across toggles).
  await page.evaluate(() => window.__IW.perf.toggleHud(true));
  await expect(page.locator(HUD_SELECTOR)).toBeVisible();
  await page.evaluate(() => window.__IW.perf.toggleHud(false));
  await expect(page.locator(HUD_SELECTOR)).toBeHidden();
  expect(await count()).toBe(1);

  const off = watched.offenses();
  expect(off.console).toEqual([]);
  expect(off.pageErrors).toEqual([]);
});

test('getReport exposes percentiles and renderer stats during play', async ({ page }) => {
  await gotoGame(page);
  // Let the ring buffer fill with real frames.
  await page.waitForTimeout(8000); // SwiftShader software GL can sit near 1fps here
  const report = await page.evaluate(() => {
    const r = window.__IW.perf.getReport();
    return {
      frames: r.frames,
      p50: r.frameMs.p50,
      p95: r.frameMs.p95,
      p99: r.frameMs.p99,
      drawCalls: r.gpu.calls,
      tris: r.gpu.triangles,
      quality: r.quality,
    };
  });
  expect(report.frames).toBeGreaterThan(2);
  expect(report.p50).toBeGreaterThan(0);
  // Headless SwiftShader (software GL) runs this scene at 100-600ms/frame;
  // the assertion only pins that percentiles are plausible time magnitudes.
  expect(report.p50).toBeLessThan(3000);
  expect(report.p95).toBeGreaterThanOrEqual(report.p50);
  expect(report.p99).toBeGreaterThanOrEqual(report.p95);
  expect(report.drawCalls).toBeGreaterThan(0);
  expect(report.tris).toBeGreaterThan(0);
  expect(['high', 'medium', 'low']).toContain(report.quality);
});
