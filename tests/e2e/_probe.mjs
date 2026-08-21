import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded' });

for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000);
  try {
    const s = await Promise.race([
      page.evaluate(() => ({
        iw: !!window.__IW,
        started: window.__IW ? window.__IW.G.started : null,
        elapsed: window.__IW ? Number(window.__IW.G.elapsed.toFixed(2)) : null,
      })),
      new Promise((r) => setTimeout(() => r('EVAL-HUNG'), 2000)),
    ]);
    console.log(`t=${i + 1}s`, JSON.stringify(s));
  } catch (e) {
    console.log(`t=${i + 1}s eval threw:`, e.message.split('\n')[0]);
  }
}
console.log('--- console log ---');
for (const l of logs) console.log(l);
await browser.close();
