/**
 * Journey 3, the desktop bookmarklet: run on a Moxfield deck page git-moxfield does not
 * track yet, it opens git-moxfield's capture page in a popup and hands the deck over by
 * `postMessage`. The capture page asks before tracking the deck, then opens it.
 *
 * Desktop only: phones block popups, which is what the same-tab bookmarklet is for
 * (journey 2).
 */
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import {
  DECK_PAGE_PATH,
  createBlueFarmCopy,
  deckIdFromUrl,
  expectNoHorizontalOverflow,
} from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('the popup bookmarklet asks before tracking a new deck, then opens it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Phones block popups; they use the same-tab bookmarklet.');
  // As with the real Moxfield, the server is blocked and the browser is not.
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Popup Farm');
  await page.goto(mockMoxfield.deckPageUrl(deck.publicId));

  const popup = await runBookmarklet(page, { mode: 'popup' });
  expect(new URL(popup.url()).pathname).toBe('/capture');

  const confirm = popup.getByRole('region', { name: 'Track “Popup Farm”?' });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('git-moxfield does not track this deck yet.');
  await expect(popup.getByRole('heading', { level: 1, name: 'Send to git-moxfield' })).toBeVisible();
  // The nonce is removed from the address bar once the hand-over started.
  expect(new URL(popup.url()).hash).toBe('');
  await expectNoHorizontalOverflow(popup);

  await confirm.getByRole('button', { name: 'Track this deck' }).click();
  await popup.waitForURL((url) => url.origin === APP_URL && DECK_PAGE_PATH.test(url.pathname));
  expect(new URL(popup.url()).searchParams.get('captured')).toBe('1');
  await expect(popup.getByRole('status').filter({ hasText: 'Updated from Moxfield' })).toBeVisible();
  await expect(popup.getByRole('heading', { level: 1, name: 'Popup Farm' })).toBeVisible();
  await expect(popup.getByRole('heading', { level: 2, name: 'Not committed yet' })).toBeVisible();
  await expect(popup.getByRole('list', { name: 'Moxfield activity' })).toContainText(
    'sent from your browser',
  );
  await expect(popup.getByRole('region', { name: 'Initial version' })).toContainText(
    '100 cards in the deck.',
  );

  // The deck is tracked now: the deck list links to it.
  const deckPath = `/decks/${deckIdFromUrl(popup.url())}`;
  await popup.goto('/');
  await expect(
    popup.getByRole('link', { name: 'Popup Farm' }).and(popup.locator(`[href="${deckPath}"]`)),
  ).toBeVisible();

  // The server never reached Moxfield; the browser read the deck and its primer.
  const requests = (await mockMoxfield.requests()).filter((request) => request.path.startsWith('/v'));
  expect(requests.filter((request) => request.client === 'server')).toEqual([]);
  expect(requests.map((request) => `${request.status} ${request.path}`)).toEqual([
    `200 /v3/decks/all/${deck.publicId}`,
    expect.stringMatching(/^200 \/v1\/decks\/[\w-]+\/primer$/),
  ]);
});
