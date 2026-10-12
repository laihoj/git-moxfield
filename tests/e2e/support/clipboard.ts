/**
 * The browser's clipboard in e2e tests: the Copy buttons write to it, the tests read it
 * back. It is shared by the whole browser, so a test that reads what a button copied
 * first writes a sentinel (`page.evaluate(() => navigator.clipboard.writeText(…))`).
 */
import type { BrowserContext, Page } from '@playwright/test';

import { APP_URL } from './constants';

/** Lets the pages of `context` read and write the clipboard (Chromium asks otherwise). */
export async function grantClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
}

/** The text on the clipboard of the browser that `page` belongs to. */
export async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}
