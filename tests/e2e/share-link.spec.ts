/**
 * Read-only share links (ADR 0007), the journey: an owner shares a deck with a friend who
 * has no account. The friend follows the deck's committed history through every view
 * (overview, history, a version's changes, deck and primer, compare, card history and
 * restore, copying a block and downloading the restore text), in the same deck pages the
 * owner has, minus every control that changes something, under a read-only banner. The
 * deck's uncommitted Moxfield state (here a rename and a new card) never shows, and
 * viewing never fetches from Moxfield. Version notes are shown only through links created
 * with "Include my version notes".
 */
import type { Locator, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { signIn, uniqueName } from './support/accounts';
import { APP_URL } from './support/constants';
import { commitVersion, createBlueFarmCopy, expectNoHorizontalOverflow, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';
import {
  createShareLink,
  deckNav,
  expectNotPartOfSharedDeck,
  expectPrivatePage,
  expectReadOnlyPage,
  shareLinkRow,
  type SharedDeckFacts,
  type ShareLink,
} from './support/share';

const DECK_NAME = 'Shared Farm';
const UNCOMMITTED_NAME = 'Renamed On Moxfield';
const UNCOMMITTED_CARD = 'Uncommitted Tech';

function statusHeading(page: Page, label: string): Locator {
  return page.getByRole('heading', { level: 2, name: label });
}

/** Asserts the accessible names (`v2: message`) of a list of version links, in order. */
async function expectVersionLinks(links: Locator, names: readonly string[]): Promise<void> {
  await expect(links).toHaveCount(names.length);
  for (const [index, name] of names.entries()) await expect(links.nth(index)).toHaveAccessibleName(name);
}

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The Moxfield-facing requests git-moxfield's server made since the test began. */
async function serverFetchCount(): Promise<number> {
  return (await mockMoxfield.requests()).filter((request) => request.client === 'server').length;
}

/** On a phone, the deck's tabs are a bottom bar: Overview first, and nothing hides behind it. */
async function expectPhoneLayout(page: Page, isMobile: boolean, activeTab: string): Promise<void> {
  await expectNoHorizontalOverflow(page);
  if (!isMobile) return;
  const nav = deckNav(page);
  const viewport = page.viewportSize();
  const rect = await nav.boundingBox();
  if (viewport === null || rect === null) throw new Error('No viewport or bottom bar');
  expect(rect.y + rect.height).toBeCloseTo(viewport.height, 0);
  await expect(nav.getByRole('link', { name: activeTab })).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const footer = await page.getByRole('contentinfo').boundingBox();
  const bar = await nav.boundingBox();
  if (footer === null || bar === null) throw new Error('No footer or bottom bar');
  expect(footer.y + footer.height).toBeLessThanOrEqual(bar.y + 0.5);
}

test('a friend without an account follows a shared deck’s history, read-only', async ({
  page,
  context,
  newContext,
}, testInfo) => {
  const isMobile = testInfo.project.name === 'mobile';
  const { user: owner } = await signIn(context, { displayName: uniqueName('Aino') });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
  const deck = await createBlueFarmCopy(testInfo, DECK_NAME);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  const viewing: SharedDeckFacts = { ownerName: owner.displayName, publicId: deck.publicId };
  let link: ShareLink | undefined;

  await test.step('the owner commits two versions, then changes the deck on Moxfield', async () => {
    await commitVersion(page, { sequence: 1, message: 'Tournament list', tags: ['tournament'] });
    await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();
    await mockMoxfield.edit(deck.publicId, [
      { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
      {
        op: 'add',
        zone: 'mainboard',
        card: { name: 'Final Fortune', typeLine: 'Instant', manaCost: '{R}{R}' },
      },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
    await commitVersion(page, { sequence: 2, message: 'Testing Final Fortune', tags: ['testing'] });
    await expect(statusHeading(page, 'Up to date with v2')).toBeVisible();

    // Not committed: a new name and a new card, which viewers must never see.
    await mockMoxfield.edit(deck.publicId, [
      { op: 'rename', name: UNCOMMITTED_NAME },
      {
        op: 'add',
        zone: 'mainboard',
        card: { name: UNCOMMITTED_CARD, typeLine: 'Instant', manaCost: '{U}' },
      },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: UNCOMMITTED_NAME })).toBeVisible();
  });

  await test.step('the owner creates a link from the deck header, copies it, and it is shown once', async () => {
    const share = page.getByRole('link', { name: 'Share', exact: true });
    await share.click();
    await expect(page).toHaveURL(`/decks/${deckId}/share`);
    await expect(share).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 2, name: 'Share this deck' })).toBeVisible();
    await expect(page.getByText('No links yet')).toBeVisible();
    const explainer = page.getByRole('region', { name: 'What people with a link see' });
    await expect(explainer.getByRole('list', { name: 'Never shown' })).toContainText(
      'Uncommitted changes on Moxfield',
    );
    // The banner names the owner on every page of a link: the owner is told so.
    await expect(explainer.getByRole('list', { name: 'Shown', exact: true })).toContainText(
      `Your name, “${owner.displayName}”, as who shared the deck`,
    );
    await expectNoHorizontalOverflow(page);

    link = await createShareLink(page, deckId, {
      label: 'For Mikko',
      whileShown: async (panel, created) => {
        await panel.getByRole('button', { name: 'Copy link' }).click();
        await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
        expect(await clipboard(page)).toBe(created.url);
        await expectNoHorizontalOverflow(page);
      },
    });
    const row = shareLinkRow(page, 'For Mikko');
    await expect(row).toContainText('Not viewed yet');
    await expect(row.getByText('Includes notes')).toHaveCount(0);

    // Only a fingerprint is kept: the URL is in no page the owner can open again.
    await page.reload();
    await expect(shareLinkRow(page, 'For Mikko')).toBeVisible();
    expect(await page.content()).not.toContain(link.token);
  });
  if (link === undefined) throw new Error('No link was created');
  const shared = link;
  const fetchesBeforeViewing = await serverFetchCount();

  const friendContext = await newContext();
  await friendContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
  const friend = await friendContext.newPage();

  await test.step('a signed-out friend opens it: the latest version and what changed', async () => {
    const response = await friend.goto(shared.url);
    expect(response?.status()).toBe(200);
    await expectPrivatePage(friend, response);
    await expect(friend).toHaveTitle(`${DECK_NAME} · git-moxfield`);
    await expect(friend.getByRole('heading', { level: 1, name: DECK_NAME })).toBeVisible();
    await expect(friend.getByText(UNCOMMITTED_NAME)).toHaveCount(0);
    await expect(deckNav(friend).getByRole('link')).toHaveText(['Overview', 'History', 'Compare', 'Cards']);
    await expect(deckNav(friend).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await expect(friend.getByRole('heading', { level: 2, name: 'v2: Testing Final Fortune' })).toBeVisible();
    const changes = friend.getByRole('region', { name: 'Changes since v1' });
    await expect(changes).toContainText('2 changes');
    await expect(changes).toContainText('Added: Final Fortune');
    await expect(changes).toContainText('Moved from Mainboard to Considering: Dress Down');
    await expect(friend.getByText(UNCOMMITTED_CARD)).toHaveCount(0);
    const versions = friend.getByRole('complementary', { name: 'Versions' });
    await expectVersionLinks(versions.getByRole('link', { name: /^v\d+: / }), [
      'v2: Testing Final Fortune',
      'v1: Tournament list',
    ]);
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'Overview');
  });

  await test.step('History lists both versions with their tags and filters by tag', async () => {
    await deckNav(friend).getByRole('link', { name: 'History' }).click();
    await expect(friend).toHaveURL(`${shared.path}/history`);
    await expect(friend.getByText('2 versions. Select two to compare them.')).toBeVisible();
    const versionLinks = friend.getByRole('main').getByRole('link', { name: /^v\d+: / });
    await expectVersionLinks(versionLinks, ['v2: Testing Final Fortune', 'v1: Tournament list']);
    const v1 = friend
      .getByRole('listitem')
      .filter({ has: friend.getByRole('link', { name: 'v1: Tournament list' }) });
    await expect(v1.getByRole('list', { name: 'Tags' })).toHaveText('tournament');

    // Selecting one version offers its previous version, never the current Moxfield deck.
    await friend.getByRole('checkbox', { name: 'Select v2 to compare' }).check();
    const selection = friend.getByRole('region', { name: 'Compare selected versions' });
    await expect(selection.getByRole('link', { name: 'With previous' })).toHaveAttribute(
      'href',
      `${shared.path}/compare?from=v1&to=v2`,
    );
    await expect(selection.getByRole('link', { name: 'With current Moxfield deck' })).toHaveCount(0);
    await selection.getByRole('button', { name: 'Clear selection' }).click();

    await friend
      .getByRole('navigation', { name: 'Filter by tag' })
      .getByRole('link', { name: /tournament/ })
      .click();
    await expect(friend).toHaveURL(`${shared.path}/history?tag=tournament`);
    await expect(friend.getByText('1 version tagged “tournament”')).toBeVisible();
    await expectVersionLinks(versionLinks, ['v1: Tournament list']);
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'History');
  });

  await test.step('a version’s changes, deck and primer, with read-only tags and no notes', async () => {
    await friend.goto(`${shared.path}/history`);
    await friend.getByRole('link', { name: 'v2: Testing Final Fortune' }).click();
    await expect(friend).toHaveURL(`${shared.path}/versions/2`);
    await expect(friend.getByRole('heading', { level: 2, name: 'v2: Testing Final Fortune' })).toBeVisible();
    await expect(friend.getByRole('main').getByRole('list', { name: 'Tags' })).toHaveText('testing');
    // The link was created without notes: there is no Notes card at all.
    await expect(friend.getByRole('heading', { name: 'Notes' })).toHaveCount(0);
    const tabs = friend.getByRole('navigation', { name: 'Version content' });
    await expect(tabs.getByRole('link', { name: /^Changes/ })).toHaveAttribute('aria-current', 'page');
    await expect(friend.getByRole('region', { name: 'Changes since v1' })).toContainText(
      'Added: Final Fortune',
    );
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'History');

    await tabs.getByRole('link', { name: /^Deck/ }).click();
    await expect(friend).toHaveURL(`${shared.path}/versions/2?tab=deck`);
    const deckList = friend.getByRole('region', { name: 'Deck list' });
    await expect(deckList.getByRole('region', { name: /^Mainboard/ })).toContainText('Final Fortune');
    await expect(deckList.getByRole('region', { name: /^Considering/ })).toContainText('Dress Down');
    await expect(deckList).not.toContainText(UNCOMMITTED_CARD);
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'History');

    await tabs.getByRole('link', { name: /^Primer/ }).click();
    await expect(friend).toHaveURL(`${shared.path}/versions/2?tab=primer`);
    const primer = friend.getByRole('region', { name: 'Primer' });
    await expect(primer.getByRole('heading', { name: 'Win conditions' })).toBeVisible();
    await primer.getByRole('button', { name: 'Copy primer' }).click();
    await expect(primer.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(friend)).toContain('Win conditions');
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'History');

    // The version's comparisons: with the previous version, never with the current Moxfield deck.
    await friend.getByRole('button', { name: 'Compare', exact: true }).click();
    const menu = friend.getByRole('menu', { name: 'Compare this version' });
    await expect(menu.getByRole('menuitem')).toHaveCount(1);
    await expect(menu.getByRole('menuitem')).toContainText('With previous (v1)');
    await menu.getByRole('menuitem').click();
    await expect(friend).toHaveURL(`${shared.path}/compare?from=v1&to=v2`);
  });

  await test.step('Compare picks any two committed versions, never the current Moxfield deck', async () => {
    await deckNav(friend).getByRole('link', { name: 'Compare' }).click();
    await expect(friend).toHaveURL(`${shared.path}/compare`);
    const from = friend.getByRole('combobox', { name: 'From' });
    await expect(from).toHaveValue('v1');
    await expect(friend.getByRole('combobox', { name: 'To' })).toHaveValue('v2');
    await expect(from.locator('option')).toHaveText([
      'v2 · Testing Final Fortune',
      'v1 · Tournament list',
      'Empty deck',
    ]);
    const changes = friend.getByRole('region', { name: 'Changes' });
    await expect(changes).toContainText('2 changes');
    await expect(changes).toContainText('Added: Final Fortune');

    // The pickers submit within the share link.
    await from.selectOption('empty');
    await friend.getByRole('button', { name: 'Compare', exact: true }).click();
    await expect(friend).toHaveURL(`${shared.path}/compare?from=empty&to=v2`);
    await expect(friend.getByRole('region', { name: 'Changes' })).toContainText('Final Fortune');
    await expect(friend.getByText(UNCOMMITTED_CARD)).toHaveCount(0);
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'Compare');
  });

  await test.step('a card’s history covers committed versions only', async () => {
    await deckNav(friend).getByRole('link', { name: 'Cards' }).click();
    await expect(friend).toHaveURL(`${shared.path}/cards`);
    const search = friend.getByRole('searchbox', { name: 'Search cards' });
    await search.fill('uncommitted');
    await expect(friend.getByText('No cards match “uncommitted”')).toBeVisible();
    await search.fill('dress');
    const results = friend.getByRole('region', { name: 'Search results' });
    await results.getByRole('link', { name: 'Dress Down' }).click();

    await expect(friend.getByRole('heading', { level: 2, name: 'Dress Down' })).toBeVisible();
    await expect(friend.getByText('In the latest version:')).toBeVisible();
    await expect(friend.getByRole('list', { name: 'Summary' })).toContainText('In all 2 versions');
    const timeline = friend.getByRole('list', { name: 'Card timeline' }).locator(':scope > li');
    await expect(timeline).toHaveCount(2);
    await expect(timeline.first()).toContainText('v2');
    await expect(timeline.first()).not.toContainText(/–now|Current/);
    await expect(timeline.first()).toContainText('Moved from Mainboard');
    await expect(timeline.last()).toContainText('In the first version');
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'Cards');

    // The uncommitted card has no page.
    await expectNotPartOfSharedDeck(
      friend,
      shared,
      viewing,
      `${shared.path}/cards/${encodeURIComponent(UNCOMMITTED_CARD.toLowerCase())}`,
    );
  });

  await test.step('restore v1: copy a block and download the restore text', async () => {
    await friend.goto(`${shared.path}/versions/1`);
    await friend.getByRole('link', { name: 'Restore to Moxfield' }).click();
    await expect(friend).toHaveURL(`${shared.path}/versions/1/restore`);
    await expect(friend.getByRole('heading', { level: 2, name: 'Restore v1 to Moxfield' })).toBeVisible();
    await expect(friend.getByRole('main')).toContainText(
      'paste each block into the Bulk Edit of a deck of your own',
    );
    // Into a deck of their own: nothing leads to the owner's deck on Moxfield.
    const steps = friend.getByRole('region', { name: 'Steps' });
    await expect(steps.getByRole('listitem').first()).toContainText(
      'Open a deck of your own on Moxfield (or create one) and reload its page, so you edit its latest state.',
    );
    await expect(steps.getByRole('link')).toHaveText(['Download .txt']);

    const block = friend.getByRole('article', { name: 'Mainboard' });
    const text = await block.getByLabel('Mainboard restore text').inputValue();
    expect(text).toMatch(/^1 Dress Down \(TST\) \d+$/m);
    expect(text).not.toContain('Final Fortune');
    await block.getByRole('button', { name: 'Copy Mainboard' }).click();
    await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(friend)).toBe(text);

    const [download] = await Promise.all([
      friend.waitForEvent('download'),
      friend.getByRole('link', { name: 'Download .txt' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('shared-farm-v1-restore.txt');
    const downloaded = await readFile(await download.path(), 'utf8');
    expect(downloaded).toContain(`${DECK_NAME} — v1: Tournament list`);
    expect(downloaded).toContain(text.trimEnd());
    expect(downloaded).not.toContain(UNCOMMITTED_NAME);
    expect(downloaded).not.toContain(UNCOMMITTED_CARD);
    expect(downloaded).toContain('1. Open a deck of your own on Moxfield');
    expect(downloaded).not.toContain(deck.publicId);

    const response = await friendContext.request.get(`${shared.path}/versions/1/restore.txt`);
    expect(response.status()).toBe(200);
    expect(response.headers()['cache-control']).toBe('private, no-store');
    expect(response.headers()['x-robots-tag']).toMatch(/\bnoindex\b/);
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    await expectReadOnlyPage(friend, shared, viewing);
    await expectPhoneLayout(friend, isMobile, 'History');
  });

  await test.step('viewing fetched nothing from Moxfield, and the owner sees the link was viewed', async () => {
    expect(await serverFetchCount()).toBe(fetchesBeforeViewing);
    await page.reload();
    await expect(shareLinkRow(page, 'For Mikko')).toContainText('Last viewed');
  });
});

test('version notes are shown only through a link that includes them', async ({
  page,
  context,
  newContext,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Notes are about access, not layout.');
  const note = 'Went 3-1 at the store. Cut Dress Down next.';
  const { user: owner } = await signIn(context, { displayName: uniqueName('Aino') });
  const deck = await createBlueFarmCopy(testInfo, DECK_NAME);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Tournament list' });
  await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();

  await page.goto(`/decks/${deckId}/versions/1`);
  await page.getByRole('textbox', { name: 'Notes' }).fill(note);
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();

  const withoutNotes = await createShareLink(page, deckId, { label: 'Playgroup chat' });
  const withNotes = await createShareLink(page, deckId, {
    label: 'For my testing partner',
    includeNotes: true,
  });
  await expect(shareLinkRow(page, 'For my testing partner').getByText('Includes notes')).toBeVisible();
  await expect(shareLinkRow(page, 'Playgroup chat').getByText('Includes notes')).toHaveCount(0);
  // Newest first.
  await expect(page.getByRole('list', { name: 'Share links' }).locator(':scope > li')).toHaveText([
    /For my testing partner/,
    /Playgroup chat/,
  ]);

  const friend = await (await newContext()).newPage();

  await test.step('the link without notes shows none, nor sends them to the browser', async () => {
    for (const path of [
      withoutNotes.path,
      `${withoutNotes.path}/history`,
      `${withoutNotes.path}/versions/1`,
      `${withoutNotes.path}/versions/1?tab=deck`,
      `${withoutNotes.path}/versions/1/restore`,
      `${withoutNotes.path}/compare`,
    ]) {
      await friend.goto(path);
      await expect(friend.getByRole('heading', { level: 1, name: DECK_NAME }), path).toBeVisible();
      await expect(friend.getByRole('heading', { name: 'Notes' }), path).toHaveCount(0);
      expect(await friend.content(), path).not.toContain('Went 3-1');
    }
  });

  await test.step('the link with notes shows them, read-only', async () => {
    await friend.goto(`${withNotes.path}/versions/1`);
    const notes = friend.getByRole('region', { name: 'Notes' });
    await expect(notes).toContainText(note);
    await expect(notes).toContainText('Updated');
    await expect(notes.getByRole('textbox')).toHaveCount(0);
    await expectReadOnlyPage(friend, withNotes, { ownerName: owner.displayName, publicId: deck.publicId });
  });
});
