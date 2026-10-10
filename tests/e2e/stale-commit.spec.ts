/**
 * Journey 5, stale protection: a commit saves exactly what the user reviewed. When the
 * deck changed on Moxfield after the review, the commit (which checks Moxfield first)
 * is refused, the page shows the new changes, and committing again saves them.
 */
import { commitVersion, createBlueFarmCopy, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('a commit is refused when Moxfield changed after the review, and succeeds after reviewing again', async ({
  page,
}, testInfo) => {
  const deck = await createBlueFarmCopy(testInfo, 'Stale Farm');
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Baseline' });
  await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();

  const changes = page.getByRole('region', { name: 'Changes since v1' });

  await test.step('review a change made on Moxfield', async () => {
    await mockMoxfield.edit(deck.publicId, [
      { op: 'move', card: 'Null Rod', from: 'sideboard', to: 'mainboard' },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Uncommitted changes' })).toBeVisible();
    await expect(changes).toContainText('1 change');
    await expect(changes.getByRole('listitem').filter({ hasText: 'Null Rod' })).toContainText(
      'Moved from Sideboard to Mainboard',
    );
    await expect(changes).not.toContainText('Snuff Out');
  });

  await test.step('Moxfield changes again before the commit: the commit is refused', async () => {
    await mockMoxfield.edit(deck.publicId, [
      { op: 'move', card: 'Snuff Out', from: 'considering', to: 'mainboard' },
    ]);
    await commitVersion(page, { sequence: 2, message: 'Null Rod main' });

    const alert = page.getByRole('alert').filter({ hasText: 'Moxfield changed since you looked.' });
    await expect(alert).toContainText('Review the new changes below and commit again.');
    // The page now shows what Moxfield has, including the change made after the review.
    await expect(changes).toContainText('2 changes');
    await expect(changes.getByRole('listitem').filter({ hasText: 'Snuff Out' })).toContainText(
      'Moved from Considering to Mainboard',
    );
    await expect(page.getByRole('list', { name: 'Versions' })).toContainText('Moxfield version 102');
    await expect(page.getByRole('heading', { level: 2, name: 'Uncommitted changes' })).toBeVisible();
    // Nothing was committed, and the typed message is kept for the next try.
    await expect(page.getByRole('link', { name: /^v2: / })).toHaveCount(0);
    await expect(page.getByLabel('Commit message')).toHaveValue('Null Rod main');
  });

  await test.step('committing again saves both changes', async () => {
    await commitVersion(page, { sequence: 2, message: 'Null Rod and Snuff Out main' });
    await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v2' })).toBeVisible();
    await expect(page.getByText('Moxfield changed since you looked.')).toHaveCount(0);

    await page.goto(`/decks/${deckId}/versions/2`);
    const committed = page.getByRole('region', { name: 'Changes since v1' });
    await expect(committed.getByRole('listitem').filter({ hasText: 'Null Rod' })).toContainText(
      'Moved from Sideboard to Mainboard',
    );
    await expect(committed.getByRole('listitem').filter({ hasText: 'Snuff Out' })).toContainText(
      'Moved from Considering to Mainboard',
    );
    await expect(page.getByText('Moxfield version 102')).toBeVisible();
  });
});
