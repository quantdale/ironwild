// Dynamic resolution (Wave A): bounded scale, quality-tier bounds, published
// contract value, and UI resolution independence. The control law itself is
// unit-covered; here we verify the INTEGRATION deterministically via the
// debugFeed seam (same average+decision path as real frames, bypassing the
// hidden/paused gates that exist to protect real-frame statistics).
import { expect, test } from "@playwright/test";
import { gotoGame } from "./helpers.js";

test("dynres stays within tier bounds and publishes its scale", async ({
  page,
}) => {
  await gotoGame(page);

  const state = () =>
    page.evaluate(() => ({
      scale: window.__IW.dynres.getScale(),
      published: window.__IW_DYNRES_SCALE,
      ratio: window.__IW.G.renderer.getPixelRatio(),
      cssW: window.__IW.G.canvas.clientWidth,
    }));

  // Sustained overloaded frames (33ms avg >> 18.5ms band) must walk the scale
  // DOWN toward the high-tier floor (0.65) and stop there - never below.
  await page.evaluate(() => {
    for (let i = 0; i < 120; i++) window.__IW.dynres.debugFeed(33);
  });
  const afterLoad = await state();
  expect(afterLoad.scale).toBeGreaterThanOrEqual(0.65);
  expect(afterLoad.scale).toBeLessThan(1);
  expect(afterLoad.published).toBeCloseTo(afterLoad.scale, 5);
  // Applied pixel ratio tracks basePR(1.5 at high) * scale, quantized 0.05.
  expect(afterLoad.ratio).toBeGreaterThan(0.9); // 1.5 * 0.65 = 0.975 minimum
  expect(afterLoad.ratio).toBeLessThanOrEqual(1.5);

  // Sustained healthy frames recover toward (but not above) the 1.0 ceiling.
  await page.evaluate(() => {
    for (let i = 0; i < 400; i++) window.__IW.dynres.debugFeed(16);
  });
  const recovered = await state();
  expect(recovered.scale).toBeLessThanOrEqual(1);
  expect(recovered.scale).toBeGreaterThan(afterLoad.scale);
  // The HUD canvas is plain DOM: its CSS size never depends on render scale.
  expect(recovered.cssW).toBe(1280);
});

test("quality switch re-bases the controller", async ({ page }) => {
  await gotoGame(page);

  // Walk deep into a downscale at high, then switch tiers via the same bus
  // path the settings modal uses. A tier switch is a deliberate re-baseline:
  // the new tier's OWN resolution must apply immediately at full scale -
  // no adaptive deficit carried over from the old tier.
  const walkedDown = await page.evaluate(() => {
    for (let i = 0; i < 120; i++) window.__IW.dynres.debugFeed(33);
    return window.__IW.dynres.getScale();
  });
  expect(walkedDown).toBeLessThan(1); // precondition: genuinely downscaled
  await page.evaluate(() => {
    window.__IW.G.settings.quality = "low";
    window.__IW.bus.emit("settingsChanged", { key: "quality", value: "low" });
  });
  const lowTier = await page.evaluate(() => ({
    scale: window.__IW.dynres.getScale(),
    ratio: window.__IW.G.renderer.getPixelRatio(),
  }));
  // Low preset basePR is 1.0; reset scale 1.0 quantizes to exactly that.
  expect(lowTier.scale).toBe(1);
  expect(lowTier.ratio).toBeCloseTo(1.0, 5);
});
