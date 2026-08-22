// IRONWILD boot-delivery capture (companion to perf-capture.mjs).
//
// Manual tool. Requires the production preview server (IW_PERF_BASE,
// default http://localhost:4173). Measures the delivery path in a real
// headless Chromium:
//   t_title   navigation start -> title screen interactive
//   t_started title click -> G.started (engine hand-off)
// plus which chunks were actually REQUESTED before/after start, so lazy
// chunk boundaries can be verified from evidence instead of hope.
//
// Usage: node scripts/boot-capture.mjs [--gpu]
import { chromium } from "@playwright/test";

const BASE = process.env.IW_PERF_BASE || "http://localhost:4173";
const GPU = process.argv.includes("--gpu");

const LAUNCH_ARGS = GPU
  ? {
      args: [
        "--use-angle=d3d11",
        "--use-gl=angle",
        "--enable-unsafe-swiftshader",
      ],
    }
  : {};

const browser = await chromium.launch(LAUNCH_ARGS);
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
});

const requested = new Set();
page.on("request", (req) => {
  const url = req.url();
  if (/\.js($|\?)/.test(url)) requested.add(url.split("/").pop());
});

const t0 = Date.now();
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.locator("#iw-start").waitFor({ state: "visible" });
const tTitle = Date.now() - t0;

const bootChunks = [...requested];

const t1 = Date.now();
await page.locator("#iw-start").click();
await page.waitForFunction(() => window.__IW && window.__IW.G.started, null, {
  timeout: 120_000,
});
const tStarted = Date.now() - t1;

const playChunks = [...requested].filter((c) => !bootChunks.includes(c));

console.log(JSON.stringify(
  {
    mode: GPU ? "hardware-gl" : "software-gl",
    tTitleMs: tTitle,
    tStartedMs: tStarted,
    bootChunks,
    lazyChunksOnStart: playChunks,
  },
  null,
  2,
));

await browser.close();
