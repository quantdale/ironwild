// Accessibility + machine animator lifecycle (Waves I/J verification):
// - persisted a11y settings reach their runtime consumers through the BOOT
//   path (localStorage pre-seed -> loadSettings -> a11y/hud appliers);
// - live settingsChanged updates reach consumers without reload;
// - every spawned machine owns exactly one animator; death disposes it.
import { expect, test } from '@playwright/test';
import { gotoGame, startGame } from './helpers.js';

test('persisted a11y settings apply through boot and update live', async ({ page }) => {
  // Pre-seed storage the way the settings modal persists it, then boot.
  await gotoGame(page);
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ironwild-settings') || '{}');
    s.uiScale = 1.2;
    s.camShakeScale = 0;
    s.highContrastCues = true;
    localStorage.setItem('ironwild-settings', JSON.stringify(s));
  });
  await gotoGame(page); // fresh boot: loadSettings must reapply everything

  const applied = await page.evaluate(() => ({
    a11y: window.__IW_A11Y,
    barsTransform: getComputedStyle(document.querySelector('#iw-bars')).transform,
    hcClass: document.body.classList.contains('iw-high-contrast'),
    stored: JSON.parse(localStorage.getItem('ironwild-settings')),
  }));
  expect(applied.a11y.uiScale).toBeCloseTo(1.2, 5);
  expect(applied.a11y.camShakeScale).toBe(0);
  expect(applied.a11y.highContrast).toBe(true);
  // HUD root carries the scale transform (matrix(1.2,...) form).
  expect(applied.barsTransform).not.toBe('none');
  expect(applied.hcClass).toBe(true);
  expect(applied.stored.uiScale).toBe(1.2);

  // Live path (what the modal emits): consumers react without reload.
  await page.evaluate(() => {
    window.__IW.G.settings.uiScale = 1;
    window.__IW.bus.emit('settingsChanged', { key: 'uiScale', value: 1 });
  });
  await expect.poll(() =>
    page.evaluate(() => window.__IW_A11Y.uiScale),
  ).toBe(1);

  // Restore defaults so other specs start clean.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('ironwild-settings') || '{}');
    delete s.uiScale;
    delete s.camShakeScale;
    delete s.highContrastCues;
    localStorage.setItem('ironwild-settings', JSON.stringify(s));
  });
});

test('every live machine has exactly one animator; death disposes it', async ({ page }) => {
  test.setTimeout(200_000); // software GL: each simulated frame costs real seconds
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
      (m) => m.alive &&
        !['monarch', 'vantage', 'bulwark', 'mirefang'].includes(m.type),
    );
    if (window.__IW.victim) window.__IW.victim.hit(99999, null, null);
  });
  await expect.poll(() =>
    page.evaluate(() => window.__IW.victim && !window.__IW.victim.alive),
  ).toBe(true);

  // Corpses persist HARVESTABLE for CARCASS_LIFE before a 1.5s tip-over fade
  // hands them to disposeMachine, whose SAME-TICK finalize clears the animator
  // (ai.js runs it right after m.update inside its roster loop). We jump the
  // corpse clock exactly like completeHarvest does, then let the REAL loop run
  // the whole sequence - calling v.update() by hand would splice the record
  // outside that loop and skip the finalize, which no real death ever does.
  await page.evaluate(() => {
    const v = window.__IW.victim;
    if (v._anim) v._anim.deadTime = 999; // > CARCASS_LIFE: start fading now
  });
  // Headless software GL simulates <1 clamped fps, so the 1.5s game-time fade
  // can take minutes of wall clock; poll patiently (real GPUs pass instantly).
  await expect.poll(() =>
    page.evaluate(() => {
      const v = window.__IW.victim;
      return !window.__IW.G.machines.includes(v) &&
        (v.animator == null || v.animator._disposed === true);
    }),
    { timeout: 150_000 },
  ).toBe(true);
});
