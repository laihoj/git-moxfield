/**
 * Moxfield's limits, end to end (ADR 0009): a refusal pauses server fetching for every
 * instance until an admin resumes it on the Admin page, and a 429 holds back every refresh
 * until Moxfield's Retry-After has passed. Nothing is fetched in the background meanwhile.
 * (The e2e reset hook clears the shared limiter before each test.)
 */
import { signIn } from './support/accounts';
import { createBlueFarmCopy, expectNoHorizontalOverflow, statusHeading, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('a refusal pauses server fetching until an admin resumes it', async ({ page, context }, testInfo) => {
  await signIn(context, { role: 'admin' });
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Paused Farm');
  let deckId = '';

  await test.step('the refusal pauses server fetching, also once Moxfield would answer again', async () => {
    deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
    await expect(page.getByText('Moxfield blocked the server')).toBeVisible();
    await expect(page.getByText(/paused for everyone until an admin resumes it/)).toBeVisible();
    await mockMoxfield.setMode('ok');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Update from Moxfield' })).toBeVisible();
  });

  await test.step('Connect Moxfield says why and since when', async () => {
    await page.goto('/setup');
    await expect(page.getByText('Server fetch: paused', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Moxfield's bot protection answered a request \(HTTP 403/)).toBeVisible();
    await expect(
      page.getByText(/^Paused since .*, until an admin resumes it on the Admin page\.$/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin', exact: true }).last()).toHaveAttribute(
      'href',
      '/admin',
    );
    await expectNoHorizontalOverflow(page);
  });

  await test.step('an admin resumes it on the Admin page', async () => {
    await page.goto('/admin');
    const card = page.getByRole('region', { name: 'Server fetching from Moxfield' });
    await expect(card).toContainText('Paused until you resume it');
    await expect(card).toContainText("Moxfield's bot protection answered a request (HTTP 403");
    await expectNoHorizontalOverflow(page);
    await card.getByRole('button', { name: 'Resume server fetching from Moxfield' }).click();
    await card.getByRole('button', { name: 'Resume server fetching' }).click();
    await expect(card).not.toContainText('Paused until you resume it');
    await expect(card.getByRole('button', { name: 'Resume server fetching from Moxfield' })).toHaveCount(0);
    await expect(card).toContainText('Never rate limited');
  });

  await test.step('refreshing fetches the deck again', async () => {
    await page.goto(`/decks/${deckId}`);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Paused Farm' })).toBeVisible();
    await expect(statusHeading(page, 'Not committed yet')).toBeVisible();
  });
});

test("a 429 holds back every refresh until Moxfield's Retry-After has passed", async ({
  page,
  context,
}, testInfo) => {
  await signIn(context);
  const deck = await createBlueFarmCopy(testInfo, 'Slow Farm');
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await expect(statusHeading(page, 'Not committed yet')).toBeVisible();

  await mockMoxfield.setMode('rate-limited'); // 429 with Retry-After: 30
  await page.getByRole('button', { name: 'Refresh' }).click();
  const main = page.getByRole('main');
  await expect(main.getByText('Moxfield asked us to slow down')).toBeVisible();
  await expect(main.getByText(/slow down \(HTTP 429\)\. Server fetches wait 30 s/)).toBeVisible();
  const requests = (await mockMoxfield.requests()).length;

  // The deck page offers the bookmarklet instead of refreshing until then.
  await page.goto(`/decks/${deckId}`);
  await expect(page.getByRole('main').getByText(/Try again in about 1 min\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Update from Moxfield' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto('/setup');
  await expect(page.getByText('Server fetch: slowed down by Moxfield')).toBeVisible();
  // Opening pages never asked Moxfield.
  expect(await mockMoxfield.requests()).toHaveLength(requests);
});
