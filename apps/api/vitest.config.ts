import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one database and deliberately provoke lock
    // contention. Running files in parallel would make failures ambiguous.
    fileParallelism: false,
  },
});
