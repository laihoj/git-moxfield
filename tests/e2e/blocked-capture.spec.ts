/**
 * Journey 2, the usual situation with the real Moxfield: it blocks server-side fetches
 * (Cloudflare), so the deck arrives through the bookmarklet instead. Tracking the deck
 * runs into the block, the deck page explains what to do, the user opens the deck on
 * Moxfield with "Update from Moxfield" and runs the same-tab bookmarklet (as on a phone)
 * taken from the setup page, which sends the deck and lands on its git-moxfield page.
 * Committing works without the server ever reaching Moxfield.
 */
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import {
  commitVersion,
  createBlueFarmCopy,
  deckIdFromUrl,
  expectNoHorizontalOverflow,
  trackDeck,
} from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('a blocked deck is sent with the same-tab bookmarklet and committed', async ({
  page,
  context,
}, testInfo) => {
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Blocked Farm');
  const moxfieldDeckUrl = mockMoxfield.deckPageUrl(deck.publicId);
  let deckId = '';

  await test.step('tracking runs into the block and the deck page shows what to do', async () => {
    deckId = await trackDeck(page, moxfieldDeckUrl);
    // The name is unknown until Moxfield's data arrives.
    await expect(page.getByRole('heading', { level: 1, name: 'New Moxfield deck' })).toBeVisible();
    await expect(page.getByText(deck.publicId)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 2, name: 'Waiting for the first snapshot from Moxfield' }),
    ).toBeVisible();

    await expect(page.getByText('Moxfield blocked the server')).toBeVisible();
    await expect(page.getByText(/Moxfield is blocking server-side requests/)).toBeVisible();

    // Server fetching is paused, so refreshing becomes "Update from Moxfield" via the bookmarklet.
    await expect(page.getByRole('button', { name: 'Refresh' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Update from Moxfield' })).toHaveAttribute(
      'href',
      moxfieldDeckUrl,
    );
    const steps = page.getByRole('listitem');
    await expect(
      steps.filter({ hasText: 'Open the deck on Moxfield with Update from Moxfield.' }),
    ).toBeVisible();
    await expect(
      steps.filter({ hasText: 'Click the Send to git-moxfield bookmarklet there.' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set it up' })).toHaveAttribute('href', '/setup');
    await expect(steps.filter({ hasText: 'Or paste the deck JSON' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'paste instead' })).toHaveAttribute(
      'href',
      '/capture?mode=paste',
    );
    // Each next step is offered once.
    await expect(page.getByRole('link', { name: 'Open deck in Moxfield' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Commit v/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  await test.step('Update from Moxfield opens the deck on Moxfield; the bookmarklet sends it back', async () => {
    const [moxfieldTab] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: 'Update from Moxfield' }).click(),
    ]);
    await moxfieldTab.waitForURL(moxfieldDeckUrl);
    await expect(moxfieldTab.getByRole('heading', { level: 1, name: 'Blocked Farm' })).toBeVisible();

    // The bookmarklet from the setup page carries this installation's capture token.
    await runBookmarklet(moxfieldTab, { mode: 'same-tab' });
    await expect(moxfieldTab).toHaveURL(`${APP_URL}/decks/${deckId}?captured=1`);
    expect(deckIdFromUrl(moxfieldTab.url())).toBe(deckId);

    const captured = moxfieldTab.getByRole('status').filter({ hasText: 'Updated from Moxfield' });
    await expect(captured).toContainText(
      'The deck sent from your browser is now the current Moxfield state below.',
    );
    await expect(moxfieldTab.getByRole('heading', { level: 1, name: 'Blocked Farm' })).toBeVisible();
    await expect(moxfieldTab.getByRole('heading', { level: 2, name: 'Not committed yet' })).toBeVisible();
    await expect(moxfieldTab.getByRole('list', { name: 'Moxfield activity' })).toContainText(
      'sent from your browser just now',
    );
    await expect(moxfieldTab.getByRole('list', { name: 'Versions' })).toContainText('Moxfield version 100');
    await expect(moxfieldTab.getByRole('region', { name: 'Initial version' })).toContainText(
      '100 cards in the deck. All of it becomes v1.',
    );
    // The old block is history now; the pause note remains, with the way forward.
    await expect(moxfieldTab.getByText('Moxfield blocked the server')).toHaveCount(0);
    await expect(
      moxfieldTab.getByText(/Moxfield blocked server-side fetching, so it is paused until/),
    ).toBeVisible();
    await expectNoHorizontalOverflow(moxfieldTab);

    // Dismissing the confirmation keeps the deck page.
    await captured.getByRole('link', { name: 'Dismiss' }).click();
    await expect(moxfieldTab).toHaveURL(`${APP_URL}/decks/${deckId}`);
    await expect(captured).toHaveCount(0);
    await moxfieldTab.close();
  });

  await test.step('commit the captured deck', async () => {
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Blocked Farm' })).toBeVisible();
    await commitVersion(page, { sequence: 1, message: 'Captured from the browser' });
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();

    await page.goto(`/decks/${deckId}/versions/1`);
    await expect(
      page.getByRole('heading', { level: 2, name: 'v1: Captured from the browser' }),
    ).toBeVisible();
    await expect(page.getByText('Sent with the bookmarklet')).toBeVisible();
  });

  // The server never fetched the deck successfully: every server request was blocked.
  const requests = (await mockMoxfield.requests()).filter((request) => request.path.includes(deck.publicId));
  expect(requests.filter((request) => request.client === 'server').map((request) => request.status)).toEqual([
    403,
  ]);
  expect(
    requests
      .filter((request) => request.client === 'browser' && request.path.startsWith('/v3/'))
      .map((r) => r.status),
  ).toEqual([200]);
});
