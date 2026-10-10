/**
 * Smoke tests of the e2e environment itself: the app and the mock Moxfield are up, and
 * the bookmarklet runs on the mock deck page against the mock API. User journeys live in
 * their own spec files.
 */
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import { expect, test } from './support/fixtures';
import { BLUE_FARM_PUBLIC_ID, mockMoxfield } from './support/mock';

test('the home page shows the app name', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/git-moxfield/);
  await expect(page.getByText(/git-moxfield/).first()).toBeVisible();
});

test('the mock Moxfield deck page loads', async ({ page }) => {
  await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));
  await expect(page).toHaveTitle(/^Blue Farm \/\/ .*Moxfield/);
  await expect(page.getByRole('heading', { level: 1, name: 'Blue Farm' })).toBeVisible();
  await expect(page.getByText('Mock Moxfield deck page')).toBeVisible();
});

test('the bookmarklet reads the deck as the browser and opens the capture page', async ({ page }) => {
  // Server-side fetches are blocked, as on the real Moxfield; the browser is not.
  await mockMoxfield.setMode('blocked');
  await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));

  // The capture page hands the deck to the server; registered on the context before the
  // popup exists. Awaited below so the test never ends with that upload in flight.
  const handedOver = page
    .context()
    .waitForEvent('response', (response) => new URL(response.url()).pathname === '/api/capture');
  const capturePage = await runBookmarklet(page, { mode: 'popup' });
  expect(capturePage.url()).toMatch(new RegExp(`^${APP_URL}/capture#n=[0-9a-f]{32}$`));

  await expect
    .poll(async () =>
      (await mockMoxfield.requests())
        .filter((request) => request.client === 'browser' && request.path.startsWith('/v'))
        .map((request) => `${request.status} ${request.path}`),
    )
    .toEqual([
      `200 /v3/decks/all/${BLUE_FARM_PUBLIC_ID}`,
      expect.stringMatching(/^200 \/v1\/decks\/[\w-]+\/primer$/),
    ]);
  // The deck is not tracked yet, so the server answers with the `untracked` outcome.
  expect((await handedOver).status()).toBe(200);
  // Let the capture page finish rendering (and prefetching) before the context closes.
  await capturePage.waitForLoadState('networkidle');
});
