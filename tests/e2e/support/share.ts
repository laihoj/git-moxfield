/**
 * Read-only share links in e2e tests (ADR 0007): the owner's steps on a deck's Share page,
 * and the checks every page a link opens must pass.
 *
 * A share link is a bearer secret (`/s/gmv_…`): whoever holds it sees that one deck's
 * committed history, signed in or not, and nothing else. The checks below look at a
 * viewer page the way a suspicious reviewer would: the read-only banner is there, no
 * control that changes anything is, every link stays inside the share link, nothing
 * tells where the deck lives on Moxfield (its URL opens the live deck, uncommitted
 * changes included, and would outlive the link), and the page is private (never cached,
 * indexed or leaked through the Referer header).
 */
import type { Locator, Page, Response } from '@playwright/test';

import { APP_URL } from './constants';
import { expect } from './fixtures';

/** A share link's URL, exactly as the Share page shows it once: `…/s/gmv_` + 43 base64url characters. */
const SHARE_URL = /^https?:\/\/[^\s/]+\/s\/gmv_[A-Za-z0-9_-]{43}$/;

/** Who shared a deck, as its viewers are told, and what they must never be told. */
export interface SharedDeckFacts {
  /** The owner's display name, which the read-only banner shows. */
  ownerName: string;
  /** The deck's Moxfield public id, which no page of the link may contain. */
  publicId: string;
}

/** A share link just created on the Share page. */
export interface ShareLink {
  /** The full URL, as shown once (and copied by the owner). */
  url: string;
  /** Its path, `/s/gmv_…`: the base of every page the link opens. */
  path: string;
  /** The secret part (`gmv_…`), to check that it appears nowhere it should not. */
  token: string;
}

export interface CreateShareLinkOptions {
  /** Who the link is for; only the owner sees it. */
  label: string;
  /** Tick "Include my version notes". Default: off. */
  includeNotes?: boolean;
  /**
   * Runs while the new link's panel is still open (the only time its URL is shown), e.g.
   * to copy it with the Copy link button.
   */
  whileShown?: (panel: Locator, link: ShareLink) => Promise<void>;
}

/** The deck's Status · History · Compare · Cards (owner) or Overview · … (viewer) navigation. */
export function deckNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Deck' });
}

/** The card of the Share page that creates links. */
function newLinkCard(page: Page): Locator {
  return page.getByRole('region', { name: 'Share this deck' });
}

/**
 * Creates a share link of the deck `deckId` on its Share page (opened unless `page` is
 * already there), the way an owner does, and resolves with it once the panel showing
 * it has been closed with Done. Asserts that the URL is shown with the warning that it
 * is shown only once, and that it is gone from the page afterwards.
 */
export async function createShareLink(
  page: Page,
  deckId: string,
  { label, includeNotes = false, whileShown }: CreateShareLinkOptions,
): Promise<ShareLink> {
  const sharePath = `/decks/${deckId}/share`;
  if (new URL(page.url()).pathname !== sharePath) await page.goto(sharePath);
  const card = newLinkCard(page);
  await card.getByLabel('Who is it for?').fill(label);
  const notes = card.getByRole('checkbox', { name: 'Include my version notes' });
  await expect(notes).not.toBeChecked();
  if (includeNotes) await notes.check();
  await card.getByRole('button', { name: 'Create link' }).click();

  await expect(card.getByRole('heading', { level: 3, name: `Link for “${label}” is ready` })).toBeVisible();
  await expect(card).toContainText(
    includeNotes
      ? 'Anyone who opens it sees this deck’s versions, read-only, with your notes.'
      : 'Anyone who opens it sees this deck’s versions, read-only.',
  );
  await expect(card).toContainText('Copy it now: it won’t be shown again.');
  const shown = card.getByText(SHARE_URL);
  await expect(shown).toBeVisible();
  const url = (await shown.textContent())?.trim() ?? '';
  expect(new URL(url).origin).toBe(new URL(APP_URL).origin);
  const path = new URL(url).pathname;
  const link: ShareLink = { url, path, token: path.slice('/s/'.length) };

  if (whileShown !== undefined) await whileShown(card, link);
  await card.getByRole('button', { name: 'Done' }).click();
  // Shown once: the URL is gone, and the form is back for the next link.
  await expect(card.getByLabel('Who is it for?')).toHaveValue('');
  await expect(page.getByText(link.token)).toHaveCount(0);
  return link;
}

/** The row of a link in the Share page's list, by its label. */
export function shareLinkRow(page: Page, label: string): Locator {
  return page
    .getByRole('list', { name: 'Share links' })
    .locator(':scope > li')
    .filter({ has: page.getByText(label, { exact: true }) });
}

/** Revokes a link on the deck's Share page (which `page` shows), confirming as an owner does. */
export async function revokeShareLink(page: Page, label: string): Promise<void> {
  const row = shareLinkRow(page, label);
  await row.getByRole('button', { name: `Revoke ${label}` }).click();
  const confirm = row.getByRole('group');
  await expect(confirm).toContainText(`Revoke “${label}”? Anyone using it loses access at once.`);
  await confirm.getByRole('button', { name: 'Revoke link' }).click();
  await expect(shareLinkRow(page, label)).toHaveCount(0);
}

/**
 * Asserts that `response` (of a page a share link opens, found or not) and the page it
 * rendered are private: never stored by a cache, never indexed, archived or followed by
 * search engines, and no Referer header (which would carry the token) when leaving.
 */
export async function expectPrivatePage(page: Page, response: Response | null): Promise<void> {
  if (response === null) throw new Error(`No response for ${page.url()}`);
  const headers = response.headers();
  expect(headers['cache-control'], `Cache-Control of ${page.url()}`).toMatch(/\bno-store\b/);
  expect(headers['referrer-policy'], `Referrer-Policy of ${page.url()}`).toBe('no-referrer');
  const robots = await page
    .locator('meta[name="robots"]')
    .evaluateAll((metas) => metas.map((meta) => meta.getAttribute('content') ?? ''));
  expect(robots.length, `robots meta of ${page.url()}`).toBeGreaterThan(0);
  for (const content of robots) expect(content, `robots meta of ${page.url()}`).toMatch(/\bnoindex\b/);
  expect(robots.join(', ')).toMatch(/\bnofollow\b/);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
}

/**
 * Asserts that `page` is a page of the share link `link`, read-only: the banner names the
 * owner, the frame has no way into the app (no account menu, no app navigation), there is
 * no control that changes anything and nothing of the deck's uncommitted Moxfield state,
 * nothing (no link, no text, nothing in the page's data) names the deck on Moxfield, and
 * every link and form stays inside the share link.
 */
export async function expectReadOnlyPage(page: Page, link: ShareLink, deck: SharedDeckFacts): Promise<void> {
  const header = page.getByRole('banner');
  await expect(header).toContainText(`Shared by ${deck.ownerName} · read-only`);
  await expect(header.getByRole('link', { name: 'git-moxfield' })).toHaveAttribute('href', link.path);
  await expect(page.getByRole('button', { name: /^Account menu/ })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  // Nothing that writes: no commit, refresh, tag or notes editing, untracking or sharing.
  for (const name of [
    /^Commit v\d+$/,
    /^Refresh$/,
    /^Checking/,
    'Stop tracking',
    'Add tag',
    /^Remove tag /,
    'Save notes',
    'Use suggestion',
  ]) {
    await expect(page.getByRole('button', { name }), `button ${String(name)}`).toHaveCount(0);
  }
  for (const name of ['Commit message', 'Tags', 'Notes', 'New tag']) {
    await expect(page.getByRole('textbox', { name, exact: true }), `textbox ${name}`).toHaveCount(0);
  }
  await expect(page.getByRole('link', { name: 'Share', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Status', exact: true })).toHaveCount(0);
  // No uncommitted Moxfield state, anywhere.
  await expect(
    page.getByText(/Uncommitted changes|Current Moxfield deck|Now on Moxfield|Not committed yet/),
  ).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Current Moxfield deck' })).toHaveCount(0);

  // Not where the deck lives on Moxfield: neither a link to it nor its id, anywhere in
  // the page or the data it was rendered from.
  await expect(page.getByRole('link', { name: /^Moxfield/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open deck in Moxfield/ })).toHaveCount(0);
  expect(await page.content(), `the Moxfield id on ${page.url()}`).not.toContain(deck.publicId);

  const appOrigin = new URL(APP_URL).origin;
  const targets = await page.evaluate(() => [
    ...Array.from(document.querySelectorAll('a[href]'), (anchor) => (anchor as HTMLAnchorElement).href),
    ...Array.from(document.querySelectorAll('form'), (form) => form.action),
  ]);
  for (const target of targets) {
    const url = new URL(target);
    if (url.origin === appOrigin) {
      expect(
        url.pathname === link.path || url.pathname.startsWith(`${link.path}/`),
        `${target} on ${page.url()} leaves the share link`,
      ).toBe(true);
    } else {
      // Only a link the owner wrote in a primer leaves the app, in a new tab; never a
      // script, a server action, or the deck on Moxfield.
      expect(url.protocol, `${target} on ${page.url()}`).toMatch(/^https?:$/);
      expect(target, `${target} on ${page.url()}`).not.toContain(`/decks/${deck.publicId}`);
    }
  }
}

/** The page every share link that grants nothing gets (unknown, revoked, untracked, malformed). */
export async function expectLinkNotWorking(page: Page, path: string): Promise<string> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(404);
  await expectPrivatePage(page, response);
  return expectDeadLinkPage(page);
}

/**
 * Asserts that `page` shows what every share link that grants nothing gets, also when it
 * got there without loading a page (a click in a page that was open when the link was
 * revoked). Resolves with the page's main text.
 */
export async function expectDeadLinkPage(page: Page): Promise<string> {
  await expect(page).toHaveTitle('Link not available · git-moxfield');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('This link doesn’t work anymore');
  await expect(page.getByRole('main')).toContainText('Ask them for a new link.');
  // Nothing about any deck or its owner, and no way into the app.
  await expect(page.getByText(/read-only|Shared by/)).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'git-moxfield' })).toHaveCount(0);
  return page.getByRole('main').innerText();
}

/** The page of a working share link that the shared deck does not have (a version, card or page). */
export async function expectNotPartOfSharedDeck(
  page: Page,
  link: ShareLink,
  deck: SharedDeckFacts,
  path: string,
): Promise<void> {
  const response = await page.goto(path);
  await expectPrivatePage(page, response);
  await expect(page.getByRole('heading', { level: 1, name: 'We couldn’t find that' }), path).toBeVisible();
  await expect(page.getByRole('main')).toContainText('not part of the shared deck');
  await expect(page.getByRole('link', { name: 'Back to the deck' })).toHaveAttribute('href', link.path);
  await expectReadOnlyPage(page, link, deck);
}
