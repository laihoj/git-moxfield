/**
 * What a share link grants (ADR 0007): exactly one deck's committed history, read-only,
 * to whoever holds it. Editing the URL reaches nothing else: not the owner's other decks
 * (by deck id, by a commit id prefix in Compare, by a card only they have), not versions
 * the deck does not have, and a token that is not exactly a working link opens nothing at
 * all. A signed-in member who opens someone else's link is a viewer like anyone: the
 * link's pages never act on their account, and their own decks stay their own.
 */
import type { Page } from '@playwright/test';

import { expectSignedInAs, signIn, uniqueName } from './support/accounts';
import { commitVersion, createBlueFarmCopy, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';
import {
  createShareLink,
  expectLinkNotWorking,
  expectNotPartOfSharedDeck,
  expectReadOnlyPage,
  type SharedDeckFacts,
  type ShareLink,
} from './support/share';

/** The abbreviated id of a version, as its page's Details show it. */
async function versionShortId(page: Page, deckId: string, sequence: number): Promise<string> {
  await page.goto(`/decks/${deckId}/versions/${sequence}`);
  const details = page.getByRole('region', { name: 'Details' });
  const shortId = (await details.locator('code').textContent())?.trim() ?? '';
  expect(shortId).toMatch(/^[0-9a-f]{7}$/);
  return shortId;
}

/** Opens Compare of the share link with `from` and `to`, and asserts that a side was not found. */
async function expectCompareSideNotFound(
  page: Page,
  link: ShareLink,
  from: string,
  to: string,
): Promise<void> {
  const path = `${link.path}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  await page.goto(path);
  const alert = page.getByRole('alert').filter({ hasText: 'Could not find one of the sides' });
  await expect(alert, path).toContainText(`“${from}” or “${to}” is not a version of this deck.`);
  await expect(page.getByRole('region', { name: 'Changes' }), path).toHaveCount(0);
}

test('an edited share URL reaches nothing but the shared deck', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Access checks, not layout.');
  // The browser reports each 404 page in the console.
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 404/);
  const { user: owner } = await signIn(context, { displayName: uniqueName('Aino') });

  // The shared deck, and another deck of the same owner with a card only it has.
  const sharedDeck = await createBlueFarmCopy(testInfo, 'Shared Farm');
  const sharedDeckId = await trackDeck(page, mockMoxfield.deckPageUrl(sharedDeck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Shared list' });
  await expect(page.getByText('Committed v1')).toBeVisible();

  const otherDeck = await createBlueFarmCopy(testInfo, 'Private Farm');
  await mockMoxfield.edit(otherDeck.publicId, [
    { op: 'add', zone: 'mainboard', card: { name: 'Secret Tech', typeLine: 'Instant', manaCost: '{U}' } },
  ]);
  const otherDeckId = await trackDeck(page, mockMoxfield.deckPageUrl(otherDeck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Private list' });
  await expect(page.getByText('Committed v1')).toBeVisible();
  // The owner can open the card's page in that deck.
  await page.goto(`/decks/${otherDeckId}/cards/secret%20tech`);
  await expect(page.getByRole('heading', { level: 2, name: 'Secret Tech' })).toBeVisible();

  const sharedShortId = await versionShortId(page, sharedDeckId, 1);
  const otherShortId = await versionShortId(page, otherDeckId, 1);
  const link = await createShareLink(page, sharedDeckId, { label: 'For Mikko' });
  const viewing: SharedDeckFacts = { ownerName: owner.displayName, publicId: sharedDeck.publicId };
  const viewer = await (await newContext()).newPage();

  /** Nothing of the other deck is on the page (its id only where the request itself named it). */
  async function expectNothingOfTheOtherDeck(path: string): Promise<void> {
    await expect(viewer.getByText(/Private Farm|Private list|Secret Tech/), path).toHaveCount(0);
    const content = await viewer.content();
    if (!path.includes(otherDeckId)) expect(content, path).not.toContain(otherDeckId);
    expect(content, path).not.toContain(otherDeck.publicId);
  }

  await test.step('Compare resolves the shared deck’s own commit id prefix', async () => {
    await viewer.goto(`${link.path}/compare?from=empty&to=${sharedShortId}`);
    await expect(viewer.getByRole('combobox', { name: 'To' })).toHaveValue('v1');
    await expect(viewer.getByRole('region', { name: 'Changes' })).toContainText('Dress Down');
  });

  await test.step('Compare finds no side in another deck, nor the current Moxfield deck', async () => {
    for (const [from, to] of [
      [otherShortId, 'v1'],
      ['v1', otherShortId],
      [otherDeckId, 'v1'],
      ['v1', 'working'],
      ['working', 'head'],
      ['v2', 'v1'],
    ] as const) {
      await expectCompareSideNotFound(viewer, link, from, to);
      await expectNothingOfTheOtherDeck(`compare?from=${from}&to=${to}`);
      await expectReadOnlyPage(viewer, link, viewing);
    }
  });

  await test.step('cards and versions the shared deck does not have are not found', async () => {
    await viewer.goto(`${link.path}/cards?q=secret`);
    await expect(viewer.getByText('No cards match “secret”')).toBeVisible();
    for (const path of [
      `${link.path}/cards/secret%20tech`,
      `${link.path}/versions/2`,
      `${link.path}/versions/2?tab=deck`,
      `${link.path}/versions/2/restore`,
      `${link.path}/versions/0`,
      `${link.path}/versions/abc`,
      `${link.path}/decks/${otherDeckId}`,
      `${link.path}/share`,
    ]) {
      await expectNotPartOfSharedDeck(viewer, link, viewing, path);
      await expectNothingOfTheOtherDeck(path);
    }
    const download = await viewer.context().request.get(`${link.path}/versions/2/restore.txt`);
    expect(download.status()).toBe(404);
    expect(await download.text()).toBe('Not found.\n');
  });

  await test.step('a token that is not exactly a working link opens nothing', async () => {
    const token = link.token;
    const last = token.at(-1) === 'A' ? 'B' : 'A';
    const notFound = await expectLinkNotWorking(viewer, `/s/${token.slice(0, -1)}${last}`);
    for (const path of [
      `/s/${token.slice(0, -1)}`,
      `/s/${token}x`,
      `/s/${token.toLowerCase()}`,
      `/s/${token.replace('gmv_', 'gmk_')}`,
      `/s/${sharedDeckId}`,
      `/s/${otherDeckId}/history`,
      `/s/${token.slice(0, -1)}${last}/versions/1/restore`,
    ]) {
      expect(await expectLinkNotWorking(viewer, path), path).toBe(notFound);
    }
    const download = await viewer
      .context()
      .request.get(`/s/${token.slice(0, -1)}${last}/versions/1/restore.txt`);
    expect(download.status()).toBe(404);
    expect(await download.text()).toBe('Not found.\n');
  });

  await test.step('the owner’s own pages are not reachable through the link', async () => {
    // A signed-out viewer is asked to sign in, and sees nothing of the deck.
    await viewer.goto(`/decks/${sharedDeckId}/history`);
    await expect(viewer).toHaveURL(`/signin?next=${encodeURIComponent(`/decks/${sharedDeckId}`)}`);
    await expect(viewer.getByText(/Shared Farm|Shared list/)).toHaveCount(0);
  });
});

test('a signed-in member opening someone else’s link only views it, and keeps their own decks', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Access checks, not layout.');
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 404/);
  const { user: owner } = await signIn(context, { displayName: uniqueName('Aino') });
  const ownerDeck = await createBlueFarmCopy(testInfo, 'Aino’s Farm');
  const ownerDeckId = await trackDeck(page, mockMoxfield.deckPageUrl(ownerDeck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Aino’s list' });
  await expect(page.getByText('Committed v1')).toBeVisible();
  const link = await createShareLink(page, ownerDeckId, { label: 'For Mikko' });

  const memberContext = await newContext();
  const { user: member } = await signIn(memberContext, { displayName: uniqueName('Mikko') });
  const memberPage = await memberContext.newPage();
  const memberDeck = await createBlueFarmCopy(testInfo, 'Mikko’s Farm');
  const memberDeckId = await trackDeck(memberPage, mockMoxfield.deckPageUrl(memberDeck.publicId));
  await commitVersion(memberPage, { sequence: 1, message: 'Mikko’s list' });
  await expect(memberPage.getByText('Committed v1')).toBeVisible();

  await test.step('the member sees the shared deck read-only, without their account', async () => {
    for (const path of [
      link.path,
      `${link.path}/history`,
      `${link.path}/versions/1`,
      `${link.path}/versions/1/restore`,
      `${link.path}/compare`,
      `${link.path}/cards?q=dress`,
    ]) {
      await memberPage.goto(path);
      await expect(memberPage.getByRole('heading', { level: 1, name: 'Aino’s Farm' }), path).toBeVisible();
      await expectReadOnlyPage(memberPage, link, {
        ownerName: owner.displayName,
        publicId: ownerDeck.publicId,
      });
      // The link's pages never look at who is signed in.
      await expect(memberPage.getByText(member.displayName), path).toHaveCount(0);
      await expect(memberPage.getByText(/Mikko’s Farm|Mikko’s list/), path).toHaveCount(0);
    }
  });

  await test.step('the member is still signed in, with their own decks only', async () => {
    await memberPage.goto('/');
    await expectSignedInAs(memberPage, member.displayName);
    await expect(memberPage.getByRole('link', { name: 'Mikko’s Farm' })).toBeVisible();
    await expect(memberPage.getByText('Aino’s Farm')).toHaveCount(0);
    await memberPage.goto(`/decks/${memberDeckId}`);
    await expect(memberPage.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
    await expect(memberPage.getByRole('link', { name: 'v1: Mikko’s list' })).toBeVisible();
  });

  await test.step('the link gives the member no owner access to the shared deck', async () => {
    for (const path of [`/decks/${ownerDeckId}`, `/decks/${ownerDeckId}/share`]) {
      const response = await memberPage.goto(path);
      expect(response?.status(), path).toBe(404);
      await expect(
        memberPage.getByRole('heading', { level: 1, name: 'We couldn’t find that' }),
      ).toBeVisible();
      await expect(memberPage.getByText(/Aino’s Farm|For Mikko/)).toHaveCount(0);
    }
  });

  await test.step('the owner’s deck and link are unchanged', async () => {
    await page.goto(`/decks/${ownerDeckId}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
    await page.goto(`/decks/${ownerDeckId}/share`);
    await expect(page.getByRole('list', { name: 'Share links' })).toContainText('For Mikko');
    await expect(page.getByRole('list', { name: 'Share links' })).toContainText('Last viewed');
  });
});
