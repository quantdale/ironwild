// Inventory + crafting: the panel opens/closes, resource readouts mirror
// G.inventory, and every craft button's disabled state is consistent with the
// inventory counts. Counts are forced via __IW.G.inventory to exercise both
// states deterministically, then a real CRAFT click runs the game's own
// craftArrows/craftArmor paths.
import { expect, test } from "@playwright/test";
import { startGame, SWGL_POLL_MS, SWGL_SPEC_MS, tapKey } from "./helpers.js";

// Cell order fixed by ui/menus.js buildDom() resource grid.
const CELL_KEYS = [
  "wood",
  "shards",
  "oil",
  "medicine",
  "arrows",
  "fireArrows",
  "hide",
];

async function openInventory(page) {
  await tapKey(page, "KeyI");
  await expect(page.locator("#iw-craft-arrows")).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
}

async function closeInventory(page) {
  await tapKey(page, "KeyI");
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.paused), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(false);
}

async function displayedCounts(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll("#iw-res-grid .iw-res-cell .iw-res-val"),
    ).map((el) => Number(el.textContent)),
  );
}

test("inventory panel opens, mirrors counts, closes", async ({ page }) => {
  test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling (was 240s: pre-evidence guess)
  await startGame(page);

  await openInventory(page);
  const inv = await page.evaluate(() => ({ ...window.__IW.G.inventory }));
  expect(await displayedCounts(page)).toEqual(CELL_KEYS.map((k) => inv[k]));
  expect(await page.evaluate(() => window.__IW.G.paused)).toBe(true);

  await closeInventory(page);
  await expect(page.locator("#iw-craft-arrows")).toBeHidden();
});

test("craft buttons disabled when resources are scarce", async ({ page }) => {
  test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling (was 240s: pre-evidence guess)
  await startGame(page);

  // Strip the default stock (8 wood / 2 medicine) so nothing is affordable.
  await page.evaluate(() => {
    Object.assign(window.__IW.G.inventory, {
      wood: 0,
      shards: 0,
      oil: 0,
      medicine: 0,
      arrows: 0,
      fireArrows: 0,
      hide: 0,
    });
  });

  await openInventory(page);
  await expect(page.locator("#iw-craft-arrows")).toBeDisabled();
  await expect(page.locator("#iw-craft-med")).toBeDisabled();
  await expect(page.locator("#iw-craft-fire")).toBeDisabled();
  await expect(page.locator("#iw-craft-armor")).toBeDisabled();

  await closeInventory(page);
});

test("enabled when affordable; real craft clicks consume and produce", async ({
  page,
}) => {
  test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling (was 240s: pre-evidence guess)
  await startGame(page);

  // Rich loadout: arrows craftable (1 wood+2 shards), medicine (2 oil+1 wood),
  // fire arrows (2 oil+3 shards), armor rank 1 (4 hide+3 shards).
  await page.evaluate(() => {
    Object.assign(window.__IW.G.inventory, {
      wood: 5,
      shards: 10,
      oil: 5,
      medicine: 0,
      arrows: 0,
      fireArrows: 0,
      hide: 4,
      armor: 0,
    });
  });

  await openInventory(page);
  await expect(page.locator("#iw-craft-arrows")).toBeEnabled();
  await expect(page.locator("#iw-craft-med")).toBeEnabled();
  await expect(page.locator("#iw-craft-fire")).toBeEnabled();
  await expect(page.locator("#iw-craft-armor")).toBeEnabled();

  // Craft arrows x5: -1 wood, -2 shards, +5 arrows (ui/menus.js craftArrows).
  await page.locator("#iw-craft-arrows").click();
  const afterArrows = await page.evaluate(() => {
    const inv = window.__IW.G.inventory;
    return { wood: inv.wood, shards: inv.shards, arrows: inv.arrows };
  });
  expect(afterArrows).toEqual({ wood: 4, shards: 8, arrows: 5 });

  // Armor upgrade rank 0 -> 1: -4 hide, -3 shards.
  await page.locator("#iw-craft-armor").click();
  const afterArmor = await page.evaluate(() => {
    const inv = window.__IW.G.inventory;
    return { hide: inv.hide, shards: inv.shards, armor: inv.armor };
  });
  expect(afterArmor).toEqual({ hide: 0, shards: 5, armor: 1 });

  // Rank 2 now costs 6 hide + 6 shards; hide is 0 -> button must disable.
  await expect(page.locator("#iw-craft-armor")).toBeDisabled();

  // Readouts refreshed with the crafted numbers.
  const invNow = await page.evaluate(() => ({ ...window.__IW.G.inventory }));
  expect(await displayedCounts(page)).toEqual(CELL_KEYS.map((k) => invNow[k]));

  await closeInventory(page);
});
