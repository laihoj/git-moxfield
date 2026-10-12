/**
 * Both tag editors (the commit form and a version's tags) offer the deck's tags under
 * "Used before:" in one order: the tag on the most versions first, then the one a later
 * version used, then alphabetically.
 */
import type { Locator, Page } from '@playwright/test';

import { signIn } from './support/accounts';
import { commitVersion, createBlueFarmCopy, statusHeading, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield, type EditOp } from './support/mock';

/** The suggestion buttons after "Used before:", in their order on the page. */
function suggestions(scope: Page | Locator): Locator {
  return scope.getByText('Used before:', { exact: true }).locator('xpath=..').getByRole('button');
}

test('both tag editors offer the most used tags first, then the most recent', async ({
  page,
  context,
}, testInfo) => {
  await signIn(context);
  const deck = await createBlueFarmCopy(testInfo, 'Tagged Farm');
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'First list', tags: ['zeta'] });
  await expect(statusHeading(page, 'Up to date with v1')).toBeVisible();

  // zeta is on two versions; beta and gamma were used after alpha; beta before gamma by name.
  const versions: [number, EditOp, string[]][] = [
    [2, { op: 'move', card: 'Null Rod', from: 'sideboard', to: 'mainboard' }, ['zeta', 'alpha']],
    [3, { op: 'add', zone: 'mainboard', card: 'Final Fortune' }, ['beta', 'gamma']],
  ];
  for (const [sequence, edit, tags] of versions) {
    await mockMoxfield.edit(deck.publicId, [edit]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
    await commitVersion(page, { sequence, message: `Version ${sequence}`, tags });
    await expect(statusHeading(page, `Up to date with v${sequence}`)).toBeVisible();
  }

  await mockMoxfield.edit(deck.publicId, [{ op: 'add', zone: 'mainboard', card: 'Mystic Remnant' }]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
  const commitForm = page.getByRole('region', { name: 'Commit v4' });
  await expect(suggestions(commitForm)).toHaveText(['zeta', 'beta', 'gamma', 'alpha']);

  await page.goto(`/decks/${deckId}/versions/1`);
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(suggestions(page.getByRole('main'))).toHaveText(['beta', 'gamma', 'alpha']);
});
