/**
 * Runs once per `playwright test` run, after Playwright has started (or reused) the web
 * servers of `playwright.config.ts` and before the first test.
 *
 * 1. Deletes the e2e database (`data/e2e.db` and its `-wal`/`-shm`/`-journal` files) so
 *    every run starts without tracked decks. This is safe because the app opens its
 *    database lazily, on the first request that needs it, and Playwright waits for the
 *    app by probing its TCP port rather than requesting a page, so nothing has opened
 *    the database yet. A dev server on port 3100 that was started outside Playwright and
 *    reused may already hold the old database open: restart it for a clean run.
 * 2. Resets the mock Moxfield to its seeded decks (a reused mock may have been edited).
 * 3. Warms up the app: the dev server compiles a route on its first request, which can
 *    take longer than a test's timeout.
 */
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { FullConfig } from '@playwright/test';

import { APP_URL, E2E_DATABASE_PATH } from './constants';
import { mockMoxfield } from './mock';

const WARM_UP_TIMEOUT_MS = 120_000;

function deleteDatabase(projectRoot: string): void {
  const path = resolve(projectRoot, E2E_DATABASE_PATH);
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

/** Requests the home page until the app answers at all; any HTTP status counts as up. */
async function warmUp(url: string): Promise<void> {
  const deadline = Date.now() + WARM_UP_TIMEOUT_MS;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      await response.body?.cancel();
      if (response.status >= 500) {
        console.warn(
          `[e2e] ${url} answered ${response.status} during warm-up; tests will report the details.`,
        );
      }
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`[e2e] ${url} did not answer within ${WARM_UP_TIMEOUT_MS} ms`, { cause: error });
      }
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  deleteDatabase(config.configFile ? dirname(config.configFile) : process.cwd());
  await mockMoxfield.reset();
  await warmUp(APP_URL);
}
