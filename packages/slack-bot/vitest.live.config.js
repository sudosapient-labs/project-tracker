/* Live scenarios against the real model (test/live/*.live.js); see the file's header. Kept out of
   the root `pnpm test`, which only picks up *.test.js. */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live/**/*.live.js'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
