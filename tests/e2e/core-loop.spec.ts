/**
 * Journey 1, the core loop with server-side fetching (Moxfield answers the server):
 * track a deck by URL, commit v1, change the deck on Moxfield, refresh, review the
 * semantic diff (a move between boards is one move, not a removal plus an addition),
 * commit v2 with a tag, then follow the deck through History, the version page, Compare,
 * a card's history and Restore, copying a restore block to the clipboard.
 */
import type { Locator, Page } from '@playwright/test';

import { blueFarmDeck } from '../mock-moxfield/scenarios';

import { APP_URL } from './support/constants';
import { commitVersion, createBlueFarmCopy, expectNoHorizontalOverflow, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield, type EditOp } from './support/mock';

const SHIP_LINE = '- Ship hands without blue sources or without any interaction.';
const SHIP_LINE_EDITED = '- Ship hands without blue sources.';
const ADDED_PRIMER_LINE = '- Keep [[Beseech the Mirror]] hands that also hold fast mana.';
const RHYSTIC_LINE = '- [[Rhystic Study]] and [[Mystic Remora]] are keepable engines in slower pods.';

/** The seeded primer with one line rewritten and one line added: `+2 / −1` lines. */
function editedPrimer(): string {
  const primer = blueFarmDeck().primer ?? '';
  expect(primer).toContain(SHIP_LINE);
  expect(primer).toContain(RHYSTIC_LINE);
  return primer
    .replace(SHIP_LINE, SHIP_LINE_EDITED)
    .replace(RHYSTIC_LINE, `${RHYSTIC_LINE}\n${ADDED_PRIMER_LINE}`);
}

/** One save on Moxfield: Dress Down to Considering, two new cards, a second Bowmasters, a primer edit. */
function moxfieldEdit(): EditOp[] {
  return [
    { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
    {
      op: 'add',
      zone: 'mainboard',
      card: { name: 'Beseech the Mirror', typeLine: 'Sorcery', manaCost: '{1}{B}{B}{B}' },
    },
    {
      op: 'add',
      zone: 'mainboard',
      card: { name: 'Final Fortune', typeLine: 'Instant', manaCost: '{R}{R}' },
    },
    { op: 'setQuantity', zone: 'mainboard', card: 'Orcish Bowmasters', quantity: 2 },
    { op: 'primer', text: editedPrimer() },
  ];
}

/** The deck's Status · History · Compare · Cards navigation (top tabs or bottom bar). */
function deckNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Deck' });
}

function statusHeading(page: Page, label: string): Locator {
  return page.getByRole('heading', { level: 2, name: label });
}

/** The row of a card in a diff section. */
function changeRow(section: Locator, card: string): Locator {
  return section.getByRole('listitem').filter({ hasText: card });
}

/** Asserts the diff of the Moxfield edit above (status page, version page and compare page). */
async function expectEditDiff(changes: Locator): Promise<void> {
  const mainboard = changes.getByRole('region', { name: /^Mainboard/ });
  await expect(changeRow(mainboard, 'Beseech the Mirror')).toContainText('Added: Beseech the Mirror');
  await expect(changeRow(mainboard, 'Final Fortune')).toContainText('Added: Final Fortune');
  await expect(changeRow(mainboard, 'Orcish Bowmasters')).toContainText(
    'More copies: Orcish Bowmasters 1 → 2',
  );

  const moved = changes.getByRole('region', { name: /^Moved/ });
  await expect(moved.getByRole('listitem')).toHaveCount(1);
  await expect(changeRow(moved, 'Dress Down')).toContainText(
    'Moved from Mainboard to Considering: Dress Down',
  );
  // A move is one change: Dress Down is neither removed from the Mainboard nor added to Considering.
  await expect(changeRow(changes, 'Dress Down')).toHaveCount(1);
  await expect(changes.getByText(/(Added|Removed): Dress Down/)).toHaveCount(0);
}

test('tracks a deck, commits two versions and follows the changes through every view', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });
  const deck = await createBlueFarmCopy(testInfo);
  let deckId = '';

  await test.step('track the deck by its Moxfield URL', async () => {
    deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
    await expect(page.getByRole('heading', { level: 1, name: 'Blue Farm' })).toBeVisible();
    await expect(statusHeading(page, 'Not committed yet')).toBeVisible();
    await expect(page.getByText('Review the deck below, then commit it as v1.')).toBeVisible();

    const initial = page.getByRole('region', { name: 'Initial version' });
    await expect(initial).toContainText('100 cards in the deck. All of it becomes v1.');
    await expect(initial.getByRole('list', { name: 'Cards per zone' }).getByRole('listitem')).toHaveText([
      /Commanders\s*2/,
      /Mainboard\s*98/,
      /Sideboard\s*2/,
      /Considering\s*12/,
    ]);
    await expect(page.getByRole('button', { name: 'Commit v1' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  await test.step('commit v1', async () => {
    await commitVersion(page, { sequence: 1, message: 'Tournament list' });
    await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();
    await expect(page.getByText('Committed v1')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Versions' })).toContainText('v1 committed at 100');
    await expect(page.getByRole('button', { name: /^Commit v/ })).toHaveCount(0);
  });

  await test.step('change the deck on Moxfield and refresh', async () => {
    await mockMoxfield.edit(deck.publicId, moxfieldEdit());
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
    await expect(page.getByText('Updated from Moxfield')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Versions' })).toContainText('Moxfield version 101');
  });

  await test.step('review the semantic diff', async () => {
    await expect(page.getByRole('list', { name: 'Summary of changes' }).getByRole('listitem')).toHaveText([
      '+3 Mainboard',
      '1 moved to Considering',
      'Primer +2 / −1 lines',
    ]);
    const changes = page.getByRole('region', { name: 'Changes since v1' });
    await expect(changes).toContainText('5 changes');
    await expectEditDiff(changes);
    await expect(changes.getByRole('region', { name: 'Primer' })).toContainText('+2 / −1 lines');
    await expectNoHorizontalOverflow(page);
  });

  await test.step('commit v2 with a tag', async () => {
    await commitVersion(page, { sequence: 2, message: 'Testing Beseech package', tags: ['testing'] });
    await expect(statusHeading(page, 'Up to date with v2')).toBeVisible();
    await expect(page.getByText('Committed v2')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Changes since v1' })).toHaveCount(0);
  });

  await test.step('History lists v2 and v1 with the tag', async () => {
    await deckNav(page).getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/history`);
    await expect(page.getByText('2 versions. Select two to compare them.')).toBeVisible();
    const versionLinks = page.getByRole('link', { name: /^v\d+: / });
    await expect(versionLinks).toHaveCount(2);
    expect(
      await versionLinks.evaluateAll((links) => links.map((link) => link.getAttribute('aria-label'))),
    ).toEqual(['v2: Testing Beseech package', 'v1: Tournament list']);
    const v2 = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'v2: Testing Beseech package' }) });
    await expect(v2.getByRole('list', { name: 'Tags' })).toHaveText('testing');
    const v1 = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'v1: Tournament list' }) });
    await expect(v1).toContainText('100 cards');
    await expect(v1.getByRole('list', { name: 'Tags' })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    // The tag filter shows the tagged version only.
    await page
      .getByRole('navigation', { name: 'Filter by tag' })
      .getByRole('link', { name: /testing/ })
      .click();
    await expect(page).toHaveURL(`/decks/${deckId}/history?tag=testing`);
    await expect(page.getByText('1 version tagged “testing”')).toBeVisible();
    await expect(versionLinks).toHaveCount(1);
    await expect(versionLinks).toHaveAccessibleName('v2: Testing Beseech package');
  });

  await test.step('the version page shows changes, the deck and the primer', async () => {
    await page.getByRole('link', { name: 'v2: Testing Beseech package' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2`);
    await expect(page.getByRole('heading', { level: 2, name: 'v2: Testing Beseech package' })).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Version content' });
    await expect(tabs.getByRole('link', { name: /^Changes/ })).toHaveAttribute('aria-current', 'page');
    await expectEditDiff(page.getByRole('region', { name: 'Changes since v1' }));
    await expectNoHorizontalOverflow(page);

    await tabs.getByRole('link', { name: /^Deck/ }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2?tab=deck`);
    await expect(tabs.getByRole('link', { name: /^Deck/ })).toHaveAttribute('aria-current', 'page');
    const deckList = page.getByRole('region', { name: 'Deck list' });
    const mainboard = deckList.getByRole('region', { name: /^Mainboard/ });
    await expect(mainboard.getByRole('heading', { level: 3 })).toHaveText(/^Mainboard\s*100$/);
    await expect(mainboard.getByRole('listitem').filter({ hasText: 'Orcish Bowmasters' })).toContainText('2');
    await expect(mainboard).toContainText('Beseech the Mirror');
    await expect(mainboard).toContainText('Final Fortune');
    await expect(mainboard).not.toContainText('Dress Down');
    await expect(deckList.getByRole('region', { name: /^Considering/ })).toContainText('Dress Down');
    await expectNoHorizontalOverflow(page);

    await tabs.getByRole('link', { name: /^Primer/ }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2?tab=primer`);
    await expect(page.getByText('Primer changes since v1')).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: `Added: ${ADDED_PRIMER_LINE}` })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: `Added: ${SHIP_LINE_EDITED}` })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: `Removed: ${SHIP_LINE}` })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Primer' }).getByRole('heading', { name: 'Win conditions' }),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  await test.step('compare v1 with v2', async () => {
    await deckNav(page).getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/history`);
    await page.getByRole('checkbox', { name: 'Select v1 to compare' }).check();
    await page.getByRole('checkbox', { name: 'Select v2 to compare' }).check();
    const selection = page.getByRole('region', { name: 'Compare selected versions' });
    await expect(selection).toContainText('v1 → v2');
    await selection.getByRole('link', { name: 'Compare selected' }).click();

    await expect(page).toHaveURL(`/decks/${deckId}/compare?from=v1&to=v2`);
    await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue('v1');
    await expect(page.getByRole('combobox', { name: 'To' })).toHaveValue('v2');
    const changes = page.getByRole('region', { name: 'Changes' });
    await expect(changes).toContainText('5 changes');
    await expectEditDiff(changes);
    await expect(page.getByRole('heading', { level: 2, name: 'Primer' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  await test.step('the card history of Dress Down shows the move', async () => {
    await deckNav(page).getByRole('link', { name: 'Cards' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/cards`);
    await page.getByRole('searchbox', { name: 'Search cards' }).fill('dress');
    const results = page.getByRole('region', { name: 'Search results' });
    await expect(results.getByRole('link', { name: 'Dress Down' })).toBeVisible();
    await results.getByRole('link', { name: 'Dress Down' }).click();

    await expect(page.getByRole('heading', { level: 2, name: 'Dress Down' })).toBeVisible();
    await expect(page.getByText('Now on Moxfield:')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Summary' })).toContainText('In all 2 versions');
    const timeline = page.getByRole('list', { name: 'Card timeline' }).locator(':scope > li');
    await expect(timeline).toHaveCount(2);
    await expect(timeline.first()).toContainText('v2–now');
    await expect(timeline.first()).toContainText('Considering');
    await expect(timeline.first()).toContainText('Moved from Mainboard');
    await expect(timeline.last()).toContainText('v1');
    await expect(timeline.last()).toContainText('Mainboard');
    await expect(timeline.last()).toContainText('In the first version');
    await expectNoHorizontalOverflow(page);
  });

  await test.step('restore v1: the Mainboard block holds Dress Down and copies to the clipboard', async () => {
    await page.goto(`/decks/${deckId}/versions/1`);
    await expect(page.getByRole('heading', { level: 2, name: 'v1: Tournament list' })).toBeVisible();
    await page.getByRole('link', { name: 'Restore to Moxfield' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/1/restore`);
    await expect(page.getByRole('heading', { level: 2, name: 'Restore v1 to Moxfield' })).toBeVisible();

    const block = page.getByRole('article', { name: 'Mainboard' });
    await expect(block).toContainText('Bulk Edit › Main Deck');
    await expect(block).toContainText('98 cards');
    const text = await block.getByLabel('Mainboard restore text').inputValue();
    expect(text).toMatch(/^1 Dress Down \(TST\) \d+$/m);
    expect(text).not.toContain('Final Fortune');
    expect(text).not.toContain('Beseech the Mirror');
    expect(text).toMatch(/^1 Orcish Bowmasters /m);

    await block.getByRole('button', { name: 'Copy Mainboard' }).click();
    await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
    await expectNoHorizontalOverflow(page);
  });
});
