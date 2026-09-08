import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end, against the real stack.
 *
 * Everything else in this repository tests one side of a boundary: the API
 * suites drive Express against a real PostgreSQL, and the component suites
 * drive React against a stubbed `fetch`. Both are worth having, and neither
 * would notice if the two sides disagreed — a renamed field, a cookie the
 * browser silently refuses, a CORS origin that does not match. That gap is what
 * this covers, and it is the only place a real browser is involved.
 *
 * The servers are started by Playwright itself rather than assumed to be
 * running, so `npm run e2e` works from a clean checkout with only the database
 * up.
 */

const API_PORT = 4100;
const WEB_PORT = 5175;

const API_URL = `http://localhost:${API_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Its own database, seeded and torn down by the global setup. Reusing the
 * development one would mean the suite's fixtures depended on whatever a
 * developer happened to have in it.
 */
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://pulsara:pulsara_local_dev@localhost:5433/pulsara_e2e';

export const e2eConfig = {
  API_PORT,
  WEB_PORT,
  API_URL,
  WEB_URL,
  DATABASE_URL,
  /** Created by the global setup; the sign-in test uses them. */
  ADMIN_EMAIL: 'e2e-admin@pulsara.test',
  ADMIN_PASSWORD: 'an-end-to-end-password-1',
};

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',

  // A browser test that has to be run three times to believe is not a test.
  // Failures are investigated rather than retried away.
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  timeout: 60_000,
  expect: { timeout: 15_000 },

  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: WEB_URL,
    // Kept only for a failure: a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      command: 'npm --prefix ../backend run dev',
      url: `${API_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        DATABASE_URL,
        CORS_ORIGINS: WEB_URL,
        JWT_ACCESS_SECRET: 'e2e_access_secret_0123456789abcdefghijkl',
        JWT_REFRESH_SECRET: 'e2e_refresh_secret_0123456789abcdefghijkl',
        /**
         * Host metrics are collected quickly, because the flow this suite
         * exists to prove ends with a live reading arriving over the socket.
         * Probing and the GitHub sync are off: neither is what is under test,
         * and both would reach the network.
         */
        METRICS_COLLECTION_ENABLED: 'true',
        METRICS_SAMPLE_INTERVAL_MS: '1000',
        METRICS_PERSIST_INTERVAL_MS: '5000',
        PROBES_ENABLED: 'false',
        GITHUB_SYNC_ENABLED: 'false',
        HOST_ALERTS_ENABLED: 'false',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command: `npm --prefix ../frontend run dev -- --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { VITE_API_URL: API_URL },
    },
  ],
});
