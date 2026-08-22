// Settings quality switch: low <-> high must actually change the render
// resolution (renderer pixel ratio + canvas backing-store size), persist to
// localStorage ('ironwild-settings'), and survive a reload.
import { expect, test } from "@playwright/test";
import { gotoGame, SWGL_POLL_MS, SWGL_SPEC_MS } from "./helpers.js";

test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits in seconds

const VIEW_W = 1280; // playwright.config.js viewport width

async function renderState(page) {
  return page.evaluate(() => ({
    quality: window.__IW.G.settings.quality,
    pixelRatio: window.__IW.G.renderer.getPixelRatio(),
    canvasWidth: window.__IW.G.canvas.width,
  }));
}

test("quality low<->high changes render resolution and persists", async ({
  page,
}) => {
  await gotoGame(page);

  // Fresh boot defaults to high: preset pixel ratio 1.5 (src/main.js QUALITY_PRESETS).
  const initial = await renderState(page);
  expect(initial.quality).toBe("high");
  expect(initial.pixelRatio).toBeCloseTo(1.5, 5);
  expect(initial.canvasWidth).toBe(Math.round(VIEW_W * 1.5));

  // Open the settings modal via the start screen gear (stopPropagation keeps
  // the click-anywhere-to-begin from also firing).
  await page.locator("#iw-start .iw-gear").click();
  await expect(page.locator(".iw-settings")).toBeVisible();

  await page.locator("#iw-set-quality").selectOption("low");

  // Composer + renderer re-size live through the settingsChanged bus event.
  await expect
    .poll(renderState.bind(null, page), { timeout: SWGL_POLL_MS })
    .toEqual({
      quality: "low",
      pixelRatio: 1,
      canvasWidth: VIEW_W,
    });

  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ironwild-settings")),
  );
  expect(persisted.quality).toBe("low");

  // Back up to high before leaving the modal - exercises the upward switch too.
  await page.locator("#iw-set-quality").selectOption("high");
  await expect
    .poll(() => renderState(page).then((s) => s.pixelRatio), {
      timeout: SWGL_POLL_MS,
    })
    .toBeCloseTo(1.5, 5);
  await page.locator("#iw-set-close").click();
  await expect(page.locator(".iw-settings")).toBeHidden();
});

test("quality choice survives a reload", async ({ page }) => {
  await gotoGame(page);
  await page.locator("#iw-start .iw-gear").click();
  await expect(page.locator(".iw-settings")).toBeVisible();
  await page.locator("#iw-set-quality").selectOption("medium");
  await expect
    .poll(() => renderState(page).then((s) => s.pixelRatio), {
      timeout: SWGL_POLL_MS,
    })
    .toBeCloseTo(1.25, 5);
  await page.locator("#iw-set-close").click();

  // Fresh navigation: the persisted tier must be applied by boot itself
  // (loadSettings() runs before applyQuality()).
  await gotoGame(page);
  const restored = await renderState(page);
  expect(restored.quality).toBe("medium");
  expect(restored.pixelRatio).toBeCloseTo(1.25, 5);
  expect(restored.canvasWidth).toBe(Math.round(VIEW_W * 1.25));
});
