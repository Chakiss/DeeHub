import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;
const API_URL = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

/**
 * Dashboard end-to-end tests.
 *
 * Requires a running API and database — the same contract as the backend
 * integration suites. These tests exist to cover what unit tests cannot: that
 * the login flow, the session cookies, the grid rendering and the bulk-edit
 * round trip actually work together in a browser.
 */
export default defineConfig({
  testDir: './e2e',
  // A dashboard test that hangs should fail, not stall the pipeline.
  timeout: 30_000,
  expect: { timeout: 10_000 },

  // Serial: the specs share one seeded property and some of them mutate its
  // inventory. Parallel runs would race on the same rows.
  fullyParallel: false,
  workers: 1,

  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // Production build, not `next dev`: the dev server has different
    // hydration and caching behaviour, so testing it would test something we
    // never ship.
    // `next start` directly, not the package script: that script pins port 3000
    // and an extra flag lands as a positional argument.
    command: `pnpm build && npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DEEHUB_API_URL: API_URL,
      NODE_ENV: 'production',
      PORT: String(PORT),
    },
  },
});
