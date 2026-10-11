/**
 * A commit message may be as long as the form and the service allow (2000 characters), not
 * only as long as the server action once did (500): a long message is committed, and
 * shown whole on the version's page.
 */
import { signIn } from './support/accounts';
import { commitVersion, createBlueFarmCopy, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

/** A message of exactly `length` characters made of numbered sentences. */
function longMessage(length: number): string {
  let message = '';
  for (let sentence = 1; message.length < length; sentence += 1) {
    message += `Sentence ${sentence} explains what changed and why. `;
  }
  return message.slice(0, length).trim().padEnd(length, '.');
}

test('a commit message of 600 characters is committed', async ({ page, context }, testInfo) => {
  await signIn(context);
  const deck = await createBlueFarmCopy(testInfo, 'Long Message Farm');
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  const message = longMessage(600);
  expect(message).toHaveLength(600);

  await commitVersion(page, { sequence: 1, message });

  await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();

  await page.goto(`/decks/${deckId}/versions/1`);
  await expect(page.getByRole('heading', { level: 2 }).filter({ hasText: message })).toBeVisible();
});
