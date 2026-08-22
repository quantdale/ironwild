// Throwaway diagnostic 5: served-bundle freshness + promise settlement.
import { expect, test } from '@playwright/test';
import { watchConsole } from './helpers.js';

test.setTimeout(240_000);

test('diag5: is the fix live, and does the lock promise settle?', async ({ page }) => {
  const wc = watchConsole(page);
  await page.addInitScript(() => {
    window.__pl = [];
    document.addEventListener('pointerlockchange', () =>
      window.__pl.push(['change', document.pointerLockElement?.tagName || 'null', performance.now() | 0]));
    document.addEventListener('pointerlockerror', () =>
      window.__pl.push(['error', performance.now() | 0]));
    const orig = Element.prototype.requestPointerLock;
    if (orig) {
      Element.prototype.requestPointerLock = function (...a) {
        window.__pl.push(['requested', performance.now() | 0]);
        try {
          const p = orig.apply(this, a);
          if (p && typeof p.then === 'function') {
            window.__pl.push(['promise-returned']);
            let settled = false;
            p.then(
              () => { settled = true; window.__pl.push(['resolved', document.pointerLockElement?.tagName || 'null']); },
              (err) => { settled = true; window.__pl.push(['rejected', String(err && err.name)]); },
            );
            setTimeout(() => { if (!settled) window.__pl.push(['STILL-PENDING', performance.now() | 0]); }, 3000);
          } else {
            window.__pl.push(['NO-PROMISE (undefined return)']);
          }
        } catch (err) {
          window.__pl.push(['threw', String(err)]);
        }
      };
    }
  });

  await page.goto('/');
  // Verify which bundle the page actually loaded.
  const bundles = await page.evaluate(() =>
    [...document.scripts].map((s) => s.src.split('/').pop()),
  );
  console.log('loaded bundles:', JSON.stringify(bundles));
  await page.waitForFunction(() => !!(window.__IW && window.__IW.G && window.__IW.G.player), null, { timeout: 60_000 });
  await page.locator('#iw-start').click();
  await expect.poll(() => page.evaluate(() => window.__IW.G.started)).toBe(true);

  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    const st = await page.evaluate(() => ({
      pl: window.__pl,
      locked: window.__IW.Input.locked,
      broken: window.__IW.Input.lockBroken,
      paused: window.__IW.G.paused,
    }));
    console.log(`t+${i + 1}s:`, JSON.stringify(st));
    if (st.broken || st.locked) break;
  }
  console.log('offenses:', JSON.stringify(wc.offenses()));
});
