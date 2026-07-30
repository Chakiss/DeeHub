import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // e2e/ belongs to Playwright, which has its own runner and lifecycle.
    // Without this, vitest loads the specs and Playwright rejects them.
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
