import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'data/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    files: ['vite.config.js', 'vitest.config.js', 'playwright.config.js', 'eslint.config.js', 'server/**/*.js', 'test/**/*.js', 'e2e/**/*.js'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Unused bindings are fine when they exist to drop fields with rest destructuring.
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }] },
  },
];
