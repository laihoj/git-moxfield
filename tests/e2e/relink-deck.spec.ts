/**
 * Journey: a deck deleted on Moxfield and made again. The new copy has a new public id, so
 * the bookmarklet first presents it as a deck git-moxfield does not track. Instead of
 * tracking it as a new deck, the user continues the old deck's history with it: the deck
 * keeps its versions, follows the new Moxfield deck from then on, and the next commit is
 * v2 on top of v1.
 *
 * Desktop only: it runs the popup bookmarklet (phones use the same-tab bookmarklet, which
 * tracks untracked decks without asking; "Change Moxfield deck" on the deck page covers them).
 */
import type { Locator, Page } from '@playwright/test';

import { signIn } from './support/accounts';
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import {
  DECK_PAGE_PATH,
  commitVersion,
  createBlueFarmCopy,
  deckIdFromUrl,
  expectNoHorizontalOverflow,
  statusHeading,
  trackAndCommitV1,
  trackDeck,
} from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

function moxfieldDeckPanel(page: Page): Locator {
  return page.getByRole('region', { name: 'Moxfield deck' });
}

test('continues a deck deleted and made again on Moxfield, keeping its history', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Phones block popups; they use the same-tab bookmarklet.');
  const { bookmarklets } = await signIn(context, { bookmarkletLabel: 'Laptop' });
  const lost = await createBlueFarmCopy(testInfo, 'Lost deck');
  let deckId = '';

  await test.step('track the deck and commit v1', async () => {
    deckId = await trackDeck(page, mockMoxfield.deckPageUrl(lost.publicId));
    await commitVersion(page, { sequence: 1, message: 'Tournament list' });
    await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();
    await expect(
      moxfieldDeckPanel(page).getByRole('link', { name: new RegExp(lost.publicId) }),
    ).toBeVisible();
  });

  // Made again: the same cards under a new public id.
  const recreated = await createBlueFarmCopy(testInfo, 'Lost deck');
  await test.step('delete the deck on Moxfield and make it again', async () => {
    await mockMoxfield.deleteDeck(lost.publicId);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText('Deck not found on Moxfield', { exact: true })).toBeVisible();
    await expect(page.getByText(/Deleted it and made it again\?/)).toBeVisible();
    // The hint opens "Change Moxfield deck" (for a deck made again that the server can fetch).
    await page.getByRole('link', { name: 'Change the Moxfield deck' }).click();
    const form = moxfieldDeckPanel(page).getByRole('form', { name: 'Change Moxfield deck' });
    await expect(form.getByLabel('New Moxfield deck URL')).toBeFocused();
    await form.getByRole('button', { name: 'Cancel' }).click();
    await expect(form).toHaveCount(0);
  });

  // From here on, as on the real Moxfield: the server is blocked, the browser is not.
  await mockMoxfield.setMode('blocked');
  let popup: Page = page;
  await test.step('run the bookmarklet on the new deck and continue the Lost deck', async () => {
    await page.goto(mockMoxfield.deckPageUrl(recreated.publicId));
    popup = await runBookmarklet(page, bookmarklets.popup);
    await expect(popup.getByRole('region', { name: 'Track “Lost deck”?' })).toBeVisible();
    const continueDeck = popup.getByRole('region', { name: 'Or continue an existing deck’s history' });
    await expect(continueDeck).toContainText('Deleted a deck on Moxfield and made it again?');
    // The deck with the captured deck's name is preselected.
    const choice = continueDeck.getByLabel('Deck to continue');
    await expect(choice).toHaveValue(deckId);
    await expect(choice.locator('option:checked')).toHaveText('Lost deck · 1 version');
    await expectNoHorizontalOverflow(popup);

    await continueDeck.getByRole('button', { name: 'Continue “Lost deck”' }).click();
    await popup.waitForURL((url) => url.origin === APP_URL && DECK_PAGE_PATH.test(url.pathname));
    expect(deckIdFromUrl(popup.url())).toBe(deckId);
    expect(new URL(popup.url()).search).toBe('?captured=1&relinked=1');
  });

  await test.step('the deck follows the new Moxfield deck and matches v1', async () => {
    await expect(
      popup.getByRole('status').filter({ hasText: 'Continued with the new Moxfield deck' }),
    ).toContainText('Its versions are kept, and the deck matches v1.');
    // Identical cards: nothing to commit.
    await expect(statusHeading(popup, 'Up to date with v1')).toBeVisible();
    await expect(popup.getByRole('button', { name: /^Commit v/ })).toHaveCount(0);
    const panel = moxfieldDeckPanel(popup);
    await expect(panel.getByRole('link', { name: new RegExp(recreated.publicId) })).toHaveAttribute(
      'href',
      mockMoxfield.deckPageUrl(recreated.publicId),
    );
    await expect(panel.getByRole('list', { name: 'Earlier Moxfield decks' })).toContainText(
      `Followed ${lost.publicId} until`,
    );
    await expect(popup.getByRole('link', { name: /^Moxfield/ }).first()).toHaveAttribute(
      'href',
      mockMoxfield.deckPageUrl(recreated.publicId),
    );
    await expectNoHorizontalOverflow(popup);
    // Still one deck.
    await popup.goto('/');
    await expect(popup.getByRole('link', { name: 'Lost deck' })).toHaveCount(1);
  });

  await test.step('change the new deck on Moxfield, send it again and commit v2', async () => {
    await mockMoxfield.edit(recreated.publicId, [
      { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
    ]);
    await page.goto(mockMoxfield.deckPageUrl(recreated.publicId));
    const again = await runBookmarklet(page, bookmarklets.popup);
    // A tracked deck: no question this time.
    await again.waitForURL((url) => url.origin === APP_URL && DECK_PAGE_PATH.test(url.pathname));
    expect(deckIdFromUrl(again.url())).toBe(deckId);
    await expect(statusHeading(again, 'Uncommitted changes')).toBeVisible();
    const changes = again.getByRole('region', { name: 'Changes since v1' });
    await expect(changes.getByRole('region', { name: /^Moved/ })).toContainText(
      'Moved from Mainboard to Considering: Dress Down',
    );

    await commitVersion(again, { sequence: 2, message: 'Cut Dress Down' });
    await expect(statusHeading(again, 'Up to date with v2')).toBeVisible();
    await again.goto(`/decks/${deckId}/history`);
    await expect(again.getByText('2 versions. Select two to compare them.')).toBeVisible();
    const versions = again.getByRole('link', { name: /^v\d+: / });
    expect(
      await versions.evaluateAll((links) => links.map((link) => link.getAttribute('aria-label'))),
    ).toEqual(['v2: Cut Dress Down', 'v1: Tournament list']);
  });
});

test('changes the Moxfield deck from the deck page, on any screen', async ({ page, context }, testInfo) => {
  await signIn(context);
  const { deck: lost, deckId } = await trackAndCommitV1(page, testInfo, {
    name: 'Moved deck',
    message: 'Tournament list',
    confirm: 'status',
  });

  // Made again on Moxfield, with one change since v1.
  await mockMoxfield.deleteDeck(lost.publicId);
  const recreated = await createBlueFarmCopy(testInfo, 'Moved deck');
  await mockMoxfield.edit(recreated.publicId, [
    { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
  ]);

  const panel = moxfieldDeckPanel(page);
  await panel.getByRole('button', { name: 'Change Moxfield deck' }).click();
  const form = panel.getByRole('form', { name: 'Change Moxfield deck' });
  await expect(form).toContainText('Deleted this deck on Moxfield and made it again?');
  await expectNoHorizontalOverflow(page);
  await form.getByLabel('New Moxfield deck URL').fill('not a deck');
  await form.getByRole('button', { name: 'Change deck' }).click();
  await expect(form.getByRole('alert')).toContainText('cannot contain spaces');

  await form.getByLabel('New Moxfield deck URL').fill(mockMoxfield.deckPageUrl(recreated.publicId));
  await form.getByRole('button', { name: 'Change deck' }).click();
  await page.waitForURL((url) => url.search === '?relinked=1');
  expect(deckIdFromUrl(page.url())).toBe(deckId);
  await expect(page.getByRole('status').filter({ hasText: 'Moxfield deck changed' })).toBeVisible();
  // The server fetched the new deck right away: it differs from v1 by the move.
  await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Changes since v1' }).getByRole('region', { name: /^Moved/ }),
  ).toContainText('Moved from Mainboard to Considering: Dress Down');
  await expect(panel.getByRole('list', { name: 'Earlier Moxfield decks' })).toContainText(
    `Followed ${lost.publicId} until`,
  );
  await expectNoHorizontalOverflow(page);

  await commitVersion(page, { sequence: 2, message: 'Made again on Moxfield' });
  await expect(statusHeading(page, 'Up to date with v2')).toBeVisible();
});
