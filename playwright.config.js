import { defineConfig } from '@playwright/test';

// E2E smoke suite: boots the PRODUCTION build (npm run test:e2e builds first)
// and drives the real game in a real browser. WebGL required - the default
// headed-chromium channel is used because headless-shell can lack GPU support
// on some machines; override locally with IW_E2E_HEADED=1 if needed.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    headless: process.env.IW_E2E_HEADED !== '1',
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
