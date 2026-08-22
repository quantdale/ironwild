import { defineConfig } from "@playwright/test";

// ANGLE/D3D11 launch args only when explicitly requested; the plain default
// path stays untouched for environments without a usable GPU.
const gpuLaunchOptions =
  process.env.IW_E2E_GPU === "1"
    ? {
        launchOptions: {
          args: [
            "--use-angle=d3d11",
            "--use-gl=angle",
            "--enable-unsafe-swiftshader",
          ],
        },
      }
    : null;

// E2E smoke suite: boots the PRODUCTION build (npm run test:e2e builds first)
// and drives the real game in a real browser. WebGL required.
//
// Launch modes:
// - default: headless Chromium. On machines without GPU-accelerated headless
//   GL this lands on SwiftShader (software) - correct but ~1fps; specs carry
//   software-GL wall-clock budgets for that case.
// - IW_E2E_GPU=1: headless Chromium forced through ANGLE/D3D11, which on
//   Windows machines with a real GPU (e.g. RTX 4050) yields HARDWARE WebGL in
//   an otherwise identical headless session. Preferred for certification and
//   performance measurement.
// - IW_E2E_HEADED=1: headed window (also hardware GL); used to sanity-check
//   that headless-GPU results match headed behavior.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // One worker: every spec drives a full WebGL game instance; parallel
  // browser launches starve each other's main thread under SwiftShader.
  workers: 1,
  // HTML report (written to playwright-report/, never auto-opened) gives CI a
  // failure artifact; list keeps local runs readable.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    headless: process.env.IW_E2E_HEADED !== "1",
    viewport: { width: 1280, height: 720 },
    trace: "on-first-retry",
    ...gpuLaunchOptions,
  },
  webServer: {
    command: "npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
