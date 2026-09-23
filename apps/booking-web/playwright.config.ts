import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;
const API_URL = process.env.DEEHUB_API_URL ?? 'http://127.0.0.1:3001/api/v1';

/**
 * Guest booking site, end to end: a real API, a real database, the
 * standalone build Cloud Run runs, and a browser walking from the hotel page
 * to a held booking. Mobile viewport, because that is where guests come from.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
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
  projects: [{ name: 'mobile-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: `pnpm build && pnpm start:standalone`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      DEEHUB_API_URL: API_URL,
      NODE_ENV: 'production',
      PORT: String(PORT),
    },
  },
});
