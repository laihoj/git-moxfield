/**
 * A commit's message stays a brief subject line; the elaboration goes into its description,
 * which the version page shows under the heading, while lists show the subject only with a
 * mark that there is more to read.
 */
import { signIn } from './support/accounts';
import { trackAndCommitV1 } from './support/decks';
import { expect, test } from './support/fixtures';

const DESCRIPTION = 'List from the regional.\n\nStifle main over Mental Misstep: too many lands to punish.';

test('a commit keeps its description behind a brief subject', async ({ page, context }, testInfo) => {
  await signIn(context);
  const { deckId } = await trackAndCommitV1(page, testInfo, {
    message: 'Regional list',
    description: DESCRIPTION,
    confirm: 'toast',
  });

  await test.step('the recent versions show the subject and a mark', async () => {
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link', { name: 'v1: Regional list' }) });
    await expect(row.getByRole('img', { name: 'Has a description' })).toBeVisible();
    await expect(row).not.toContainText('Stifle main');
  });

  await test.step('the version page shows both', async () => {
    await page.goto(`/decks/${deckId}/versions/1`);
    await expect(page.getByRole('heading', { level: 2, name: 'v1: Regional list' })).toBeVisible();
    const description = page.getByLabel('Description', { exact: true });
    await expect(description).toContainText('List from the regional.');
    await expect(description).toContainText('Stifle main over Mental Misstep: too many lands to punish.');
  });
});
