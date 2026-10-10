/**
 * Same-tab capture (phones and in-app browsers): the bookmarklet reads the deck on the
 * Moxfield deck page and posts it as a form to git-moxfield in the same tab, which
 * tracks the deck and opens it.
 *
 * The mock deck page makes the browser send `Origin: null` with that form post, as the
 * real https://moxfield.com does when posting to an http:// git-moxfield. What protects
 * the endpoint is the installation's capture token in the bookmarklet.
 */
import type { Page, Request } from '@playwright/test';

import { buildBookmarklet } from '@/integrations/moxfield/capture';
import { CAPTURE_FORM_PATH } from '@/integrations/moxfield/capture-protocol';

import { runBookmarklet } from './support/bookmarklet';
import { APP_URL, MOCK_MOXFIELD_URL } from './support/constants';
import { expect, test } from './support/fixtures';
import { BLUE_FARM_PUBLIC_ID, mockMoxfield } from './support/mock';

function isCaptureFormPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === CAPTURE_FORM_PATH;
}

/** Waits for the bookmarklet's form post from `page` and its response. */
function captureFormPost(page: Page): Promise<Request> {
  return page.waitForRequest(isCaptureFormPost);
}

test('sends a deck in the same tab and opens it in git-moxfield', async ({ page }) => {
  // Server-side fetches are blocked, as on the real Moxfield; the browser is not.
  await mockMoxfield.setMode('blocked');
  await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));

  const post = captureFormPost(page);
  await runBookmarklet(page, { mode: 'same-tab' });
  const request = await post;

  // What real browsers send from https://moxfield.com to an http:// git-moxfield.
  expect(await request.headerValue('origin')).toBe('null');
  expect((await request.response())?.status()).toBe(303);

  await expect(page).toHaveURL(new RegExp(`^${APP_URL}/decks/[^/?#]+\\?captured=1$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Blue Farm' })).toBeVisible();
});

test('rejects a same-tab capture without this installation’s capture token', async ({
  page,
  consoleErrors,
}) => {
  // The browser reports the rejected form post's status in the console.
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 403/);
  const publicId = 'ForgedCaptureDeck00001';
  await mockMoxfield.setDeck({ publicId, name: 'Forged Capture Deck', mainboard: ['Sol Ring'] });
  await page.goto(mockMoxfield.deckPageUrl(publicId));

  const forged = buildBookmarklet({
    appUrl: APP_URL,
    mode: 'same-tab',
    apiBaseUrl: MOCK_MOXFIELD_URL,
    siteOrigin: MOCK_MOXFIELD_URL,
    captureToken: '0'.repeat(64),
  });
  const post = captureFormPost(page);
  await runBookmarklet(page, { mode: 'same-tab', bookmarklet: forged });
  expect((await (await post).response())?.status()).toBe(403);
  await expect(page.getByRole('heading', { level: 1, name: 'Reinstall the bookmarklet' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Connect Moxfield' }).click();
  await expect(page).toHaveURL(`${APP_URL}/setup`);

  // Nothing was tracked.
  await page.goto('/');
  await expect(page.getByText('Forged Capture Deck')).toHaveCount(0);
});
