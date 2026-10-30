import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // scrypt hashing makes auth tests a little slower than the default budget.
    testTimeout: 15000,
  },
});
