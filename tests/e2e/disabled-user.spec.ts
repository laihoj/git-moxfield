/**
 * Disabling a person (ADR 0006): an admin disables an account on the admin page. Every
 * browser of that person is signed out at once, and nothing signs them in again (not
 * their bookmarklets, not a device link they made before) until the admin enables the
 * account. Their decks are kept. Links withdrawn by disabling stay withdrawn.
 */
import {
  confirmBookmarkletSignIn,
  createDeviceLink,
  expectSignedOut,
  personRow,
  signIn,
  uniqueName,
} from './support/accounts';
import { runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import { createBlueFarmCopy, expectNoHorizontalOverflow } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('a disabled person is signed out and cannot sign in until enabled again', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  // The browser reports the refused capture's status in the console.
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 403/);
  const { user: member, bookmarklets } = await signIn(context, {
    displayName: uniqueName('Benched'),
    bookmarkletLabel: 'Laptop',
  });
  // Made while still enabled.
  const deviceLink = await createDeviceLink(page);
  const adminContext = await newContext();
  await signIn(adminContext, { role: 'admin' });
  const admin = await adminContext.newPage();
  await mockMoxfield.setMode('blocked');
  const deck = await createBlueFarmCopy(testInfo, 'Benched Farm');
  const row = personRow(admin, member.displayName);

  await test.step('the admin disables the account', async () => {
    await admin.goto('/admin');
    await row.getByRole('button', { name: `Disable ${member.displayName}` }).click();
    const confirm = row.getByRole('group');
    await expect(confirm).toContainText(`Disable ${member.displayName}? They are signed out everywhere`);
    await confirm.getByRole('button', { name: 'Disable', exact: true }).click();

    await expect(row).toContainText('Disabled');
    await expect(row.getByRole('button', { name: `Enable ${member.displayName}` })).toBeVisible();
    // Nobody can be helped into a disabled account.
    await expect(row.getByRole('button', { name: /^Create a recovery link/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(admin);
  });

  await test.step('their browser is signed out', async () => {
    await page.reload();
    await expect(page).toHaveURL('/signin?next=%2Faccount');
    await expectSignedOut(page);
  });

  await test.step('their bookmarklet does not sign them in or send decks', async () => {
    await page.goto(mockMoxfield.deckPageUrl(deck.publicId));
    await runBookmarklet(page, bookmarklets['same-tab']);
    await expect(page.getByRole('heading', { level: 1, name: 'Reinstall the bookmarklet' })).toBeVisible();
    await expectSignedOut(page);
  });

  await test.step('a device link they made before does not work', async () => {
    const other = await (await newContext()).newPage();
    await other.goto(deviceLink);
    await expect(
      other.getByRole('heading', { level: 1, name: 'This sign-in link was withdrawn' }),
    ).toBeVisible();
    await expect(other.getByRole('button', { name: 'Sign in on this device' })).toHaveCount(0);
  });

  await test.step('enabled again, their bookmarklet works', async () => {
    await row.getByRole('button', { name: `Enable ${member.displayName}` }).click();
    await expect(row.getByRole('button', { name: `Disable ${member.displayName}` })).toBeVisible();
    await expect(row).not.toContainText('Disabled');

    await page.goto(mockMoxfield.deckPageUrl(deck.publicId));
    await runBookmarklet(page, bookmarklets['same-tab']);
    // Its sessions ended when it was disabled: the bookmarklet asks before signing in again.
    await confirmBookmarkletSignIn(page, member.displayName, 'Laptop');
    await expect(page).toHaveURL(new RegExp(`^${APP_URL}/decks/[^/?#]+\\?captured=1$`));
    await expect(page.getByRole('heading', { level: 1, name: 'Benched Farm' })).toBeVisible();

    // The device link made before disabling stays withdrawn.
    const other = await (await newContext()).newPage();
    await other.goto(deviceLink);
    await expect(
      other.getByRole('heading', { level: 1, name: 'This sign-in link was withdrawn' }),
    ).toBeVisible();
  });
});
