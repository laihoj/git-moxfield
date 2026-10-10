/**
 * The "Send to git-moxfield" bookmarklets in e2e tests.
 *
 * A real bookmarklet is a `javascript:` URL the user takes from git-moxfield's setup
 * page and clicks while a Moxfield deck page is open. Every bookmarklet carries its
 * user's personal key (ADR 0006): running it captures the deck into that user's
 * workspace and signs the browser in. Tests get bookmarklets either from the test-only
 * sign-in (`signIn(context, { bookmarkletLabel })` in `./accounts.ts`) or, where creating
 * one is part of the journey, from the setup page ({@link createBookmarkletOnSetupPage}).
 * {@link runBookmarklet} evaluates the decoded source in the deck page, which runs exactly
 * the code a click would (Playwright's Chromium does not block the popup it opens).
 */
import type { Page } from '@playwright/test';

import { CAPTURE_FORM_PATH } from '@/integrations/moxfield/capture-protocol';

import { APP_URL } from './constants';
import { expect } from './fixtures';

export type BookmarkletMode = 'popup' | 'same-tab';

/** The two bookmarklets of one key, by mode. */
export type Bookmarklets = Record<BookmarkletMode, string>;

/** The JavaScript source of a `javascript:` bookmarklet URL. */
export function bookmarkletSource(bookmarklet: string): string {
  const prefix = 'javascript:';
  if (!bookmarklet.startsWith(prefix)) {
    throw new Error(`Not a bookmarklet: ${bookmarklet.slice(0, 40)}…`);
  }
  return decodeURIComponent(bookmarklet.slice(prefix.length));
}

/** The personal key (`gmk_…`) a bookmarklet carries. */
export function bookmarkletKey(bookmarklet: string): string {
  const match = /"key":"(gmk_[A-Za-z0-9_-]{43})"/.exec(bookmarkletSource(bookmarklet));
  if (match?.[1] === undefined) throw new Error('No key in the bookmarklet');
  return match[1];
}

/** Which bookmarklet a `javascript:` URL is: only the same-tab one posts to the form endpoint. */
export function bookmarkletMode(bookmarklet: string): BookmarkletMode {
  return bookmarkletSource(bookmarklet).includes(JSON.stringify(CAPTURE_FORM_PATH)) ? 'same-tab' : 'popup';
}

/** Distinct bookmarklets found among `hrefs`, by mode; throws when a mode has several. */
function classify(hrefs: readonly string[]): Partial<Bookmarklets> {
  const found: Partial<Bookmarklets> = {};
  for (const href of new Set(hrefs)) {
    const mode = bookmarkletMode(href);
    if (found[mode] !== undefined) throw new Error(`The page offers two different ${mode} bookmarklets`);
    found[mode] = href;
  }
  return found;
}

/** The bookmarklet links on `page` (`a[href^="javascript:"]`). */
function bookmarkletLinks(page: Page) {
  return page.locator('a[href^="javascript:"]');
}

/**
 * Creates a bookmarklet on the setup page (`page` must be signed in), the way a user
 * does: names it, creates it, reads both bookmarklets from their links (which get their
 * `href`s after mount), then confirms "I’ve installed it", which hides them for good.
 * Leaves `page` on the setup page.
 */
export async function createBookmarkletOnSetupPage(page: Page, label: string): Promise<Bookmarklets> {
  if (new URL(page.url()).pathname !== '/setup') await page.goto('/setup');
  await page.getByLabel('Name your bookmarklet').fill(label);
  await page.getByRole('button', { name: 'Create bookmarklet' }).click();

  const created = page.getByRole('region', { name: `“${label}” is ready. Install it now.` });
  await expect(created).toBeVisible();
  await expect(created.getByText('This is the only time it’s shown')).toBeVisible();

  let found: Partial<Bookmarklets> = {};
  await expect
    .poll(
      async () => {
        found = classify(
          await bookmarkletLinks(page).evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('href') ?? ''),
          ),
        );
        return Object.keys(found).sort();
      },
      { message: 'the setup page shows both new bookmarklets' },
    )
    .toEqual(['popup', 'same-tab']);
  const { popup, 'same-tab': sameTab } = found;
  if (popup === undefined || sameTab === undefined) throw new Error('Bookmarklets missing on the setup page');

  await created.getByRole('button', { name: 'I’ve installed it' }).click();
  await expect(page.getByRole('status').filter({ hasText: `“${label}” is installed` })).toBeVisible();
  // Shown once: the key is gone from the page.
  await expect(bookmarkletLinks(page)).toHaveCount(0);
  return { popup, 'same-tab': sameTab };
}

/**
 * Runs `bookmarklet` on `page`, which must show a deck on the mock Moxfield site. The mode
 * is the bookmarklet's own:
 *
 * - popup: resolves with the git-moxfield capture page the bookmarklet opens (loaded up to
 *   `domcontentloaded`); the deck is handed over by `postMessage` after that.
 * - same-tab: resolves with `page` once the bookmarklet's form post has navigated it to
 *   git-moxfield: the deck page after the sign-in hand-off, the page that asks before
 *   signing in a browser that is signed out or signed in as someone else
 *   (`confirmBookmarkletSignIn` in `./accounts.ts`), or a rejection page.
 */
export async function runBookmarklet(page: Page, bookmarklet: string): Promise<Page> {
  const source = bookmarkletSource(bookmarklet);
  if (bookmarkletMode(bookmarklet) === 'popup') {
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(source)]);
    await popup.waitForLoadState('domcontentloaded');
    return popup;
  }
  const appOrigin = new URL(APP_URL).origin;
  await Promise.all([page.waitForURL((url) => url.origin === appOrigin), page.evaluate(source)]);
  return page;
}
