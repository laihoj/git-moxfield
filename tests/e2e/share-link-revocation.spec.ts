/**
 * Ending a share link's access (ADR 0007): revoking the link on the deck's Share page, or
 * untracking the deck, ends it at once, on every page of the link, the restore download
 * included, and in pages that were open at the time (on their next click). The viewer
 * then gets exactly what an unknown link gets, so a revoked link reveals nothing.
 *
 * A link made in a browser that a bookmarklet signed in descends from that bookmarklet's
 * key (ADR 0006): revoking the key can revoke such links too, when the owner opts in (a
 * stolen key's links), and leaves them working otherwise (links the owner shared
 * themselves), which the Account page keeps listing so they can be revoked later. Links
 * made elsewhere are never affected.
 */
import type { Page } from '@playwright/test';

import {
  bookmarkletRows,
  confirmBookmarkletSignIn,
  signIn,
  uniqueName,
  type E2EUser,
} from './support/accounts';
import { createBookmarkletOnSetupPage, runBookmarklet } from './support/bookmarklet';
import {
  commitVersion,
  createBlueFarmCopy,
  deckIdFromUrl,
  expectNoHorizontalOverflow,
  trackDeck,
} from './support/decks';
import { expect, test, type NewContext } from './support/fixtures';
import { mockMoxfield } from './support/mock';
import {
  createShareLink,
  deckNav,
  expectDeadLinkPage,
  expectLinkNotWorking,
  expectReadOnlyPage,
  revokeShareLink,
  shareLinkRow,
  type SharedDeckFacts,
  type ShareLink,
} from './support/share';

const DECK_NAME = 'Shared Farm';

/** Asserts that every page of `link` works for `viewer` (and shows the deck). */
async function expectLinkWorks(viewer: Page, link: ShareLink, deck: SharedDeckFacts): Promise<void> {
  for (const path of [link.path, `${link.path}/history`, `${link.path}/versions/1`]) {
    const response = await viewer.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(viewer.getByRole('heading', { level: 1, name: DECK_NAME }), path).toBeVisible();
    await expectReadOnlyPage(viewer, link, deck);
  }
  const download = await viewer.context().request.get(`${link.path}/versions/1/restore.txt`);
  expect(download.status()).toBe(200);
}

/** Asserts that every page of `link` is gone for `viewer`, exactly like a link that never existed. */
async function expectLinkGone(viewer: Page, link: ShareLink): Promise<void> {
  const unknown = await expectLinkNotWorking(viewer, `/s/gmv_${'A'.repeat(43)}`);
  for (const path of [
    link.path,
    `${link.path}/history`,
    `${link.path}/versions/1`,
    `${link.path}/versions/1/restore`,
    `${link.path}/compare?from=empty&to=v1`,
    `${link.path}/cards/dress%20down`,
  ]) {
    expect(await expectLinkNotWorking(viewer, path), path).toBe(unknown);
  }
  const download = await viewer.context().request.get(`${link.path}/versions/1/restore.txt`);
  expect(download.status()).toBe(404);
  expect(await download.text()).toBe('Not found.\n');
}

/** A signed-out browser for viewing links. */
async function openViewer(newContext: NewContext): Promise<Page> {
  return (await newContext()).newPage();
}

test('revoking a link, or untracking its deck, ends its access at once', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  // The browser reports each 404 page in the console.
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 404/);
  const { user: owner } = await signIn(context, { displayName: uniqueName('Aino') });
  const deck = await createBlueFarmCopy(testInfo, DECK_NAME);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Tournament list' });
  await expect(page.getByText('Committed v1')).toBeVisible();
  const viewing: SharedDeckFacts = { ownerName: owner.displayName, publicId: deck.publicId };
  const viewer = await openViewer(newContext);

  await test.step('a page open when its link is revoked shows that on the next click', async () => {
    // A version link, and a tab of the deck's navigation: neither may show the deck's
    // frame (its name, its owner) with a "not part of the shared deck" message.
    const clicks = [
      (open: Page) => open.getByRole('main').getByRole('link', { name: 'v1: Tournament list' }).click(),
      (open: Page) => deckNav(open).getByRole('link', { name: 'Compare' }).click(),
    ];
    for (const [index, click] of clicks.entries()) {
      const label = `Open in a tab ${index + 1}`;
      const link = await createShareLink(page, deckId, { label });
      const open = await openViewer(newContext);
      await open.goto(`${link.path}/history`);
      await expect(open.getByRole('heading', { level: 1, name: DECK_NAME })).toBeVisible();
      await revokeShareLink(page, label);

      await click(open);
      await expectDeadLinkPage(open);
      await expect(open.getByText(DECK_NAME)).toHaveCount(0);
      await open.close();
    }
  });

  await test.step('the owner revokes a link that was viewed: the viewer loses access', async () => {
    const link = await createShareLink(page, deckId, { label: 'Playgroup chat' });
    const kept = await createShareLink(page, deckId, { label: 'For Mikko' });
    await expectLinkWorks(viewer, link, viewing);

    await page.reload();
    await expect(shareLinkRow(page, 'Playgroup chat')).toContainText('Last viewed');
    await expectNoHorizontalOverflow(page);
    await revokeShareLink(page, 'Playgroup chat');
    await expect(page.getByRole('heading', { level: 2, name: 'Links (1)' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await expectLinkGone(viewer, link);
    // The deck's other link keeps working.
    await expectLinkWorks(viewer, kept, viewing);
    // Revoked for good: reloading the Share page does not bring it back.
    await page.reload();
    await expect(shareLinkRow(page, 'Playgroup chat')).toHaveCount(0);
    await expect(shareLinkRow(page, 'For Mikko')).toBeVisible();
  });

  await test.step('untracking the deck ends every link to it', async () => {
    await page.goto(`/decks/${deckId}/share`);
    await expect(shareLinkRow(page, 'For Mikko')).toBeVisible();
    const kept = await createShareLink(page, deckId, { label: 'Second link' });
    await expectLinkWorks(viewer, kept, viewing);

    await page.goto(`/decks/${deckId}`);
    await page.getByRole('button', { name: 'Stop tracking' }).click();
    await page
      .getByRole('group', { name: 'Confirm stop tracking' })
      .getByRole('button', { name: 'Stop tracking and delete history' })
      .click();
    await expect(page).toHaveURL('/');
    await expect(page.getByText(DECK_NAME)).toHaveCount(0);

    await expectLinkGone(viewer, kept);
  });
});

/**
 * Signs a new browser in with `bookmarklet` (same-tab, on the deck's Moxfield page),
 * confirming as `owner`, and returns it on the deck's page.
 */
async function signInWithBookmarklet(
  newContext: NewContext,
  bookmarklet: string,
  owner: E2EUser,
  label: string,
  publicId: string,
): Promise<Page> {
  const browser = await (await newContext()).newPage();
  await browser.goto(mockMoxfield.deckPageUrl(publicId));
  await runBookmarklet(browser, bookmarklet);
  await confirmBookmarkletSignIn(browser, owner.displayName, label);
  await expect(browser.getByRole('heading', { level: 1, name: DECK_NAME })).toBeVisible();
  return browser;
}

test('revoking a bookmarklet can revoke the share links made in the browsers it signed in', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Bookmarklets and accounts are covered on desktop.');
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 404/);
  const { user: owner, bookmarklets: phoneBookmarklets } = await signIn(context, {
    displayName: uniqueName('Aino'),
    bookmarkletLabel: 'Old phone',
  });
  const deck = await createBlueFarmCopy(testInfo, DECK_NAME);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Tournament list' });
  await expect(page.getByText('Committed v1')).toBeVisible();
  const tabletBookmarklets = await createBookmarkletOnSetupPage(page, 'Tablet');

  // A link made on this computer (signed in without a bookmarklet), and one in each
  // browser a bookmarklet signed in.
  const computerLink = await createShareLink(page, deckId, { label: 'Made on the computer' });
  const phone = await signInWithBookmarklet(
    newContext,
    phoneBookmarklets['same-tab'],
    owner,
    'Old phone',
    deck.publicId,
  );
  expect(deckIdFromUrl(phone.url())).toBe(deckId);
  const phoneLink = await createShareLink(phone, deckId, { label: 'Made on the phone' });
  const tablet = await signInWithBookmarklet(
    newContext,
    tabletBookmarklets['same-tab'],
    owner,
    'Tablet',
    deck.publicId,
  );
  const tabletLink = await createShareLink(tablet, deckId, { label: 'Made on the tablet' });

  const viewing: SharedDeckFacts = { ownerName: owner.displayName, publicId: deck.publicId };
  const viewer = await openViewer(newContext);
  for (const link of [computerLink, phoneLink, tabletLink]) await expectLinkWorks(viewer, link, viewing);
  const revokedKeyLinks = page.getByRole('list', { name: 'Share links of revoked bookmarklets' });

  await test.step('revoked without the opt-in, a bookmarklet’s links keep working', async () => {
    await page.goto('/account');
    const row = bookmarkletRows(page).filter({ hasText: 'Tablet' });
    await row.getByRole('button', { name: 'Revoke Tablet' }).click();
    const confirm = row.getByRole('group');
    const optIn = confirm.getByRole('checkbox', {
      name: /^Also revoke the share link made in a browser it signed in\./,
    });
    await expect(optIn).not.toBeChecked();
    await confirm.getByRole('button', { name: 'Revoke bookmarklet' }).click();
    await expect(bookmarkletRows(page).filter({ hasText: 'Tablet' })).toHaveCount(0);

    await expectLinkWorks(viewer, tabletLink, viewing);
    // The tablet itself is signed out.
    await tablet.reload();
    await expect(tablet).toHaveURL(/\/signin\?next=/);
    // Its link is not forgotten: the Account page lists it under the revoked bookmarklet.
    await expect(revokedKeyLinks.locator(':scope > li')).toHaveCount(1);
    await expect(revokedKeyLinks.locator(':scope > li')).toContainText('Tablet');
    await expect(revokedKeyLinks.locator(':scope > li')).toContainText('1 share link still working');
    await expectNoHorizontalOverflow(page);
  });

  await test.step('revoked with the opt-in, its links stop working, also one made after the page loaded', async () => {
    const row = bookmarkletRows(page).filter({ hasText: 'Old phone' });
    // Made after the Account page loaded (its count says one link): revoked all the same.
    const latePhoneLink = await createShareLink(phone, deckId, { label: 'Made on the phone later' });
    await row.getByRole('button', { name: 'Revoke Old phone' }).click();
    const confirm = row.getByRole('group');
    await confirm
      .getByRole('checkbox', { name: /^Also revoke the share link made in a browser it signed in\./ })
      .check();
    await confirm.getByRole('button', { name: 'Revoke bookmarklet' }).click();
    await expect(page.getByText('No bookmarklets yet')).toBeVisible();

    await expectLinkGone(viewer, phoneLink);
    await expectLinkGone(viewer, latePhoneLink);
    await expectLinkWorks(viewer, computerLink, viewing);
    await expectLinkWorks(viewer, tabletLink, viewing);
    await expect(revokedKeyLinks.locator(':scope > li')).toHaveText([/Tablet/]);

    await page.goto(`/decks/${deckId}/share`);
    await expect(page.getByRole('list', { name: 'Share links' }).locator(':scope > li')).toHaveText([
      /Made on the tablet/,
      /Made on the computer/,
    ]);
  });

  await test.step('a bookmarklet revoked without its links can have them revoked later', async () => {
    await page.goto('/account');
    const row = revokedKeyLinks.locator(':scope > li').filter({ hasText: 'Tablet' });
    await row.getByRole('button', { name: 'Revoke the share links of Tablet' }).click();
    await expect(row.getByRole('group')).toContainText(
      'Revoke the share link made in a browser “Tablet” signed in? Anyone using it loses access at once',
    );
    await expectNoHorizontalOverflow(page);
    await row.getByRole('group').getByRole('button', { name: 'Revoke share link' }).click();
    await expect(revokedKeyLinks).toHaveCount(0);

    await expectLinkGone(viewer, tabletLink);
    await expectLinkWorks(viewer, computerLink, viewing);
    await page.goto(`/decks/${deckId}/share`);
    await expect(page.getByRole('list', { name: 'Share links' }).locator(':scope > li')).toHaveText([
      /Made on the computer/,
    ]);
  });
});
