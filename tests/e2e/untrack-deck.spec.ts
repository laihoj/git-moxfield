/**
 * "Stop tracking" asks for confirmation inline, and its focus follows the panel like every
 * other confirmation (revoking links and bookmarklets, disabling people): focus moves to the
 * confirming button when the panel opens and back to the trigger on Cancel.
 */
import { signIn } from './support/accounts';
import { createBlueFarmCopy, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('the stop-tracking confirmation moves focus into the panel and back on Cancel', async ({
  page,
  context,
}, testInfo) => {
  await signIn(context);
  const deck = await createBlueFarmCopy(testInfo, 'Untrack Focus Farm');
  await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));

  const trigger = page.getByRole('button', { name: 'Stop tracking', exact: true });
  await trigger.click();

  const panel = page.getByRole('group').filter({ hasText: 'Untrack Focus Farm' });
  await expect(panel).toContainText('The deck on Moxfield is not affected.');
  await expect(panel.getByRole('button', { name: 'Stop tracking and delete history' })).toBeFocused();

  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
