// IRONWILD performance sanity baseline + short soak (verification campaign).
//
// Manual tool - NOT part of npm test / playwright suites. Requires the
// production preview server on :4173 (`npm run preview -- --port 4173`).
//
// Launch mode matches the E2E suite: default = plain headless Chromium
// (SwiftShader software GL on most machines - correctness only, NEVER compare
// those numbers to a 60Hz hardware budget); IW_E2E_GPU=1 = ANGLE/D3D11
// hardware WebGL where available. The measured renderer is printed in the
// header of every run so numbers can always be attributed.
//
// Drives real gameplay in headless Chromium and samples window.__IW.perf's
// own telemetry (the same data the F3 HUD shows):
//   scenario A: spawn meadow (baseline)
//   scenario B: storm weather
//   scenario C: combat proximity (teleport beside a live machine)
//   scenario D: focus-scan time dilation (timeScale 0.35)
//   scenario E: dense vegetation (deep NE forest, ~1.6x tree density)
//   soak:       mixed play with periodic heap/resource trend samples
//
// Usage: node scripts/perf-capture.mjs [--soak] [--soak-mins=N]
import { chromium } from "@playwright/test";

const BASE = process.env.IW_PERF_BASE || "http://localhost:4173";
const SOAK = process.argv.includes("--soak");
// Accept both "--soak-mins 20" and "--soak-mins=20".
const eqMins = process.argv.find((a) => a.startsWith("--soak-mins="));
const soakMinsIdx = process.argv.indexOf("--soak-mins");
const SOAK_MINUTES = eqMins
  ? Number(eqMins.split("=")[1]) || 1.5
  : soakMinsIdx >= 0
    ? Number(process.argv[soakMinsIdx + 1]) || 1.5
    : 1.5;

// Same launch contract as playwright.config.js IW_E2E_GPU=1.
const LAUNCH_ARGS =
  process.env.IW_E2E_GPU === "1"
    ? {
        args: [
          "--use-angle=d3d11",
          "--use-gl=angle",
          "--enable-unsafe-swiftshader",
        ],
      }
    : {};

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
  await page.evaluate(() => {
    window.__IW.G.paused = true;
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    window.__IW.G.paused = false;
  });
  await page.waitForTimeout(250); // averaging window restarts fresh
}

async function capture(page, label, settleMs) {
  await drain(page);
  await page.waitForTimeout(settleMs);
  const s = await sample(page);
  console.log(label.padEnd(24), JSON.stringify(s));
  return s;
}

const browser = await chromium.launch(LAUNCH_ARGS);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => !!(window.__IW && window.__IW.G && window.__IW.G.player),
);

// Attribute every number to a renderer: probe WebGL and classify the path.
const gpu = await page.evaluate(() => {
  const cv = document.createElement("canvas");
  const gl = cv.getContext("webgl2") || cv.getContext("webgl");
  if (!gl) return { renderer: "no-webgl", vendor: "", swiftShader: true };
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg
    ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const vendor = dbg
    ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
    : gl.getParameter(gl.VENDOR);
  return {
    renderer,
    vendor,
    swiftShader: /swiftshader|software|llvmpipe/i.test(String(renderer)),
  };
});
console.log(
  `[renderer] ${gpu.renderer} | vendor=${gpu.vendor} | ` +
    `${gpu.swiftShader ? "SOFTWARE-GL (SwiftShader): correctness/lifecycle numbers only" : "HARDWARE GL"}`,
);

await page.locator("#iw-start").click();
await page.waitForTimeout(1000);

console.log(
  "scenario".padEnd(24),
  "p50/p95/p99 fps | calls tris geo tex prog | heapMB machines arrows cells dynres",
);

await capture(page, "A: meadow", 4000);

// B: storm - drive the weather state directly (same fields updateWeather writes).
await page.evaluate(() => {
  const w = window.__IW.G.weather;
  w.type = "storm";
  w.intensity = 1;
  w.wind = 1;
});
await capture(page, "B: storm", 5000);
await page.evaluate(() => {
  const w = window.__IW.G.weather;
  w.type = "clear";
  w.intensity = 0;
  w.wind = 0.3;
});

// C: combat proximity - teleport next to an alert machine; arrows fly via AI.
const tp = await page.evaluate(() => {
  const G = window.__IW.G;
  const m = G.machines.find(
    (x) => x.alive && x.type !== "monarch" && x.type !== "vantage",
  );
  if (!m) return false;
  G.player.pos.set(
    m.group.position.x + 6,
    m.group.position.y + 0.1,
    m.group.position.z,
  );
  m.aggro = true;
  return true;
});
console.log("combat teleport:", tp);
await capture(page, "C: combat proximity", 6000);

// D: focus-style time dilation (what focus scan does to the world clock).
await page.evaluate(() => {
  window.__IW.G.timeScale = 0.35;
});
await capture(page, "D: timeScale 0.35", 3000);
await page.evaluate(() => {
  window.__IW.G.timeScale = 1;
});

// E: dense vegetation - deep NE forest (terrain.forestFactor saturates around
// x>60, z<-60) where tree placement runs ~1.6x meadow density.
await page.evaluate(() => {
  const G = window.__IW.G;
  G.player.pos.set(75, G.player.pos.y, -75);
});
await capture(page, "E: dense forest", 6000);

if (SOAK) {
  const totalMs = Math.round(SOAK_MINUTES * 60_000);
  const SAMPLE_MS = 15_000;
  const samples = Math.max(2, Math.floor(totalMs / SAMPLE_MS));
  console.log(
    `\nsoak start (${SOAK_MINUTES}min, sample every ${SAMPLE_MS / 1000}s)...`,
  );
  const trend = [];
  for (let i = 0; i < samples; i++) {
    await page.waitForTimeout(SAMPLE_MS);
    const s = await sample(page);
    trend.push(s);
    console.log(
      `t=${Math.round(((i + 1) * SAMPLE_MS) / 1000)}s`.padEnd(24),
      JSON.stringify(s),
    );
  }
  const first = trend[0];
  const last = trend[trend.length - 1];
  const growth = {
    heapMB: last.heapMB - first.heapMB,
    geometries: last.geo - first.geo,
    textures: last.tex - first.tex,
    programs: last.prog - first.prog,
    machines: last.machines - first.machines,
    cells: last.cells && first.cells ? `${last.cells} vs ${first.cells}` : null,
  };
  console.log("\nsoak delta (last-first):", JSON.stringify(growth));
  // Heuristic alarm, not certification: >40% heap growth or monotonically
  // growing GPU resource counts deserve investigation.
  if (first.heapMB && growth.heapMB / first.heapMB > 0.4)
    console.log("WARN: heap growth >40%");
  if (growth.geometries > 20 || growth.textures > 20)
    console.log("WARN: GPU resource count grew");
}

await browser.close();
console.log("done");
