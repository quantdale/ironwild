// Accessibility + machine animator lifecycle (Waves I/J verification):
// - persisted a11y settings reach their runtime consumers through the BOOT
//   path (localStorage pre-seed -> loadSettings -> a11y/hud appliers);
// - live settingsChanged updates reach consumers without reload;
// - every spawned machine owns exactly one animator; death disposes it.
// Extended for honor-accessibility-preferences: the REDUCE FLASHING preference
// must apply live and on boot (body class 'iw-reduce-flashing'), must change
// the RENDERED state of the flashing layers (computed animation-name on
// #iw-vig / #iw-grain), and must round-trip through 'ironwild-settings'.
import { expect, test } from "@playwright/test";
import {
  gotoGame,
  startGame,
  watchConsole,
  SWGL_POLL_MS,
  SWGL_SPEC_MS,
} from "./helpers.js";

test("persisted a11y settings apply through boot and update live", async ({
  page,
}) => {
  // Pre-seed storage the way the settings modal persists it, then boot.
  await gotoGame(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("ironwild-settings") || "{}");
    s.uiScale = 1.2;
    s.camShakeScale = 0;
    s.highContrastCues = true;
    localStorage.setItem("ironwild-settings", JSON.stringify(s));
  });
  await gotoGame(page); // fresh boot: loadSettings must reapply everything

  const applied = await page.evaluate(() => ({
    a11y: window.__IW_A11Y,
    barsTransform: getComputedStyle(document.querySelector("#iw-bars"))
      .transform,
    hcClass: document.body.classList.contains("iw-high-contrast"),
    stored: JSON.parse(localStorage.getItem("ironwild-settings")),
  }));
  expect(applied.a11y.uiScale).toBeCloseTo(1.2, 5);
  expect(applied.a11y.camShakeScale).toBe(0);
  expect(applied.a11y.highContrast).toBe(true);
  // HUD root carries the scale transform (matrix(1.2,...) form).
  expect(applied.barsTransform).not.toBe("none");
  expect(applied.hcClass).toBe(true);
  expect(applied.stored.uiScale).toBe(1.2);

  // Live path (what the modal emits): consumers react without reload.
  await page.evaluate(() => {
    window.__IW.G.settings.uiScale = 1;
    window.__IW.bus.emit("settingsChanged", { key: "uiScale", value: 1 });
  });
  await expect
    .poll(() => page.evaluate(() => window.__IW_A11Y.uiScale))
    .toBe(1);

  // Restore defaults so other specs start clean.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("ironwild-settings") || "{}");
    delete s.uiScale;
    delete s.camShakeScale;
    delete s.highContrastCues;
    localStorage.setItem("ironwild-settings", JSON.stringify(s));
  });
});

test("every live machine has exactly one animator; death disposes it", async ({
  page,
}) => {
  test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling (was 200s: pre-evidence guess)
  await startGame(page);
  await page.waitForTimeout(1000); // world population settled

  const audit = await page.evaluate(() => {
    const ms = window.__IW.G.machines;
    return {
      count: ms.length,
      withAnimator: ms.filter((m) => m.animator).length,
      disposed: ms.filter((m) => m.animator && m.animator._disposed).length,
    };
  });
  expect(audit.count).toBeGreaterThan(0);
  expect(audit.withAnimator).toBe(audit.count); // exactly one each
  expect(audit.disposed).toBe(0);

  // Kill one easily-killed machine through its real damage entry point and
  // confirm the kill landed before watching for teardown.
  await page.evaluate(() => {
    const G = window.__IW.G;
    window.__IW.victim = G.machines.find(
      (m) =>
        m.alive &&
        !["monarch", "vantage", "bulwark", "mirefang"].includes(m.type),
    );
    if (window.__IW.victim) window.__IW.victim.hit(99999, null, null);
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => window.__IW.victim && !window.__IW.victim.alive),
      { timeout: SWGL_POLL_MS },
    )
    .toBe(true);

  // Corpses persist HARVESTABLE for CARCASS_LIFE before a 1.5s tip-over fade
  // hands them to disposeMachine, whose SAME-TICK finalize clears the animator
  // (ai.js runs it right after m.update inside its roster loop). We jump the
  // corpse clock exactly like completeHarvest does, then let the REAL loop run
  // the whole sequence - calling v.update() by hand would splice the record
  // outside that loop and skip the finalize, which no real death ever does.
  await page.evaluate(() => {
    const v = window.__IW.victim;
    if (v._anim) {
      // Jump BOTH clocks exactly like completeHarvest jumps deadTime: past the
      // persist window AND to the brink of the 1.5s fade. The very next real
      // updateDeath frame completes fadeT >= 1 -> m.dispose() -> the ai-loop
      // finalize clears the animator. One simulated frame suffices at ANY
      // framerate (the old form needed 1.5s of accumulated game time = 30
      // clamped frames = minutes of wall clock under sub-1fps software GL).
      v._anim.deadTime = 999;
      v._anim.fadeT = 0.999;
    }
  });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const v = window.__IW.victim;
          return (
            !window.__IW.G.machines.includes(v) &&
            (v.animator == null || v.animator._disposed === true)
          );
        }),
      { timeout: SWGL_POLL_MS }, // one frame suffices; the budget outlasts frame GAPS
    )
    .toBe(true);
});

// --- honor-accessibility-preferences: REDUCE FLASHING lifecycle -------------

test("reduceFlashing is absent by default and applies at boot when persisted", async ({
  page,
}) => {
  const consoleLog = watchConsole(page); // attach BEFORE navigation

  // Default (nothing saved): no body class, and the flashing layers animate.
  await gotoGame(page);
  const defaulted = await page.evaluate(() => ({
    cls: document.body.classList.contains("iw-reduce-flashing"),
    stored: JSON.parse(localStorage.getItem("ironwild-settings") || "{}"),
    grainAnimation: getComputedStyle(document.querySelector("#iw-grain"))
      .animationName,
  }));
  expect(defaulted.cls).toBe(false);
  expect(defaulted.stored.reduceFlashing ?? false).toBe(false);
  expect(defaulted.grainAnimation).toBe("iwgrain"); // negative control (5.3)

  // Persist the preference the way the settings modal does (whole object).
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("ironwild-settings") || "{}");
    s.reduceFlashing = true;
    localStorage.setItem("ironwild-settings", JSON.stringify(s));
  });

  // Fresh boot: the class must be on <body> before any flashing effect can
  // run (loadSettings -> createA11y -> apply() during boot).
  await gotoGame(page);
  const booted = await page.evaluate(() => ({
    cls: document.body.classList.contains("iw-reduce-flashing"),
    a11y: window.__IW_A11Y.reduceFlashing,
    stored: JSON.parse(localStorage.getItem("ironwild-settings")),
  }));
  expect(booted.cls).toBe(true);
  expect(booted.a11y).toBe(true);
  expect(booted.stored.reduceFlashing).toBe(true); // round-trip intact

  // Restore defaults so other specs start clean.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("ironwild-settings") || "{}");
    delete s.reduceFlashing;
    localStorage.setItem("ironwild-settings", JSON.stringify(s));
  });

  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, "uncaught page errors").toEqual([]);
  expect(consoleOffenses, "console errors across the preference change").toEqual(
    [],
  );
});

test("reduceFlashing damps the low-health vignette pulse but keeps the warning", async ({
  page,
}) => {
  test.setTimeout(SWGL_SPEC_MS); // starved-host ceiling; hardware exits fast
  const consoleLog = watchConsole(page); // attach BEFORE navigation
  await startGame(page);

  // Negative control first (5.3): preference OFF -> the pulsing layer keeps a
  // non-none animation name, proving the assertion below is meaningful.
  await page.evaluate(() => {
    window.__IW.G.settings.reduceFlashing = false;
    window.__IW.bus.emit("settingsChanged", {
      key: "reduceFlashing",
      value: false,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.body.classList.contains("iw-reduce-flashing"),
      ),
    )
    .toBe(false);

  // Force health below the low-health threshold (hpF < 0.3 in hud.js
  // updateHUD) and wait for the real frame loop to flag the vignette.
  await page.evaluate(() => {
    const p = window.__IW.G.player;
    p.hp = p.maxHp * 0.1;
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document.querySelector("#iw-vig").classList.contains("on"),
        ),
      { timeout: SWGL_POLL_MS },
    )
    .toBe(true);

  const offState = await page.evaluate(() => {
    const vig = document.querySelector("#iw-vig");
    return {
      animation: getComputedStyle(vig).animationName,
      opacity: parseFloat(getComputedStyle(vig).opacity),
    };
  });
  expect(offState.animation).not.toBe("none"); // pulses while OFF
  expect(offState.opacity).toBeGreaterThan(0); // the 0.25..0.85 keyframe frame

  // Live toggle: no reload, no re-entering gameplay - the class must flip now.
  await page.evaluate(() => {
    window.__IW.G.settings.reduceFlashing = true;
    window.__IW.bus.emit("settingsChanged", {
      key: "reduceFlashing",
      value: true,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.body.classList.contains("iw-reduce-flashing"),
      ),
    )
    .toBe(true);

  const onState = await page.evaluate(() => {
    const vig = document.querySelector("#iw-vig");
    return {
      stillOn: vig.classList.contains("on"),
      animation: getComputedStyle(vig).animationName,
      opacity: parseFloat(getComputedStyle(vig).opacity),
      grainAnimation: getComputedStyle(document.querySelector("#iw-grain"))
        .animationName,
    };
  });
  // Rendered state (5.2): the layer stays ON (the warning is kept) but its
  // computed animation is gone and the static opacity is non-zero.
  expect(onState.stillOn).toBe(true);
  expect(onState.animation).toBe("none");
  expect(onState.opacity).toBeGreaterThan(0);
  expect(onState.grainAnimation).toBe("none"); // grain texture stays, motion dies

  // Disabling restores the animated behavior (spec scenario).
  await page.evaluate(() => {
    window.__IW.G.settings.reduceFlashing = false;
    window.__IW.bus.emit("settingsChanged", {
      key: "reduceFlashing",
      value: false,
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          getComputedStyle(document.querySelector("#iw-vig")).animationName,
      ),
    )
    .toBe("iwvig"); // exact restore: the pulse keyframe, not just "not none"

  // Console stays clean across the preference change (5.4): toggling must not
  // log missing-element or style errors.
  const { console: consoleOffenses, pageErrors } = consoleLog.offenses();
  expect(pageErrors, "uncaught page errors across the live toggle").toEqual([]);
  expect(consoleOffenses, "console errors across the live toggle").toEqual([]);

  // Leave the run clean for the next spec.
  await page.evaluate(() => {
    window.__IW.G.player.hp = window.__IW.G.player.maxHp;
    const s = JSON.parse(localStorage.getItem("ironwild-settings") || "{}");
    delete s.reduceFlashing;
    localStorage.setItem("ironwild-settings", JSON.stringify(s));
  });
});
