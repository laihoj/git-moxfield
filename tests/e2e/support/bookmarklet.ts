/**
 * Runs the "Send to git-moxfield" bookmarklet in e2e tests.
 *
 * A real bookmarklet is a `javascript:` URL the user takes from git-moxfield's setup
 * page and clicks while a Moxfield deck page is open. Here it is read from the setup
 * page the same way (so it carries this installation's capture token), decoded, and its
 * source evaluated in the deck page, which runs exactly the code a click would
 * (Playwright's Chromium does not block the popup it opens).
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';

import { CAPTURE_FORM_PATH } from '@/integrations/moxfield/capture-protocol';

import { APP_URL } from './constants';

export type BookmarkletMode = 'popup' | 'same-tab';

export type Bookmarklets = Record<BookmarkletMode, string>;

/** The JavaScript source of a `javascript:` bookmarklet URL. */
export function bookmarkletSource(bookmarklet: string): string {
  const prefix = 'javascript:';
  if (!bookmarklet.startsWith(prefix)) {
    throw new Error(`Not a bookmarklet: ${bookmarklet.slice(0, 40)}…`);
  }
  return decodeURIComponent(bookmarklet.slice(prefix.length));
}

/** Which bookmarklet a `javascript:` URL is: only the same-tab one posts to the form endpoint. */
function bookmarkletMode(bookmarklet: string): BookmarkletMode {
  return bookmarkletSource(bookmarklet).includes(JSON.stringify(CAPTURE_FORM_PATH)) ? 'same-tab' : 'popup';
}

/** Distinct bookmarklets found among `hrefs`, by mode; throws when a mode has several. */
function classify(hrefs: readonly string[]): Partial<Bookmarklets> {
  const found: Partial<Bookmarklets> = {};
  for (const href of new Set(hrefs)) {
    const mode = bookmarkletMode(href);
    if (found[mode] !== undefined)
      throw new Error(`The setup page offers two different ${mode} bookmarklets`);
    found[mode] = href;
  }
  return found;
}

let cached: Bookmarklets | undefined;

/**
 * The bookmarklets exactly as the app's setup page hands them out (app at
 * {@link APP_URL}, Moxfield played by the mock), read from the bookmarklet links once
 * the page has set their `href`s. Opens the setup page in a new page of `context`.
 *
 * Cached per worker: the capture token is stable for the whole run (the e2e database is
 * only deleted before the run starts).
 */
export async function setupPageBookmarklets(context: BrowserContext): Promise<Bookmarklets> {
  if (cached !== undefined) return cached;
  const page = await context.newPage();
  try {
    await page.goto(`${APP_URL}/setup`);
    const links = page.locator('a[href^="javascript:"]');
    let found: Partial<Bookmarklets> = {};
    await expect
      .poll(
        async () => {
          found = classify(
            await links.evaluateAll((elements) => elements.map((e) => e.getAttribute('href') ?? '')),
          );
          return Object.keys(found).sort();
        },
        { message: 'the setup page shows both bookmarklets' },
      )
      .toEqual(['popup', 'same-tab']);
    const { popup, 'same-tab': sameTab } = found;
    if (popup === undefined || sameTab === undefined)
      throw new Error('Bookmarklets missing on the setup page');
    cached = { popup, 'same-tab': sameTab };
    return cached;
  } finally {
    await page.close();
  }
}

export interface RunBookmarkletOptions {
  /** Default `popup`. */
  mode?: BookmarkletMode;
  /**
   * The `javascript:` URL to run, e.g. a forged one. Default: the one the setup page
   * offers for `mode` ({@link setupPageBookmarklets}).
   */
  bookmarklet?: string;
}

/**
 * Runs the bookmarklet on `page`, which must show a deck on the mock Moxfield site.
 *
 * - `popup` mode resolves with the git-moxfield capture page the bookmarklet opens
 *   (loaded up to `domcontentloaded`); the deck is handed over by `postMessage` after that.
 * - `same-tab` mode resolves with `page` once the bookmarklet's form post has navigated
 *   it to git-moxfield.
 */
export async function runBookmarklet(page: Page, options: RunBookmarkletOptions = {}): Promise<Page> {
  const mode = options.mode ?? 'popup';
  const bookmarklet = options.bookmarklet ?? (await setupPageBookmarklets(page.context()))[mode];
  const source = bookmarkletSource(bookmarklet);
  const appOrigin = new URL(APP_URL).origin;

  if (mode === 'popup') {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(source)]);
    await popup.waitForLoadState('domcontentloaded');
    return popup;
  }
  await Promise.all([page.waitForURL((url) => url.origin === appOrigin), page.evaluate(source)]);
  return page;
}
