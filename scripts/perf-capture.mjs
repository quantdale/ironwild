// IRONWILD performance sanity baseline + short soak (verification campaign).
//
// Manual tool - NOT part of npm test / playwright suites. Requires the
// production preview server on :4173 (`npm run preview -- --port 4173`).
//
// Drives real gameplay in headless Chromium and samples window.__IW.perf's
// own telemetry (the same data the F3 HUD shows):
//   scenario A: spawn meadow (baseline)
//   scenario B: storm weather
//   scenario C: combat proximity (teleport beside a live machine)
//   scenario D: focus-scan time dilation (timeScale 0.35)
//   soak:       90s mixed play with periodic heap/resource trend samples
//
// Usage: node scripts/perf-capture.mjs [--soak]
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:4173';
const SOAK = process.argv.includes('--soak');

async function sample(page) {
  return page.evaluate(() => {
    const r = window.__IW.perf.getReport();
    return {
      p50: +r.frameMs.p50.toFixed(1),
      p95: +r.frameMs.p95.toFixed(1),
      p99: +r.frameMs.p99.toFixed(1),
      fps: r.fps,
      calls: r.gpu.calls,
      tris: r.gpu.triangles,
      geo: r.gpu.geometries,
      tex: r.gpu.textures,
      prog: r.gpu.programs,
      heapMB: r.memory.heapMB,
      machines: r.scene.machinesAlive,
      arrows: r.scene.arrows,
      cells: r.cells ? `${r.cells.active}/${r.cells.registered}` : null,
      dynres: r.dynResScale,
    };
  });
}

/** Reset the perf ring between scenarios by pausing ~1.5s (drops averaging). */
async function drain(page) {
  await page.evaluate(() => { window.__IW.G.paused = true; });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__IW.G.paused = false; });
  await page.waitForTimeout(250); // averaging window restarts fresh
}

async function capture(page, label, settleMs) {
  await drain(page);
  await page.waitForTimeout(settleMs);
  const s = await sample(page);
  console.log(label.padEnd(24), JSON.stringify(s));
  return s;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.__IW && window.__IW.G && window.__IW.G.player));
await page.locator('#iw-start').click();
await page.waitForTimeout(1000);

console.log('scenario'.padEnd(24), 'p50/p95/p99 fps | calls tris geo tex prog | heapMB machines arrows cells dynres');

await capture(page, 'A: meadow', 4000);

// B: storm - drive the weather state directly (same fields updateWeather writes).
await page.evaluate(() => {
  const w = window.__IW.G.weather;
  w.type = 'storm'; w.intensity = 1; w.wind = 1;
});
await capture(page, 'B: storm', 5000);
await page.evaluate(() => {
  const w = window.__IW.G.weather;
  w.type = 'clear'; w.intensity = 0; w.wind = 0.3;
});

// C: combat proximity - teleport next to an alert machine; arrows fly via AI.
const tp = await page.evaluate(() => {
  const G = window.__IW.G;
  const m = G.machines.find((x) => x.alive && x.type !== 'monarch' && x.type !== 'vantage');
  if (!m) return false;
  G.player.pos.set(m.group.position.x + 6, m.group.position.y + 0.1, m.group.position.z);
  m.aggro = true;
  return true;
});
console.log('combat teleport:', tp);
await capture(page, 'C: combat proximity', 6000);

// D: focus-style time dilation (what focus scan does to the world clock).
await page.evaluate(() => { window.__IW.G.timeScale = 0.35; });
await capture(page, 'D: timeScale 0.35', 3000);
await page.evaluate(() => { window.__IW.G.timeScale = 1; });

if (SOAK) {
  console.log('\nsoak start (90s, sample every 15s)...');
  const trend = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(15000);
    const s = await sample(page);
    trend.push(s);
    console.log(`t=${(i + 1) * 15}s`.padEnd(24), JSON.stringify(s));
  }
  const first = trend[0];
  const last = trend[trend.length - 1];
  const growth = {
    heapMB: last.heapMB - first.heapMB,
    geometries: last.geo - first.geo,
    textures: last.tex - first.tex,
    programs: last.prog - last.prog,
    machines: last.machines - first.machines,
  };
  console.log('\nsoak delta (last-first):', JSON.stringify(growth));
  // Heuristic alarm, not certification: >40% heap growth or monotonically
  // growing GPU resource counts deserve investigation.
  if (first.heapMB && growth.heapMB / first.heapMB > 0.4) console.log('WARN: heap growth >40%');
  if (growth.geometries > 20 || growth.textures > 20) console.log('WARN: GPU resource count grew');
}

await browser.close();
console.log('done');
