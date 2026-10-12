/**
 * The Compare menu of a version page is a popover like the account menu: it closes when
 * keyboard focus moves out of it (Tab past the last item), not only on an outside click or
 * Escape.
 */
import { signIn } from './support/accounts';
import { commitVersion, trackAndCommitV1 } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('the Compare menu closes when focus tabs out of it', async ({ page, context }, testInfo) => {
  await signIn(context);
  const { deck, deckId } = await trackAndCommitV1(page, testInfo, {
    name: 'Compare Menu Farm',
    message: 'Baseline',
    confirm: 'status',
  });
  await mockMoxfield.edit(deck.publicId, [
    { op: 'move', card: 'Null Rod', from: 'sideboard', to: 'mainboard' },
  ]);
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Uncommitted changes' })).toBeVisible();
  await commitVersion(page, { sequence: 2, message: 'Null Rod main' });
  await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v2' })).toBeVisible();

  await page.goto(`/decks/${deckId}/versions/2`);
  const button = page.getByRole('button', { name: 'Compare', exact: true });
  const menu = page.getByRole('menu', { name: 'Compare this version' });

  await test.step('it opens with the first item focused', async () => {
    await button.click();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
  });

  await test.step('Escape closes it and focus returns to the button', async () => {
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
  });

  await test.step('tabbing past the last item closes it', async () => {
    await button.click();
    await expect(menu).toBeVisible();
    const items = await menu.getByRole('menuitem').count();
    expect(items).toBeGreaterThan(0);
    // The first item has focus: one Tab per item leaves the menu.
    for (let tab = 0; tab < items; tab += 1) await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
  });
});
