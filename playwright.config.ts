/**
 * End-to-end tests: real Chromium against the app (Next.js dev server on port 3100 with
 * its own database) and the mock Moxfield (port 4010), which plays both the Moxfield
 * website and its API, so the server-fetch and bookmarklet-capture paths both run for
 * real.
 *
 *   pnpm test:e2e            (first time: pnpm test:e2e:install)
 *
 * Tests share one database and one mock, so they run serially; each test resets the mock
 * and the app's in-process state and signs in users of its own (`tests/e2e/support/`).
 * The app builds into its own directory (`.next-e2e`), so it runs next to `pnpm dev`.
 * Ports, database and build directory can be overridden (see
 * `tests/e2e/support/constants.ts`).
 *
 * The database starts empty, so the installation is unclaimed: the `first-run` project
 * claims it through the UI (`tests/e2e/claim.spec.ts`) before any other test creates a
 * user, which would make claiming impossible. The `desktop` and `mobile` projects depend
 * on it, so it runs first, once, whichever projects or files are selected.
 */
import { defineConfig, devices } from '@playwright/test';

import {
  APP_PORT,
  APP_URL,
  E2E_DATABASE_PATH,
  E2E_NEXT_DIST_DIR,
  MOCK_MOXFIELD_PORT,
  MOCK_MOXFIELD_URL,
} from './tests/e2e/support/constants';

const isCI = Boolean(process.env.CI);
const SERVER_START_TIMEOUT_MS = 120_000;

/** The claim journey: possible only while no user exists, so it runs before everything else. */
const FIRST_RUN_SPEC = /\/claim\.spec\.ts$/;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/e2e/support/global-setup.ts',
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'first-run',
      testMatch: FIRST_RUN_SPEC,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'desktop',
      testIgnore: FIRST_RUN_SPEC,
      dependencies: ['first-run'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile',
      testIgnore: FIRST_RUN_SPEC,
      dependencies: ['first-run'],
      use: { ...devices['Pixel 7'], isMobile: true, hasTouch: true },
    },
  ],
  webServer: [
    {
      name: 'mock-moxfield',
      command: 'pnpm mock-moxfield',
      url: `${MOCK_MOXFIELD_URL}/__control/state`,
      env: { MOCK_MOXFIELD_PORT: String(MOCK_MOXFIELD_PORT) },
      reuseExistingServer: !isCI,
      timeout: SERVER_START_TIMEOUT_MS,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    },
    {
      name: 'app',
      command: `pnpm next dev --port ${APP_PORT}`,
      // Probe the port only: an HTTP probe would render a page and open the database
      // before the global setup has deleted it (see tests/e2e/support/global-setup.ts).
      port: APP_PORT,
      env: {
        DATABASE_PATH: E2E_DATABASE_PATH,
        // Never a remote database named in a developer's .env.local: the suite deletes and
        // rebuilds its database (see the note on .env.local below).
        TURSO_DATABASE_URL: '',
        TURSO_AUTH_TOKEN: '',
        NEXT_DIST_DIR: E2E_NEXT_DIST_DIR,
        MOXFIELD_API_BASE_URL: MOCK_MOXFIELD_URL,
        MOXFIELD_SITE_ORIGIN: MOCK_MOXFIELD_URL,
        CAPTURE_ALLOWED_ORIGINS: MOCK_MOXFIELD_URL,
        PUBLIC_APP_URL: APP_URL,
        REFRESH_COOLDOWN_SECONDS: '0',
        MOXFIELD_MIN_REQUEST_INTERVAL_MS: '0',
        AUTO_REFRESH_AFTER_SECONDS: '3600',
        LOG_LEVEL: 'warn',
        GIT_MOXFIELD_E2E: 'true',
        // Neutralize a developer's .env.local: Next.js never overrides variables that are
        // already set, and git-moxfield treats empty values as unset.
        MOXFIELD_USER_AGENT: '',
        MOXFIELD_SERVER_FETCH: 'auto',
      },
      reuseExistingServer: !isCI,
      timeout: SERVER_START_TIMEOUT_MS,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
    },
  ],
});
