// Clean session: ~20s of real play - move, look, aim, loose an arrow, focus
// scan, open/close every panel, pause/resume - with ZERO console errors and
// ZERO pageerrors throughout. Allowlist is empty (see helpers.js); any offense
// fails the test.
import { expect, test } from "@playwright/test";
import {
  startGame,
  SWGL_POLL_MS,
  SWGL_SPEC_MS,
  tapKey,
  waitControlSettled,
  watchConsole,
} from "./helpers.js";

test("20s mixed session stays console-clean", async ({ page }) => {
  // Wall-clock budget: under headless SwiftShader the sim crawls near 1fps
  // (worse when an external VM loads the host - observed ~0.5fps sustained).
  // The spec asserts CONSOLE cleanliness over a mixed session, not session
  // duration. Budget math (not a guess): rawDt is clamped to 0.05s/frame, so
  // the >8s gameplay-clock invariant needs >=160 SIMULATED frames; at the
  // observed worst sustained cadence that is hundreds of wall seconds, on top
  // of starved action latency. SWGL_SPEC_MS covers it with margin; hardware
  // GL finishes in ~15-30s regardless (polls exit early).
  test.setTimeout(SWGL_SPEC_MS);
  const consoleLog = watchConsole(page); // attach BEFORE navigation
  await startGame(page);
  await waitControlSettled(page);

  // The invariant under test is CONSOLE cleanliness across a mixed session -
  // not survivability. On a starved host the scripted sequence spans minutes
  // of wall clock and roaming machines can kill the idle-ish player, which
  // ends the session early (gameOver pauses panels - see the final assert).
  // Clear threats through the game's own damage path so nothing can end the
  // run while the harness drives it.
  await page.evaluate(() => {
    for (const m of window.__IW.G.machines) {
      let guard = 0;
      while (m.alive && guard++ < 99) m.hit(1e9, m.group.position.clone(), null);
    }
  });

  // --- move + look ---
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(800);
  await page.keyboard.up("KeyW");
  await page.mouse.move(640, 360);
  await page.mouse.move(860, 340, { steps: 6 });
  await page.mouse.move(420, 380, { steps: 6 });

  // --- aim + loose one real arrow ---
  const arrowsBefore = await page.evaluate(
    () => window.__IW.G.inventory.arrows,
  );
  await page.mouse.down({ button: "right" });
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.cam.aiming))
    .toBe(true);
  await page.mouse.down({ button: "left" }); // draw
  // Wait on the GAME-state draw meter, not wall clock: under headless
  // SwiftShader ~1fps a fixed 400ms hold can elapse between frames and the
  // release would find zero draw power. 0.25 draw is well above the fire floor.
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.player.drawT), {
      timeout: 60_000,
    })
    .toBeGreaterThanOrEqual(0.25);
  await page.mouse.up({ button: "left" }); // loose
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.inventory.arrows), {
      timeout: 60_000,
    })
    .toBe(arrowsBefore - 1);
  await page.mouse.up({ button: "right" });
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.cam.aiming))
    .toBe(false);

  // --- focus scan: world time dilates while Q is held ---
  await page.keyboard.down("KeyQ");
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.timeScale))
    .toBeLessThan(0.5);
  await page.waitForTimeout(600);
  await page.keyboard.up("KeyQ");
  await expect.poll(() => page.evaluate(() => window.__IW.G.timeScale)).toBe(1);

  // --- panels: inventory / skills / bestiary (budgets: starved-host frame gaps) ---
  await tapKey(page, "KeyI");
  await expect(page.locator("#iw-craft-arrows")).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
  await tapKey(page, "KeyI");
  await expect(page.locator("#iw-craft-arrows")).toBeHidden({
    timeout: SWGL_POLL_MS,
  });

  await tapKey(page, "Tab");
  await expect(page.locator(".iw-skill").first()).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
  await tapKey(page, "Tab");
  await expect(page.locator(".iw-skill").first()).toBeHidden({
    timeout: SWGL_POLL_MS,
  });

  await tapKey(page, "KeyB");
  await expect(page.locator(".iw-best").first()).toBeVisible({
    timeout: SWGL_POLL_MS,
  });
  await tapKey(page, "Escape"); // panels close on Esc too
  await expect(page.locator(".iw-best").first()).toBeHidden({
    timeout: SWGL_POLL_MS,
  });

  // --- pause/resume round trip ---
  await waitControlSettled(page); // relock after panel close has settled
  await tapKey(page, "Escape");
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.paused), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(true);
  await page.locator("#iw-resume").click();
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.paused), {
      timeout: SWGL_POLL_MS,
    })
    .toBe(false);

  // --- sprint, jump, backtrack ---
  await page.keyboard.down("ShiftLeft");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(700);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("ShiftLeft");
  await tapKey(page, "Space", 100); // jump
  await page.keyboard.down("KeyS");
  await page.waitForTimeout(400);
  await page.keyboard.up("KeyS");

  // --- idle render tail; the game keeps simulating. Wait on the scaled
  // gameplay clock ITSELF rather than assuming a wall-clock duration maps to
  // N game-seconds: at 60fps the scripted sequence above spans only ~6
  // game-seconds, while at ~1fps software GL the same clicks span minutes.
  // The invariant under test is unchanged (the clock really advanced >8s).
  await expect
    .poll(() => page.evaluate(() => window.__IW.G.elapsed), {
      timeout: 600_000, // see ceiling math above: 8 game-s = >=160 frames starved
    })
    .toBeGreaterThan(8);
  await page.mouse.move(700, 300, { steps: 4 });

  const finalState = await page.evaluate(() => ({
    elapsed: window.__IW.G.elapsed,
    started: window.__IW.G.started,
    gameOver: window.__IW.G.gameOver,
  }));
  expect(finalState.started).toBe(true);
  expect(finalState.gameOver).toBe(false);
  expect(
    finalState.elapsed,
    "scaled gameplay clock really advanced",
  ).toBeGreaterThan(8);

  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, "uncaught page errors during session").toEqual([]);
  expect(consoleOffenses, "console errors/warnings during session").toEqual([]);
});
