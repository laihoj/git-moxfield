/**
 * A real browser for the Vitest files that run code in one (`tests/unit/*.browser.test.ts`):
 * Playwright's Chromium, which `pnpm test:e2e:install` installs.
 */
import { existsSync } from 'node:fs';

import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll } from 'vitest';

/**
 * Launches Chromium once for the tests of the file and closes it afterwards; call it in
 * the file's top-level or `describe` scope. Returns the function that gives the running
 * browser to the tests.
 */
export function setUpChromium(timeoutMs = 60_000): () => Browser {
  let browser: Browser | undefined;

  beforeAll(async () => {
    if (!existsSync(chromium.executablePath())) {
      throw new Error("Playwright's Chromium is not installed: run `pnpm test:e2e:install`.");
    }
    browser = await chromium.launch();
  }, timeoutMs);

  afterAll(async () => {
    await browser?.close();
  });

  return () => {
    if (browser === undefined) throw new Error('The browser is not running yet');
    return browser;
  };
}
