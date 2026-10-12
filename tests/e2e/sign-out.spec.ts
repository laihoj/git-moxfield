/**
 * Signing out (ADR 0006): "Sign out" in the header's menu ends this browser's session
 * only; Account › Signed-in devices signs out any other browser; "Sign out everywhere"
 * ends every session of the account, this one included. Bookmarklets keep working: they
 * sign a browser in again.
 */
import type { Page } from '@playwright/test';

import {
  confirmBookmarkletSignIn,
  createDeviceLink,
  expectSignedInAs,
  expectSignedOut,
  signIn,
  signInWithLink,
  signOutWithMenu,
  signedInDevices,
} from './support/accounts';
import { runBookmarklet } from './support/bookmarklet';
import { CAPTURED_DECK_URL } from './support/decks';
import { expect, test, type NewContext } from './support/fixtures';
import { BLUE_FARM_PUBLIC_ID, mockMoxfield } from './support/mock';

/** Signs a new browser in as the user of `page` with a device link; resolves with its page. */
async function signInAnotherBrowser(page: Page, newContext: NewContext, displayName: string): Promise<Page> {
  const url = await createDeviceLink(page);
  const other = await (await newContext()).newPage();
  await signInWithLink(other, url, displayName);
  return other;
}

test('signing out ends one browser’s session, and other browsers can be signed out from Account', async ({
  page,
  context,
  newContext,
}) => {
  const { user } = await signIn(context);
  const laptop = await signInAnotherBrowser(page, newContext, user.displayName);
  const tablet = await signInAnotherBrowser(page, newContext, user.displayName);

  await test.step('the menu’s Sign out signs only that browser out', async () => {
    await signOutWithMenu(laptop, user.displayName);
    await expect(laptop.getByRole('heading', { level: 1, name: 'Sign in to git-moxfield' })).toBeVisible();
    await expectSignedOut(laptop);

    await page.goto('/account');
    await expectSignedInAs(page, user.displayName);
    await expect(signedInDevices(page)).toHaveCount(2);
  });

  await test.step('Account signs another browser out', async () => {
    const tabletRow = signedInDevices(page).filter({ hasText: 'Signed in with a device link' });
    await tabletRow.getByRole('button', { name: /^Sign out/ }).click();
    await expect(signedInDevices(page)).toHaveCount(1);
    await expect(signedInDevices(page)).toContainText('This device');

    await tablet.reload();
    await expect(tablet).toHaveURL('/signin');
    await expectSignedOut(tablet);
  });
});

test('sign out everywhere ends every session; the bookmarklet signs in again', async ({
  page,
  context,
  newContext,
}) => {
  const { user, bookmarklets } = await signIn(context, { bookmarkletLabel: 'Phone' });
  const laptop = await signInAnotherBrowser(page, newContext, user.displayName);
  const phone = await (await newContext()).newPage();
  await mockMoxfield.setMode('blocked');
  await phone.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));
  await runBookmarklet(phone, bookmarklets['same-tab']);
  await confirmBookmarkletSignIn(phone, user.displayName, 'Phone');

  await test.step('sign out everywhere from Account', async () => {
    await page.goto('/account');
    await expect(signedInDevices(page)).toHaveCount(3);
    const signOut = page.getByRole('region', { name: 'Sign out' });
    await signOut.getByRole('button', { name: 'Sign out everywhere' }).click();
    const confirm = signOut.getByRole('group');
    await expect(confirm).toContainText('Sign out on every device, this one included?');
    await confirm.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page).toHaveURL('/signin');
  });

  await test.step('every browser is signed out', async () => {
    await expectSignedOut(page);
    await expectSignedOut(laptop);
    await expectSignedOut(phone);
  });

  await test.step('the bookmarklet still works and signs the phone in again, once confirmed', async () => {
    await phone.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));
    await runBookmarklet(phone, bookmarklets['same-tab']);
    await confirmBookmarkletSignIn(phone, user.displayName, 'Phone');
    await expect(phone).toHaveURL(CAPTURED_DECK_URL);
    await expectSignedInAs(phone, user.displayName);
  });
});
