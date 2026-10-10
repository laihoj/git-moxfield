/**
 * Journey 3, the desktop bookmarklet: run on a Moxfield deck page git-moxfield does not
 * track yet, it opens git-moxfield's capture page in a popup and hands the deck over by
 * `postMessage`, along with the user's bookmarklet key. The capture page asks before
 * tracking the deck, then opens it. The key also signs the browser in (ADR 0006), so
 * the bookmarklet works the same in a browser that has never been signed in.
 *
 * Desktop only: phones block popups, which is what the same-tab bookmarklet is for
 * (journey 2).
 */
import { expectSignedInAs, signIn, signedInDevices } from './support/accounts';
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

test('the popup bookmarklet asks before tracking a new deck, then opens it', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Phones block popups; they use the same-tab bookmarklet.');
  const { user, bookmarklets } = await signIn(context, { bookmarkletLabel: 'Laptop' });
  // As with the real Moxfield, the server is blocked and the browser is not.
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Popup Farm');
  await page.goto(mockMoxfield.deckPageUrl(deck.publicId));

  const popup = await runBookmarklet(page, bookmarklets.popup);
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
  await expectSignedInAs(popup, user.displayName);
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
  // The browser's session was kept: the key's two requests (ask, then track) started no other.
  await popup.goto('/account');
  await expect(signedInDevices(popup)).toHaveCount(1);

  // The server never reached Moxfield; the browser read the deck and its primer.
  const requests = (await mockMoxfield.requests()).filter((request) => request.path.startsWith('/v'));
  expect(requests.filter((request) => request.client === 'server')).toEqual([]);
  expect(requests.map((request) => `${request.status} ${request.path}`)).toEqual([
    `200 /v3/decks/all/${deck.publicId}`,
    expect.stringMatching(/^200 \/v1\/decks\/[\w-]+\/primer$/),
  ]);
});

test('the popup bookmarklet signs a fresh browser in and sends the deck to its owner', async ({
  context,
  newContext,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Phones block popups; they use the same-tab bookmarklet.');
  const { user: owner, bookmarklets } = await signIn(context, { bookmarkletLabel: 'Work laptop' });
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Office Farm');
  const browser = await newContext();
  const moxfieldTab = await browser.newPage();
  await moxfieldTab.goto(mockMoxfield.deckPageUrl(deck.publicId));

  const popup = await runBookmarklet(moxfieldTab, bookmarklets.popup);
  const confirm = popup.getByRole('region', { name: 'Track “Office Farm”?' });
  await expect(confirm).toBeVisible();
  // The deck's hand-over signed the browser in already; the Moxfield tab reports it sent.
  await expect(moxfieldTab.getByRole('status')).toHaveText('git-moxfield: Sent');
  expect((await browser.cookies(APP_URL)).map((cookie) => cookie.name).sort()).toEqual([
    '__Host-gm_session',
    '__Host-gm_session_fresh',
  ]);

  await confirm.getByRole('button', { name: 'Track this deck' }).click();
  await popup.waitForURL((url) => url.origin === APP_URL && DECK_PAGE_PATH.test(url.pathname));
  // A full page load: the header renders for the new session.
  await expectSignedInAs(popup, owner.displayName);
  await expect(popup.getByRole('heading', { level: 1, name: 'Office Farm' })).toBeVisible();
  const deckPath = `/decks/${deckIdFromUrl(popup.url())}`;

  // Any page of that browser is signed in now, as the owner, with the deck in the owner's list.
  const another = await browser.newPage();
  await another.goto('/');
  await expectSignedInAs(another, owner.displayName);
  await expect(another.getByRole('link', { name: 'Office Farm' })).toHaveAttribute('href', deckPath);
});
