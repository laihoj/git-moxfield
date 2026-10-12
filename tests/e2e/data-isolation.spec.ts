/**
 * Private decks (ADR 0006 and 0007): every user's decks live in a workspace of their
 * own. Nobody else can list them or open any of their pages: another user's deck id
 * behaves exactly like one that does not exist (404, nothing about the deck rendered).
 * Signed-out visitors are sent to sign in, and on to the deck afterwards.
 */
import { createDeviceLink, expectSignedInAs, signIn, signInWithLink, uniqueName } from './support/accounts';
import { trackAndCommitV1, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('one person’s decks are invisible to everyone else', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  // The browser reports each 404 page in the console.
  consoleErrors.allowHttpStatus(404);
  const { user: alice } = await signIn(context, { displayName: uniqueName('Alice') });
  const { deck, deckId } = await trackAndCommitV1(page, testInfo, {
    name: 'Private Farm',
    message: 'Secret tech',
    confirm: 'status',
  });
  const moxfieldUrl = mockMoxfield.deckPageUrl(deck.publicId);

  const bobContext = await newContext();
  const { user: bob } = await signIn(bobContext, { displayName: uniqueName('Bob') });
  const bobPage = await bobContext.newPage();

  await test.step('Alice’s decks are not listed for Bob', async () => {
    await bobPage.goto('/');
    await expectSignedInAs(bobPage, bob.displayName);
    await expect(bobPage.getByRole('heading', { level: 1 })).toHaveText(
      'Version history for your Moxfield decks',
    );
    await expect(bobPage.getByText('Private Farm')).toHaveCount(0);
  });

  await test.step('Bob cannot open any page of Alice’s deck', async () => {
    const pages = [
      `/decks/${deckId}`,
      `/decks/${deckId}/history`,
      `/decks/${deckId}/versions/1`,
      `/decks/${deckId}/versions/1?tab=deck`,
      `/decks/${deckId}/versions/1?tab=primer`,
      `/decks/${deckId}/versions/1/restore`,
      `/decks/${deckId}/compare?from=v1&to=working`,
      `/decks/${deckId}/cards`,
      `/decks/${deckId}/cards/dress%20down`,
    ];
    for (const path of pages) {
      const response = await bobPage.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(
        bobPage.getByRole('heading', { level: 1, name: 'We couldn’t find that' }),
        path,
      ).toBeVisible();
      await expect(bobPage.getByText(/Private Farm|Secret tech/), path).toHaveCount(0);
    }
    const download = await bobContext.request.get(`/decks/${deckId}/versions/1/restore.txt`);
    expect(download.status()).toBe(404);
    expect(await download.text()).not.toContain('Private Farm');
  });

  await test.step('Bob tracking the same Moxfield deck gets a deck of his own', async () => {
    const bobsDeckId = await trackDeck(bobPage, moxfieldUrl);
    expect(bobsDeckId).not.toBe(deckId);
    await expect(bobPage.getByRole('heading', { level: 2, name: 'Not committed yet' })).toBeVisible();
    await expect(bobPage.getByText('Secret tech')).toHaveCount(0);

    // Alice's deck is unchanged.
    await page.goto(`/decks/${deckId}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
  });

  await test.step('a signed-out visitor is sent to sign in, then on to the deck', async () => {
    const laptop = await (await newContext()).newPage();
    // Any page of a deck returns to the deck itself after signing in.
    await laptop.goto(`/decks/${deckId}/history`);
    await expect(laptop).toHaveURL(`/signin?next=${encodeURIComponent(`/decks/${deckId}`)}`);
    await expect(laptop.getByText(/Private Farm|Secret tech/)).toHaveCount(0);

    // Alice signs the laptop in from another tab with a device link. Back on the sign-in
    // tab (re-rendered when it is shown again; headless tabs are never hidden, so here by
    // reloading), a signed-in browser moves on to the deck.
    const link = await createDeviceLink(page);
    const linkTab = await laptop.context().newPage();
    await signInWithLink(linkTab, link, alice.displayName);
    await linkTab.close();
    await laptop.reload();
    await expect(laptop).toHaveURL(`/decks/${deckId}`);
    await expect(laptop.getByRole('heading', { level: 1, name: 'Private Farm' })).toBeVisible();
    await expectSignedInAs(laptop, alice.displayName);
  });
});
