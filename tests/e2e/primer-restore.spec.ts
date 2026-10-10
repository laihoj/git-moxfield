/**
 * Putting an older primer back on Moxfield.
 *
 * Regression: copying lines from a primer diff used to paste the screen-reader labels
 * along with them ("Removed:Keep any seven…"), and there was no way to copy a version's
 * primer as such. The primer is now copyable from Compare (each side), from the
 * version's Primer tab and from Restore to Moxfield, always as the exact Moxfield
 * markup that was captured, and diff selections copy only the visible text.
 */
import type { Page } from '@playwright/test';

import { APP_URL } from './support/constants';
import { commitVersion, createBlueFarmCopy, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

const PRIMER_V1 = [
  '===center',
  '# **Blue Farm**',
  '===endcenter',
  '',
  '===panel: Mulligans',
  'Keep any seven with fast mana and a tutor, or two pieces of interaction and a land.',
  'Ship hands that need three lands to function.',
  '===endpanel',
  '',
  '**Incidental wincons**',
  "[[Thassa's Oracle]] with [[Demonic Consultation]] wins on the spot.",
  '',
].join('\n');

const PRIMER_V2 = [
  '===center',
  '# **Blue Farm**',
  '===endcenter',
  '',
  '===panel: Mulligans',
  'Keep any seven with fast mana and a tutor.',
  '===endpanel',
  '',
].join('\n');

/** The Compare page's primer card (the diff's summary row is also named "Primer"). */
function primerCard(page: Page) {
  return page.locator('section[aria-labelledby="primer"]');
}

async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test('an older primer can be copied back to Moxfield exactly', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'selection and keyboard copy are exercised on desktop');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP_URL });

  const deck = await createBlueFarmCopy(testInfo);
  await mockMoxfield.edit(deck.publicId, [{ op: 'primer', text: PRIMER_V1 }]);
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Primer with incidental wincons' });
  await expect(page.getByText('Committed v1')).toBeVisible();

  await mockMoxfield.edit(deck.publicId, [{ op: 'primer', text: PRIMER_V2 }]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByText('Updated from Moxfield')).toBeVisible();
  await commitVersion(page, { sequence: 2, message: 'Trim the primer' });
  await expect(page.getByText('Committed v2')).toBeVisible();

  await test.step('copying lines from the primer diff copies only the visible text', async () => {
    await page.goto(`/decks/${deckId}/compare?from=v2&to=v1`);
    const primer = primerCard(page);
    await expect(primer).toContainText('**Incidental wincons**');

    // The clipboard is shared by the whole browser: start from a known value, focus the
    // page with a click, then select every diff line (as a drag across the diff would)
    // and copy with the keyboard.
    await page.evaluate(() => navigator.clipboard.writeText('clipboard-sentinel'));
    await primer.getByRole('heading', { name: 'Primer' }).click();
    await primer
      .locator('ol')
      .first()
      .evaluate((first) => {
        const lists = first.closest('section')?.querySelectorAll('ol') ?? [];
        const last = lists[lists.length - 1] ?? first;
        const range = document.createRange();
        range.setStartBefore(first);
        range.setEndAfter(last);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    await page.keyboard.press('ControlOrMeta+C');
    await expect.poll(() => clipboard(page)).not.toBe('clipboard-sentinel');

    const copied = await clipboard(page);
    expect(copied).toContain('**Incidental wincons**');
    expect(copied).toContain('Keep any seven with fast mana and a tutor.');
    expect(copied).not.toMatch(/\b(Added|Removed|Unchanged):/);
  });

  await test.step('Compare copies the primer of either side verbatim', async () => {
    const primer = primerCard(page);
    await primer.getByRole('button', { name: 'Copy v1 primer' }).click();
    await expect(primer.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe(PRIMER_V1);
  });

  await test.step("the version's Primer tab copies its primer", async () => {
    await page.goto(`/decks/${deckId}/versions/1?tab=primer`);
    await page.getByRole('button', { name: 'Copy primer' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe(PRIMER_V1);
  });

  await test.step('Restore to Moxfield has a Primer block with the exact markup', async () => {
    await page.getByRole('link', { name: 'Restore steps' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/versions/1/restore#restore-primer`);
    await expect(
      page.getByRole('list').getByText(/^Restore the primer: Deck page › Primer › Edit/),
    ).toBeVisible();

    const block = page.getByRole('article', { name: 'Primer' });
    await expect(block).toContainText('Deck page › Primer › Edit');
    await expect(block.getByLabel('Primer source')).toHaveValue(PRIMER_V1);
    await block.getByRole('button', { name: 'Copy primer' }).click();
    await expect(block.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await clipboard(page)).toBe(PRIMER_V1);
  });
});
