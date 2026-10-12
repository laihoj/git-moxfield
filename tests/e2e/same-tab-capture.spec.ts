/**
 * Same-tab capture (phones and in-app browsers): the bookmarklet reads the deck on the
 * Moxfield deck page and posts it, with the user's bookmarklet key, as a form to
 * git-moxfield in the same tab. git-moxfield tracks the deck in the key owner's
 * workspace and opens the deck.
 *
 * The mock deck page makes the browser send `Origin: null` with that form post, as the
 * real https://moxfield.com does when posting to an http:// git-moxfield. The post
 * cannot see the browser's `SameSite=Lax` session cookie, so the sign-in is handed over
 * through `/api/auth/handoff`, a top-level GET that can (ADR 0006). Any member could make
 * such a post with their own key from any page, so the hand-off signs a browser in, or
 * switches it to another account, only after the user confirms on git-moxfield's own
 * page; a browser already signed in as the key's owner goes straight on.
 */
import type { Page, Request } from '@playwright/test';

import { buildBookmarklet } from '@/integrations/moxfield/capture';
import { CAPTURE_FORM_PATH } from '@/integrations/moxfield/capture-protocol';

import { confirmBookmarkletSignIn, expectSignedInAs, signIn, signedInDevices } from './support/accounts';
import { bookmarkletKey, runBookmarklet } from './support/bookmarklet';
import { APP_URL, MOCK_MOXFIELD_PORT, MOCK_MOXFIELD_URL } from './support/constants';
import {
  CAPTURED_DECK_URL,
  createBlueFarmCopy,
  deckIdFromUrl,
  expectNoHorizontalOverflow,
} from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

function isCaptureFormPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === CAPTURE_FORM_PATH;
}

/** Waits for the bookmarklet's form post from `page`. */
function captureFormPost(page: Page): Promise<Request> {
  return page.waitForRequest(isCaptureFormPost);
}

test('the same-tab bookmarklet signs a fresh browser in and sends the deck to its owner', async ({
  page,
  context,
  newContext,
}, testInfo) => {
  // The owner's computer is signed in; the phone has never seen git-moxfield.
  const { user: owner, bookmarklets } = await signIn(context, { bookmarkletLabel: 'Phone' });
  // Server-side fetches are blocked, as on the real Moxfield; the browser is not.
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Pocket Farm');
  const phone = await (await newContext()).newPage();
  let deckId = '';

  await test.step('on the Moxfield deck page, the bookmarklet posts the deck with the key', async () => {
    await phone.goto(mockMoxfield.deckPageUrl(deck.publicId));
    const post = captureFormPost(phone);
    await runBookmarklet(phone, bookmarklets['same-tab']);
    const request = await post;

    // What real browsers send from https://moxfield.com to an http:// git-moxfield.
    expect(await request.headerValue('origin')).toBe('null');
    const response = await request.response();
    expect(response?.status()).toBe(303);
    expect(await response?.headerValue('location')).toMatch(/^\/api\/auth\/handoff\?next=%2Fdecks%2F/);
  });

  await test.step('a browser that is not signed in yet asks once, naming the account and bookmarklet', async () => {
    await expect(phone).toHaveURL(new RegExp(`^${APP_URL}/signin/bookmarklet\\?next=%2Fdecks%2F`));
    // Nothing is signed in before the click.
    expect((await phone.context().cookies(APP_URL)).map((cookie) => cookie.name)).toEqual([
      '__Host-gm_handoff',
    ]);
    await expect(phone.getByRole('main').getByRole('alert')).toHaveCount(0);
    await expectNoHorizontalOverflow(phone);
    await confirmBookmarkletSignIn(phone, owner.displayName, 'Phone');
    await expect(phone).toHaveURL(CAPTURED_DECK_URL);
    deckId = deckIdFromUrl(phone.url());
  });

  await test.step('the phone is signed in as the owner, on the captured deck', async () => {
    await expect(phone.getByRole('heading', { level: 1, name: 'Pocket Farm' })).toBeVisible();
    await expect(phone.getByRole('status').filter({ hasText: 'Updated from Moxfield' })).toBeVisible();
    await expectSignedInAs(phone, owner.displayName);
    await expectNoHorizontalOverflow(phone);

    // Only the session cookie (and its daily refresh marker) remains; the hand-off cookie is cleared.
    const cookies = await phone.context().cookies(APP_URL);
    expect(cookies.map((cookie) => cookie.name).sort()).toEqual([
      '__Host-gm_session',
      '__Host-gm_session_fresh',
    ]);
    expect(cookies.find((cookie) => cookie.name === '__Host-gm_session')).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      secure: true,
    });
  });

  await test.step('the deck went to the owner’s workspace, and only there', async () => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Pocket Farm' })).toHaveAttribute('href', `/decks/${deckId}`);

    const someoneElse = await newContext();
    await signIn(someoneElse);
    const theirPage = await someoneElse.newPage();
    await theirPage.goto('/');
    await expect(theirPage.getByRole('heading', { level: 1 })).toHaveText(
      'Version history for your Moxfield decks',
    );
    await expect(theirPage.getByText('Pocket Farm')).toHaveCount(0);
  });

  await test.step('running it again goes straight on, keeping the phone’s session', async () => {
    await phone.goto(mockMoxfield.deckPageUrl(deck.publicId));
    await runBookmarklet(phone, bookmarklets['same-tab']);
    // One step: no question for a browser already signed in as the bookmarklet's owner.
    await expect(phone).toHaveURL(`${APP_URL}/decks/${deckId}?captured=1`);
    await expectSignedInAs(phone, owner.displayName);

    // The owner's computer and the phone.
    await page.goto('/account');
    await expect(signedInDevices(page)).toHaveCount(2);
    await expect(signedInDevices(page).filter({ hasText: 'Signed in with the bookmarklet' })).toHaveCount(1);
  });
});

test('rejects a same-tab capture with an unknown bookmarklet key', async ({ page, consoleErrors }) => {
  // The browser reports the rejected form post's status in the console.
  consoleErrors.allowHttpStatus(403);
  const publicId = 'ForgedCaptureDeck00001';
  await mockMoxfield.setDeck({ publicId, name: 'Forged Capture Deck', mainboard: ['Sol Ring'] });
  await page.goto(mockMoxfield.deckPageUrl(publicId));

  const forged = buildBookmarklet({
    appUrl: APP_URL,
    mode: 'same-tab',
    apiBaseUrl: MOCK_MOXFIELD_URL,
    siteOrigin: MOCK_MOXFIELD_URL,
    key: `gmk_${'A'.repeat(43)}`,
  });
  const post = captureFormPost(page);
  await runBookmarklet(page, forged);
  expect((await (await post).response())?.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1, name: 'Reinstall the bookmarklet' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // Nobody was signed in. Connect Moxfield, where bookmarklets are made, asks to sign in first.
  expect(await page.context().cookies(APP_URL)).toEqual([]);
  await page.getByRole('link', { name: 'Open Connect Moxfield' }).click();
  await expect(page).toHaveURL(`${APP_URL}/signin?next=%2Fsetup`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to git-moxfield' })).toBeVisible();
});

test('a page on another site cannot sign a browser in as someone else with their bookmarklet', async ({
  page,
  context,
  newContext,
}) => {
  // Login CSRF (AUTH-1): any member's own key is valid, any page can post it with
  // `Origin: null`, and the browser follows the hand-off redirect with its own cookies.
  const { user: victim } = await signIn(context);
  const { user: attacker, bookmarklets } = await signIn(await newContext(), {
    bookmarkletLabel: 'Totally legit',
  });
  // Another site: 127.0.0.1 vs the app's localhost.
  const attackerPage = `http://127.0.0.1:${MOCK_MOXFIELD_PORT}/free-decklists`;
  await context.route(attackerPage, (route) =>
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: [
        '<!doctype html><meta name="referrer" content="no-referrer"><title>Free decklists</title>',
        `<form method="post" action="${APP_URL}${CAPTURE_FORM_PATH}">`,
        `<input type="hidden" name="token" value="${bookmarkletKey(bookmarklets['same-tab'])}">`,
        '<input type="hidden" name="payload" value=""></form>',
        '<script>document.forms[0].submit()</script>',
      ].join(''),
    }),
  );
  const post = captureFormPost(page);
  // The page submits itself while loading, so its own load never completes.
  await page.goto(attackerPage, { waitUntil: 'commit' });
  const request = await post;
  expect(await request.headerValue('origin')).toBe('null');

  await test.step('the browser lands on git-moxfield’s question, still signed in as the victim', async () => {
    await expect(page).toHaveURL(new RegExp(`^${APP_URL}/signin/bookmarklet\\?next=`));
    await expect(
      page.getByRole('heading', { level: 1, name: `Sign in as ${attacker.displayName}?` }),
    ).toBeVisible();
    await expect(page.getByRole('main')).toContainText('“Totally legit”');
    await expect(page.getByText(`You’re signed in as ${victim.displayName}`)).toBeVisible();
    await expect(
      page.getByText(
        `Signing in as ${attacker.displayName} signs ${victim.displayName} out of this browser.`,
      ),
    ).toBeVisible();
    await expectSignedInAs(page, victim.displayName);
  });

  await test.step('a confirmation forged from another site is refused, while the question is pending', async () => {
    const forged = await page.request.post(`${APP_URL}/api/auth/handoff`, {
      form: { intent: 'confirm', next: '/' },
      headers: { origin: 'http://127.0.0.1:4999' },
      maxRedirects: 0,
    });
    expect(forged.status()).toBe(403);
    await page.reload();
    await expectSignedInAs(page, victim.displayName);
  });
  await test.step('declining keeps the victim signed in, with their session intact', async () => {
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(`${APP_URL}/`);
    await expectSignedInAs(page, victim.displayName);
    await page.goto('/account');
    await expect(page.getByText(`Signed in as ${victim.displayName}`)).toBeVisible();
    await expect(signedInDevices(page)).toHaveCount(1);
  });
});

test('the sign-in hand-off never redirects to another site', async ({ request }) => {
  for (const next of [
    '/.//evil.example/phish',
    '/..//evil.example',
    '/%2e%2e//evil.example',
    '//evil.example',
  ]) {
    const response = await request.get(`/api/auth/handoff?next=${encodeURIComponent(next)}`, {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(303);
    expect(response.headers().location).toBe('/');
  }
});
