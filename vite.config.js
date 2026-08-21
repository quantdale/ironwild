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
});
