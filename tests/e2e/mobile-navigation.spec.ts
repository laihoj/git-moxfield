/**
 * Journey 6, the core loop on a phone (docs/ux.md: "Mobile does the core loop"): the
 * deck's Status · History · Compare · Cards tabs sit in a fixed bottom bar with large
 * touch targets, the commit form works with touch and the on-screen keyboard, nothing
 * hides behind the bottom bar, and no page scrolls sideways.
 */
import type { Locator, Page } from '@playwright/test';

import { commitVersion, createBlueFarmCopy, expectNoHorizontalOverflow, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

/** Minimum touch target size (docs/ux.md). */
const MIN_TOUCH_TARGET_PX = 44;

function bottomNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Deck' });
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('The element is not visible');
  return rect;
}

/** Asserts the bottom bar: pinned to the bottom of the viewport, four large tabs, `active` current. */
async function expectBottomNav(page: Page, active: string): Promise<void> {
  const nav = bottomNav(page);
  await expect(nav).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('No viewport');
  const rect = await box(nav);
  expect(rect.y + rect.height).toBeCloseTo(viewport.height, 0);
  expect(rect.width).toBeCloseTo(viewport.width, 0);

  const tabs = nav.getByRole('link');
  await expect(tabs).toHaveText(['Status', 'History', 'Compare', 'Cards']);
  for (const tab of await tabs.all()) {
    const tabRect = await box(tab);
    expect(tabRect.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    expect(tabRect.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  }
  await expect(nav.getByRole('link', { name: active })).toHaveAttribute('aria-current', 'page');
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
}

/** Taps a bottom-bar tab and waits for its page. */
async function openTab(page: Page, tab: string, path: string): Promise<void> {
  await bottomNav(page).getByRole('link', { name: tab }).tap();
  await expect(page).toHaveURL(path);
  await expectBottomNav(page, tab);
}

/** Scrolled to the end, the page's last content (the footer) ends above the bottom bar. */
async function expectNothingBehindBottomNav(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const footer = await box(page.getByRole('contentinfo'));
  const nav = await box(bottomNav(page));
  // Half a pixel of leeway for sub-pixel layout at the device pixel ratio.
  expect(footer.y + footer.height).toBeLessThanOrEqual(nav.y + 0.5);
}

/** The checks every deck page gets on a phone. */
async function expectPhoneLayout(page: Page, activeTab: string): Promise<void> {
  await expectBottomNav(page, activeTab);
  await expectNoHorizontalOverflow(page);
  await expectNothingBehindBottomNav(page);
}

test('the bottom navigation, the commit form and every page work on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The bottom navigation is the phone layout.');
  const deck = await createBlueFarmCopy(testInfo, 'Pocket Farm');
  let deckId = '';

  await test.step('home and setup pages', async () => {
    await page.goto('/');
    await expectNoHorizontalOverflow(page);
    // Outside a deck there is no deck navigation.
    await expect(bottomNav(page)).toHaveCount(0);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Setup' }).tap();
    await expect(page).toHaveURL('/setup');
    await expect(page.getByRole('heading', { level: 1, name: 'Connect Moxfield' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole('link', { name: 'Paste deck JSON' }).tap();
    await expect(page).toHaveURL('/capture?mode=paste');
    await expectNoHorizontalOverflow(page);
  });

  await test.step('track a deck and commit v1 with touch', async () => {
    deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
    await expect(page.getByRole('heading', { level: 1, name: 'Pocket Farm' })).toBeVisible();
    // The top tabs are the desktop layout.
    await expect(page.getByRole('navigation', { name: 'Deck' })).toHaveCount(1);
    await expectPhoneLayout(page, 'Status');

    const message = page.getByLabel('Commit message');
    await message.tap();
    await expect(message).toBeFocused();
    await page.keyboard.type('First list');
    const tags = page.getByLabel('Tags');
    await tags.tap();
    await page.keyboard.type('league');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Remove tag league' })).toBeVisible();
    const commit = page.getByRole('button', { name: 'Commit v1' });
    expect((await box(commit)).height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    await commit.tap();
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();

    // The confirmation toast sits above the bottom bar.
    const toast = page.getByText('Committed v1');
    await expect(toast).toBeVisible();
    expect((await box(toast)).y).toBeLessThan((await box(bottomNav(page))).y);
    await expectPhoneLayout(page, 'Status');
  });

  await test.step('review a change and commit v2 with the suggested message', async () => {
    await mockMoxfield.edit(deck.publicId, [
      { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
      {
        op: 'add',
        zone: 'mainboard',
        card: { name: 'Final Fortune', typeLine: 'Instant', manaCost: '{R}{R}' },
      },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).tap();
    await expect(page.getByRole('heading', { level: 2, name: 'Uncommitted changes' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Changes since v1' })).toContainText('2 changes');
    await expectPhoneLayout(page, 'Status');

    await page.getByRole('button', { name: 'Use suggestion' }).tap();
    await expect(page.getByLabel('Commit message')).toHaveValue(/Final Fortune/);
    await commitVersion(page, { sequence: 2 });
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v2' })).toBeVisible();
  });

  await test.step('History, a version, its deck, primer and restore', async () => {
    await openTab(page, 'History', `/decks/${deckId}/history`);
    await expectPhoneLayout(page, 'History');
    await expect(page.getByRole('link', { name: /^v\d+: / })).toHaveCount(2);

    await page.getByRole('link', { name: /^v2: / }).tap();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2`);
    await expectPhoneLayout(page, 'History');
    const tabs = page.getByRole('navigation', { name: 'Version content' });
    await tabs.getByRole('link', { name: /^Deck/ }).tap();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2?tab=deck`);
    await expectPhoneLayout(page, 'History');
    await tabs.getByRole('link', { name: /^Primer/ }).tap();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2?tab=primer`);
    await expectPhoneLayout(page, 'History');

    await page.getByRole('link', { name: 'Restore to Moxfield' }).tap();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/2/restore`);
    await expect(page.getByRole('button', { name: 'Copy Mainboard' })).toBeVisible();
    await expectPhoneLayout(page, 'History');
  });

  await test.step('Compare', async () => {
    await openTab(page, 'Compare', `/decks/${deckId}/compare`);
    await expect(page.getByRole('combobox', { name: 'From' })).toHaveValue('v1');
    await expect(page.getByRole('combobox', { name: 'To' })).toHaveValue('v2');
    await expect(page.getByRole('region', { name: 'Changes' })).toContainText('2 changes');
    await expectPhoneLayout(page, 'Compare');
  });

  await test.step('Cards and a card history', async () => {
    await openTab(page, 'Cards', `/decks/${deckId}/cards`);
    await expectPhoneLayout(page, 'Cards');
    await page.getByRole('searchbox', { name: 'Search cards' }).fill('final');
    await page
      .getByRole('region', { name: 'Search results' })
      .getByRole('link', { name: 'Final Fortune' })
      .tap();
    await expect(page.getByRole('heading', { level: 2, name: 'Final Fortune' })).toBeVisible();
    await expectPhoneLayout(page, 'Cards');
  });

  await test.step('back to Status', async () => {
    await openTab(page, 'Status', `/decks/${deckId}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v2' })).toBeVisible();
    await expectPhoneLayout(page, 'Status');
  });
});
