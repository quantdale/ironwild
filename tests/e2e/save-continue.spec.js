// Quicksave / Continue: KeyP writes the 'ironwild-save' slot, a reload shows
// the CONTINUE button, and continuing restores the saved position.
import { expect, test } from "@playwright/test";
import {
  gotoGame,
  playerPos,
  startGame,
  SWGL_POLL_MS,
  SWGL_SPEC_MS,
  tapKey,
} from "./helpers.js";

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits in seconds

test("KeyP quicksave -> reload -> Continue restores position", async ({
  page,
}) => {
  await startGame(page);
  const spawnPos = await playerPos(page);

  // Walk away from spawn (0, ?, 8) so the save clearly differs from boot
  // state. Wait on the ACTUAL displacement, not a wall-clock guess: at 60fps
  // 1.2s of walking covers ~6 units, but under software GL the same wall time
  // spans almost no frames - and historically this spec only passed there
  // because post-save momentum drift faked the final assertion.
  await page.keyboard.down("KeyW");
  await expect
    .poll(
      async () => {
        const p = await playerPos(page);
        return Math.hypot(p.x - spawnPos.x, p.z - spawnPos.z);
      },
      { timeout: SWGL_POLL_MS },
    )
    .toBeGreaterThan(6);
  await page.keyboard.up("KeyW");

  // Seed one active objective at the live player position so the save test
  // checks the real plain-data persistence boundary, not only position data.
  await page.evaluate(() => {
    const G = window.__IW.G;
    const p = G.player.pos;
    G.expedition = {
      active: {
        id: 77,
        type: "signal",
        x: p.x,
        z: p.z,
        label: "Saved Relay",
        radius: 3.2,
        maxTime: 120,
        timeLeft: 95,
        progress: 0,
      },
      completed: 3,
      nextId: 78,
      cooldown: 0,
    };
  });

  await tapKey(page, "KeyP"); // manual quicksave (src/systems/save.js updateSave)

  await expect
    .poll(
      () => page.evaluate(() => !!localStorage.getItem("ironwild-save")),
      { timeout: SWGL_POLL_MS }, // save write lands on the next sim frame
    )
    .toBe(true);

  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ironwild-save")),
  );
  expect(Array.isArray(saved.pos)).toBe(true);
  expect(saved.v).toBeGreaterThanOrEqual(2);
  expect(saved.expedition).toMatchObject({
    completed: 3,
    nextId: 78,
    active: {
      id: 77,
      type: "signal",
      label: "Saved Relay",
    },
  });

  // Fresh navigation: title screen must now offer CONTINUE (menus renders it
  // only when systems/save.js hasSave() is true at buildDom time).
  await page.goto("/");
  await page.waitForFunction(
    () => !!(window.__IW && window.__IW.G && window.__IW.G.player),
  );
  const continueBtn = page.locator("#iw-continue");
  await expect(continueBtn).toBeVisible({ timeout: SWGL_POLL_MS });

  await continueBtn.click();
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.started), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);

  // loadGame() applies the saved position synchronously inside the click
  // handler; sample immediately so live AI cannot drift the comparison. The
  // walk poll above already proved saved.pos is >6 units from spawn, so a
  // faithful restore must land far from spawn too - at ANY framerate.
  const restored = await playerPos(page);
  expect(
    dist(restored, { x: saved.pos[0], y: saved.pos[1], z: saved.pos[2] }),
  ).toBeLessThan(0.5);
  expect(dist(restored, spawnPos)).toBeGreaterThan(3); // really left spawn

  const restoredExpedition = await page.evaluate(() => window.__IW.G.expedition);
  expect(restoredExpedition).toMatchObject({
    completed: 3,
    nextId: 78,
    active: {
      id: 77,
      type: "signal",
      label: "Saved Relay",
    },
  });
});

// ---------------------------------------------------------------------------
// Run lifecycle (permadeath) - behavior INTRODUCED by the
// `enforce-permadeath-run-model` OpenSpec change. The spec above pins the
// pre-existing save -> reload -> continue behavior and must stay unchanged;
// these specs pin the NEW contract: a death ends the run's save (no CONTINUE,
// NEW RUN offered) and a new run is clean yet still saveable.
// ---------------------------------------------------------------------------

/**
 * Kill the player through the real death path (player.takeDamage emits
 * 'playerDied'), then wait until the death screen is interactive.
 */
async function dieAndShowDeathScreen(page) {
  await page.evaluate(() => {
    window.__IW.G.player.takeDamage(1e6);
  });
  await expect(page.locator(".iw-death")).toHaveClass(/show/, {
    timeout: SWGL_POLL_MS,
  });
  await expect(page.locator("#iw-restart")).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
}

test("death after a quicksave -> RESTART -> title offers no CONTINUE, keeps NEW RUN", async ({
  page,
}) => {
  await startGame(page);

  // Give the run real progress first: quicksave writes a restorable slot.
  await tapKey(page, "KeyP");
  await expect
    .poll(() => page.evaluate(() => !!localStorage.getItem("ironwild-save")), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);

  await dieAndShowDeathScreen(page);

  // The death mark replaces the slot with the ended run's final snapshot.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = JSON.parse(localStorage.getItem("ironwild-save"));
          return !!(s && s.run && s.run.ended === true);
        }),
      { timeout: SWGL_POLL_MS },
    )
    .toBe(true);

  // RESTART is just a reload (menus.js), landing back on the title screen.
  await page.locator("#iw-restart").click();
  await gotoGame(page);

  // Task 5.1: the finished run must not be offered for continuation, but the
  // player must be able to deliberately start over (NEW EXPEDITION = NEW RUN).
  await expect(page.locator("#iw-continue")).toHaveCount(0);
  await expect(page.locator("#iw-newrun")).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
});

test("death -> NEW RUN starts from default state (health, inventory, level)", async ({
  page,
}) => {
  await startGame(page);

  // Dirty the run so "defaults" is meaningful: gather resources and xp, save.
  await page.evaluate(() => {
    const G = window.__IW.G;
    G.inventory.shards = 40;
    G.inventory.wood = 25;
    G.xp.level = 3;
    G.xp.cur = 50;
  });
  await tapKey(page, "KeyP");
  await expect
    .poll(() => page.evaluate(() => !!localStorage.getItem("ironwild-save")), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);

  await dieAndShowDeathScreen(page);
  await page.locator("#iw-restart").click();
  await gotoGame(page);
  await expect(page.locator("#iw-newrun")).toBeVisible({
    timeout: SWGL_POLL_MS,
  });

  // NEW EXPEDITION: confirm dialog clears the slot and reloads (menus.js
  // newRun - unchanged by this change). Accept the confirm.
  page.once("dialog", (d) => d.accept());
  await page.locator("#iw-newrun").click();
  await gotoGame(page);

  // Task 5.2: no save slot means no CONTINUE, and clicking through starts a
  // run from the documented defaults (state.js fresh inventory/xp).
  await expect(page.locator("#iw-continue")).toHaveCount(0);
  await page.locator("#iw-start").click();
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.started), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);

  await expect
    .poll(() => page.evaluate(() => {
      const G = window.__IW.G;
      return {
        hp: G.player.hp,
        maxHp: G.player.maxHp,
        shards: G.inventory.shards,
        wood: G.inventory.wood,
        level: G.xp.level,
      };
    }), { timeout: SWGL_POLL_MS })
    .toEqual({ hp: 100, maxHp: 100, shards: 0, wood: 8, level: 1 });
});

test("a new run after a death can itself be saved and continued", async ({
  page,
}) => {
  // Task 5.4: the lifecycle must not dead-end - run 1 dies, run 2 is a normal
  // saveable run. Seed the ENDED slot directly to skip replaying run 1's
  // death: the data-level contract is what these lifecycle specs pin.
  await gotoGame(page);
  await page.evaluate(() => {
    localStorage.setItem(
      "ironwild-save",
      JSON.stringify({ v: 4, run: { ended: true, endedAt: 1 }, pos: [0, 2, 8] }),
    );
  });

  // Finished run on disk: still no CONTINUE.
  await gotoGame(page);
  await expect(page.locator("#iw-continue")).toHaveCount(0);

  // Start fresh (click-anywhere path, no save to clear), walk, quicksave.
  await page.locator("#iw-start").click();
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.started), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);
  const spawnPos = await playerPos(page);
  await page.keyboard.down("KeyW");
  await expect
    .poll(
      async () => {
        const p = await playerPos(page);
        return Math.hypot(p.x - spawnPos.x, p.z - spawnPos.z);
      },
      { timeout: SWGL_POLL_MS },
    )
    .toBeGreaterThan(6);
  await page.keyboard.up("KeyW");
  await tapKey(page, "KeyP");

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const s = JSON.parse(localStorage.getItem("ironwild-save"));
          return !!(s && s.pos && (!s.run || s.run.ended !== true));
        }),
      { timeout: SWGL_POLL_MS },
    )
    .toBe(true);
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("ironwild-save")),
  );

  // Reload: run 2 is restorable and CONTINUE restores it (normal flow).
  await gotoGame(page);
  const continueBtn = page.locator("#iw-continue");
  await expect(continueBtn).toBeVisible({ timeout: SWGL_POLL_MS });
  await continueBtn.click();
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.started), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);
  const restored = await playerPos(page);
  expect(
    dist(restored, { x: saved.pos[0], y: saved.pos[1], z: saved.pos[2] }),
  ).toBeLessThan(0.5);
});
