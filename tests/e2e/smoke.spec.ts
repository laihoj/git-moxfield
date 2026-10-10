/**
 * Smoke tests of the e2e environment itself: the app and the mock Moxfield are up, and
 * a user's bookmarklet runs on the mock deck page against the mock API. User journeys
 * live in their own spec files.
 */
import { signIn } from './support/accounts';
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import { expect, test } from './support/fixtures';
import { BLUE_FARM_PUBLIC_ID, mockMoxfield } from './support/mock';

test('a signed-out visitor is asked to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/signin');
  await expect(page).toHaveTitle('Sign in · git-moxfield');
  await expect(page.getByRole('link', { name: 'git-moxfield' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to git-moxfield' })).toBeVisible();
  // Signed out, the header has no navigation, and the claimed installation offers no setup.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Set up git-moxfield' })).toHaveCount(0);
});

test('the mock Moxfield deck page loads', async ({ page }) => {
  await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));
  await expect(page).toHaveTitle(/^Blue Farm \/\/ .*Moxfield/);
  await expect(page.getByRole('heading', { level: 1, name: 'Blue Farm' })).toBeVisible();
  await expect(page.getByText('Mock Moxfield deck page')).toBeVisible();
});

test('the bookmarklet reads the deck as the browser and opens the capture page', async ({
  page,
  context,
}) => {
  const { bookmarklets } = await signIn(context, { bookmarkletLabel: 'Smoke test' });
  // Server-side fetches are blocked, as on the real Moxfield; the browser is not.
  await mockMoxfield.setMode('blocked');
  await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));

  // The capture page hands the deck to the server; registered on the context before the
  // popup exists. Awaited below so the test never ends with that upload in flight.
  const handedOver = context.waitForEvent(
    'response',
    (response) => new URL(response.url()).pathname === '/api/capture',
  );
  const capturePage = await runBookmarklet(page, bookmarklets.popup);
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
