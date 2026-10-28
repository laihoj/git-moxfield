/**
 * Decks of their own for e2e journeys, and the UI steps journeys share.
 *
 * The e2e database is shared by every test of a run (and by both projects). Every test
 * works as users of its own, whose workspaces only ever hold their own decks; on top of
 * that, each journey puts a copy of the seeded Blue Farm deck on the mock Moxfield under a
 * public id of its own and tracks that copy, so no two tests ever touch the same deck.
 */
import { randomBytes } from 'node:crypto';

import type { Locator, Page, TestInfo } from '@playwright/test';

import { blueFarmDeck } from '../../mock-moxfield/scenarios';

import { APP_URL } from './constants';
import { expect } from './fixtures';
import { mockMoxfield, type MoxDeckSpec } from './mock';

/** Paths of the app's deck pages: `/decks/{deckId}` without anything after it. */
export const DECK_PAGE_PATH = /^\/decks\/[^/?#]+$/;

/** The URL of a deck page a capture has just landed on: `/decks/{deckId}?captured=1`. */
export const CAPTURED_DECK_URL = new RegExp(`^${APP_URL}/decks/[^/?#]+\\?captured=1$`);

/**
 * The deck's navigation: Status · History · Compare · Cards (owner) or Overview · … (viewer
 * of a share link), as top tabs or, on a phone, a bottom bar.
 */
export function deckNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Deck' });
}

/** A heading of the Status page ("Not committed yet", "Up to date with v1", "Uncommitted changes"). */
export function statusHeading(page: Page, label: string): Locator {
  return page.getByRole('heading', { level: 2, name: label });
}

/**
 * Puts a copy of the seeded Blue Farm deck (100 cards, 12 considered, 2 in the
 * sideboard, a primer) on the mock Moxfield under a new public id, named `name`.
 */
export async function createBlueFarmCopy(testInfo: TestInfo, name = 'Blue Farm'): Promise<MoxDeckSpec> {
  const project = testInfo.project.name.replace(/[^A-Za-z0-9]/g, '');
  const publicId = `E2e${project}${randomBytes(6).toString('hex')}`;
  return mockMoxfield.setDeck({ ...blueFarmDeck(), publicId, name });
}

/** The deck id in the URL of a deck page (`/decks/{deckId}...`). */
export function deckIdFromUrl(url: string): string {
  const match = /^\/decks\/([^/?#]+)/.exec(new URL(url).pathname);
  if (match?.[1] === undefined) throw new Error(`Not a deck page: ${url}`);
  return decodeURIComponent(match[1]);
}

/** Tracks a deck from the home page by its Moxfield URL; resolves on the new deck's page. */
export async function trackDeck(page: Page, deckUrl: string): Promise<string> {
  await page.goto('/');
  await page.getByLabel('Moxfield deck URL').fill(deckUrl);
  await page.getByRole('button', { name: 'Track deck' }).click();
  await page.waitForURL((url) => url.origin === new URL(APP_URL).origin && DECK_PAGE_PATH.test(url.pathname));
  return deckIdFromUrl(page.url());
}

export interface CommitOptions {
  /** Expected next version, e.g. 2 for `Commit v2`. */
  sequence: number;
  message?: string;
  /** The message's description (its body). */
  description?: string;
  tags?: readonly string[];
}

/** Fills in and submits the commit form on the deck's Status page. */
export async function commitVersion(
  page: Page,
  { sequence, message, description, tags = [] }: CommitOptions,
): Promise<void> {
  if (message !== undefined) await page.getByLabel('Commit message').fill(message);
  if (description !== undefined) await page.getByLabel('Description').fill(description);
  // The input ("Tags (optional)"), not the tag lists of the versions beside the form.
  const tagInput = page.getByRole('textbox', { name: /^Tags\b/ });
  for (const tag of tags) {
    await tagInput.fill(tag);
    await tagInput.press('Enter');
    await expect(page.getByRole('button', { name: `Remove tag ${tag}` })).toBeVisible();
  }
  await page.getByRole('button', { name: `Commit v${sequence}` }).click();
}

export interface TrackAndCommitOptions {
  /** The deck's name on the mock Moxfield. Default: `Blue Farm`. */
  name?: string;
  /** The commit message of v1. */
  message: string;
  /** The description of v1's message, when it has one. */
  description?: string;
  /**
   * What confirms the commit: the `Committed v1` toast, or the Status page's `Up to date
   * with v1` heading.
   */
  confirm: 'toast' | 'status';
}

/**
 * The preamble of most journeys: a copy of Blue Farm on the mock Moxfield, tracked as it
 * is by the signed-in user of `page`, and committed as v1. A journey that edits the deck
 * before tracking it, or asserts something between the steps, does them one by one.
 */
export async function trackAndCommitV1(
  page: Page,
  testInfo: TestInfo,
  { name, message, description, confirm }: TrackAndCommitOptions,
): Promise<{ deck: MoxDeckSpec; deckId: string }> {
  const deck = await createBlueFarmCopy(testInfo, name);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message, ...(description === undefined ? {} : { description }) });
  if (confirm === 'toast') await expect(page.getByText('Committed v1')).toBeVisible();
  else await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();
  return { deck, deckId };
}

/**
 * Asserts that the page does not scroll sideways: nothing is wider than the screen.
 *
 * `innerWidth` alone is not a reliable reference on phones: a mobile browser widens its
 * layout viewport to fit content that is too wide (and zooms out), so `innerWidth` grows
 * with the overflow. The page is therefore also measured against the emulated screen.
 */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const screen = page.viewportSize();
  if (screen === null) throw new Error('The page has no fixed viewport size');
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.scrollingElement?.scrollWidth ?? document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  const message = `${page.url()} is wider than the screen`;
  expect(scrollWidth, message).toBeLessThanOrEqual(innerWidth);
  expect(scrollWidth, message).toBeLessThanOrEqual(screen.width);
}
