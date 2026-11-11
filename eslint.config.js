import js from '@eslint/js';
import globals from 'globals';

export default [
  // apps/android/app and out: the generated Android project and its build output, not our JavaScript.
  { ignores: ['dist/', 'data/', 'test-results/', 'playwright-report/', 'apps/android/app/', 'apps/android/out/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: [
      'vite.config.js',
      'vitest.config.js',
      'playwright.config.js',
      'eslint.config.js',
      'server/**/*.js',
      'scripts/**/*.js',
      'packages/**/*.js',
      'apps/**/*.js',
      'test/**/*.js',
      'e2e/**/*.js',
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  {
    // Unused bindings are fine when they exist to drop fields with rest destructuring.
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }] },
  },
];
