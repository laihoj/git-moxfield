/**
 * Layout checks for the pages of a deck on a phone, where the deck's navigation is a bar
 * fixed to the bottom of the screen (docs/ux.md: "Mobile does the core loop").
 */
import type { Locator, Page } from '@playwright/test';

import { deckNav } from './decks';
import { expect } from './fixtures';

/** The size and position of a visible element; fails when it is not visible. */
export async function box(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox();
  if (rect === null) throw new Error('The element is not visible');
  return rect;
}

/** Asserts that the deck's navigation is a bar pinned to the bottom of the screen, with `activeTab` current. */
export async function expectBottomNavPinned(page: Page, activeTab: string): Promise<void> {
  const nav = deckNav(page);
  await expect(nav).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error('No viewport');
  const rect = await box(nav);
  expect(rect.y + rect.height).toBeCloseTo(viewport.height, 0);
  await expect(nav.getByRole('link', { name: activeTab })).toHaveAttribute('aria-current', 'page');
}

/** Scrolled to the end, the page's last content (the footer) ends above the bottom bar. */
export async function expectNothingBehindBottomNav(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const footer = await box(page.getByRole('contentinfo'));
  const nav = await box(deckNav(page));
  // Half a pixel of leeway for sub-pixel layout at the device pixel ratio.
  expect(footer.y + footer.height).toBeLessThanOrEqual(nav.y + 0.5);
}
