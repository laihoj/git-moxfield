/**
 * The deck view toggle (MTG · cEDH): in the cEDH view the sideboard and Considering are
 * out of sight everywhere, a card cut to Considering is a cut and a card brought back is an
 * add, the suggested commit message says so, and what the view leaves out is counted. The
 * choice sticks across pages, and the MTG view brings the moves back.
 */
import { cardWithFacts } from '../support/card-facts';

import { signIn } from './support/accounts';
import { deckNav, expectNoHorizontalOverflow, statusHeading, trackAndCommitV1 } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('the cEDH view reads a cut and an add where the MTG view reads moves', async ({
  page,
  context,
}, testInfo) => {
  await signIn(context);
  const { deck, deckId } = await trackAndCommitV1(page, testInfo, {
    message: 'Tournament list',
    confirm: 'status',
  });

  await test.step('edit the deck on Moxfield: Dress Down out, Beseech in, a Considering-only change', async () => {
    await mockMoxfield.edit(deck.publicId, [
      { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
      { op: 'add', zone: 'mainboard', card: cardWithFacts('Beseech the Mirror') },
      { op: 'add', zone: 'considering', card: cardWithFacts('Final Fortune') },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(statusHeading(page, 'Uncommitted changes')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Summary of changes' }).getByRole('listitem')).toHaveText([
      '+1 Mainboard',
      '+1 Considering',
      '1 moved to Considering',
    ]);
  });

  const viewToggle = page.getByRole('radiogroup', { name: 'Deck view' });

  await test.step('switch to the cEDH view', async () => {
    await expect(viewToggle.getByRole('radio', { name: 'MTG' })).toHaveAttribute('aria-checked', 'true');
    await viewToggle.getByRole('radio', { name: 'cEDH' }).click();
    await expect(viewToggle.getByRole('radio', { name: 'cEDH' })).toHaveAttribute('aria-checked', 'true');

    await expect(page.getByRole('list', { name: 'Summary of changes' }).getByRole('listitem')).toHaveText([
      '1 to add',
      '1 to cut',
    ]);
    const changes = page.getByRole('region', { name: 'Changes since v1' });
    await expect(changes).toContainText('2 changes');
    await expect(changes.getByRole('region', { name: /^Add/ }).getByRole('listitem')).toHaveText([
      /Add: Beseech the Mirror/,
    ]);
    await expect(changes.getByRole('region', { name: /^Cut/ }).getByRole('listitem')).toHaveText([
      /Cut: Dress Down/,
    ]);
    await expect(changes.getByRole('region', { name: /^Moved/ })).toHaveCount(0);
    await expect(changes).not.toContainText('Considering →');
    await expect(changes).toContainText(
      'Left out by the cEDH view: 1 change outside the sleeved deck (sideboard, Considering).',
    );
    // The suggestion speaks of the sleeving too.
    await expect(page.getByLabel('Commit message')).toHaveAttribute(
      'placeholder',
      'Add Beseech the Mirror; cut Dress Down',
    );
    await expectNoHorizontalOverflow(page);
  });

  await test.step('the choice sticks across the deck’s pages', async () => {
    await deckNav(page).getByRole('link', { name: 'History' }).click();
    await expect(page).toHaveURL(`/decks/${deckId}/history`);
    await expect(viewToggle.getByRole('radio', { name: 'cEDH' })).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('link', { name: 'v1: Tournament list' }).click();
    await page
      .getByRole('navigation', { name: 'Version content' })
      .getByRole('link', { name: /^Deck/ })
      .click();
    const deckList = page.getByRole('region', { name: 'Deck list' });
    await expect(deckList.getByRole('region', { name: /^Mainboard/ })).toBeVisible();
    await expect(deckList.getByRole('region', { name: /^Considering/ })).toHaveCount(0);
    await expect(deckList.getByRole('region', { name: /^Sideboard/ })).toHaveCount(0);
  });

  await test.step('the MTG view brings the move and the boards back', async () => {
    await viewToggle.getByRole('radio', { name: 'MTG' }).click();
    await expect(viewToggle.getByRole('radio', { name: 'MTG' })).toHaveAttribute('aria-checked', 'true');
    const deckList = page.getByRole('region', { name: 'Deck list' });
    await expect(deckList.getByRole('region', { name: /^Considering/ })).toBeVisible();

    await page.goto(`/decks/${deckId}`);
    const changes = page.getByRole('region', { name: 'Changes since v1' });
    await expect(changes.getByRole('region', { name: /^Moved/ })).toContainText(
      'Moved from Mainboard to Considering: Dress Down',
    );
    await expect(changes).not.toContainText('Left out by the cEDH view');
  });
});
