import { defineConfig } from 'vite';

// three.js rarely changes and dwarfs the app code (~600kB of the ~680kB
// bundle) - splitting it into its own chunk lets browsers cache it across
// deploys where only src/** changed, and keeps the app chunk warning-free.
export default defineConfig({
  build: {
    // Keep the vendor cache stable and split the largest gameplay domains so
    // menu/title loads do not force every machine, VFX, and world system into
    // one application chunk. The boundaries mirror src/ ownership and are
    // intentionally coarse enough to avoid a request per file.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/three/') && !id.includes('/examples/jsm/')) return 'three';
          if (id.includes('/src/machines/')) return 'machines';
          if (id.includes('/src/world/') || id.includes('/src/systems/')) return 'world-systems';
          if (id.includes('/src/combat/')) return 'combat';
          if (id.includes('/src/ui/')) return 'ui';
          if (id.includes('/src/player/')) return 'player';
          return undefined;
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
