/**
 * Wizards renames a card and Moxfield follows: the only change of the next version is
 * that rename. The deck's status says so ("Only renamed cards", not "Only printing
 * changes"), and so do the compact change counters of the version rows, the owner's and
 * a share link's ("Renamed only", not "No card changes").
 */
import type { Page } from '@playwright/test';

import { signIn } from './support/accounts';
import { commitVersion, statusHeading, trackAndCommitV1 } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';
import { createShareLink } from './support/share';

function versionRow(page: Page, label: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('link', { name: label }) });
}

test('a rename that is the only change is called a rename', async ({
  page,
  context,
  newContext,
}, testInfo) => {
  await signIn(context);
  const { deck, deckId } = await trackAndCommitV1(page, testInfo, {
    name: 'Renamed Farm',
    message: 'Tournament list',
    confirm: 'status',
  });

  await mockMoxfield.edit(deck.publicId, [{ op: 'renameCard', card: 'Mox Opal', name: 'Mox Opaline' }]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(statusHeading(page, 'Only renamed cards')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Summary of changes' })).toHaveText('1 renamed card');

  await page.goto('/');
  const deckCard = page.getByRole('listitem').filter({ hasText: 'Renamed Farm' });
  await expect(deckCard).toContainText('Only renamed cards');
  await expect(deckCard).not.toContainText('printing');

  await page.goto(`/decks/${deckId}`);
  await commitVersion(page, { sequence: 2, message: 'Oracle update' });
  await expect(statusHeading(page, 'Up to date with v2')).toBeVisible();

  await page.goto(`/decks/${deckId}/history`);
  await expect(versionRow(page, 'v2: Oracle update')).toContainText('Renamed only');
  await expect(versionRow(page, 'v2: Oracle update')).not.toContainText('No card changes');

  const link = await createShareLink(page, deckId, { label: 'Renames' });
  const viewer = await (await newContext()).newPage();
  await viewer.goto(`${link.path}/history`);
  await expect(versionRow(viewer, 'v2: Oracle update')).toContainText('Renamed only');
});
