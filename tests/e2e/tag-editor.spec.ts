/**
 * The tag editor on a version page marks an invalid tag the way every form field does: the
 * input gets the invalid (red) border, the same red as the error text under it.
 */
import { signIn } from './support/accounts';
import { trackAndCommitV1 } from './support/decks';
import { expect, test } from './support/fixtures';

test('an invalid tag turns the tag input red', async ({ page, context }, testInfo) => {
  await signIn(context);
  const { deckId } = await trackAndCommitV1(page, testInfo, {
    name: 'Tag Editor Farm',
    message: 'Baseline',
    confirm: 'status',
  });

  await page.goto(`/decks/${deckId}/versions/1`);
  await page.getByRole('button', { name: 'Add tag' }).click();
  const input = page.getByLabel('New tag');
  await expect(input).toBeFocused();
  const border = (): Promise<string> => input.evaluate((element) => getComputedStyle(element).borderTopColor);

  await input.fill('#!?');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const problem = page.getByRole('alert').filter({ hasText: 'Tags may contain letters' });
  await expect(problem).toBeVisible();
  const red = await problem.evaluate((element) => getComputedStyle(element).color);
  await expect.poll(border).toBe(red);

  // Typing again clears the problem and the red border with it.
  await input.fill('stable');
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
  await expect.poll(border).not.toBe(red);
});
