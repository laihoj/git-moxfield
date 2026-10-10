/**
 * Addresses of the end-to-end environment started by `playwright.config.ts`: the app
 * (a Next.js dev server with its own database) and the mock Moxfield, which plays both
 * the Moxfield website and its API.
 *
 * The defaults can be overridden with environment variables, so a second suite can run
 * next to a developer's own mock or e2e servers without sharing (and resetting) them:
 *
 *   E2E_APP_PORT=3200 E2E_MOCK_MOXFIELD_PORT=4210 E2E_NEXT_DIST_DIR=.next-e2e-2 \
 *   E2E_DATABASE_PATH=data/e2e-2.db pnpm test:e2e
 */

function envPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be a TCP port number, got ${JSON.stringify(value)}`);
  }
  return port;
}

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export const APP_PORT = envPort('E2E_APP_PORT', 3100);
export const APP_URL = `http://localhost:${APP_PORT}`;

export const MOCK_MOXFIELD_PORT = envPort('E2E_MOCK_MOXFIELD_PORT', 4010);
export const MOCK_MOXFIELD_URL = `http://localhost:${MOCK_MOXFIELD_PORT}`;

/** Database of the e2e app, relative to the project root. Deleted before every run. */
export const E2E_DATABASE_PATH = envString('E2E_DATABASE_PATH', 'data/e2e.db');

/** Next.js build directory of the e2e app (one `next dev` per directory). */
export const E2E_NEXT_DIST_DIR = envString('E2E_NEXT_DIST_DIR', '.next-e2e');
