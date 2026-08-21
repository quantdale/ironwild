import { defineConfig } from '@playwright/test';

// E2E smoke suite: boots the PRODUCTION build (npm run test:e2e builds first)
// and drives the real game in a real browser. WebGL required - the default
// headed-chromium channel is used because headless-shell can lack GPU support
// on some machines; override locally with IW_E2E_HEADED=1 if needed.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // One worker: every spec drives a full WebGL game instance; parallel
  // browser launches starve each other's main thread under SwiftShader.
  workers: 1,
  // HTML report (written to playwright-report/, never auto-opened) gives CI a
  // failure artifact; list keeps local runs readable.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:4173',
    headless: process.env.IW_E2E_HEADED !== '1',
    viewport: { width: 1280, height: 720 },
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
