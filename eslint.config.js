import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'public/assets/vendor/**', '.build-check*/**', 'screenshots/**', '.playwright-mcp/**'],
  },
  {
    // Config files run in node, not the browser.
    files: ['*.config.js', '**/*.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Node tooling (perf capture, chunked e2e driver) runs in node.
    files: ['scripts/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // Existing code intentionally uses `let` scratch vectors and `==`-free
      // style; keep the gate focused on real hazards rather than style.
      // caughtErrors off: storage/audio paths deliberately swallow failures.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
];
