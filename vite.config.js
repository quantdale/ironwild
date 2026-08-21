import { defineConfig } from 'vite';

// three.js rarely changes and dwarfs the app code (~600kB of the ~680kB
// bundle) - splitting it into its own chunk lets browsers cache it across
// deploys where only src/** changed, and keeps the app chunk warning-free.
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
  // Vitest (npm test): deterministic logic tests run in plain node; the
  // setup file stubs just enough browser surface for modules that touch
  // window/localStorage at import time. WebGL-dependent code is covered by
  // the Playwright suite instead (npm run test:e2e).
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    setupFiles: ['tests/setup.dom.js'],
  },
});
