/**
 * Revoking a bookmarklet (ADR 0006): a bookmarklet is a personal key. Revoked in
 * Account, it stops working at once, in both modes, and the browsers it signed in are
 * signed out (except the one revoking it). Nothing it sends afterwards is accepted.
 */
import {
  bookmarkletRows,
  confirmBookmarkletSignIn,
  expectSignedInAs,
  expectSignedOut,
  signIn,
  signedInDevices,
} from './support/accounts';
import { runBookmarklet } from './support/bookmarklet';
import { CAPTURED_DECK_URL, createBlueFarmCopy, deckIdFromUrl } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('a revoked bookmarklet signs its browsers out and no longer signs in or sends decks', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  // The browser reports the refused captures' statuses in the console.
  consoleErrors.allowHttpStatus(401, 403);
  const { user, bookmarklets } = await signIn(context, { bookmarkletLabel: 'Old phone' });
  await mockMoxfield.setMode('blocked');
  const kept = await createBlueFarmCopy(testInfo, 'Kept Farm');
  const refused = await createBlueFarmCopy(testInfo, 'Refused Farm');
  const phone = await (await newContext()).newPage();
  let deckPath = '';

  await test.step('the bookmarklet signs a phone in', async () => {
    await phone.goto(mockMoxfield.deckPageUrl(kept.publicId));
    await runBookmarklet(phone, bookmarklets['same-tab']);
    await confirmBookmarkletSignIn(phone, user.displayName, 'Old phone');
    await expect(phone).toHaveURL(CAPTURED_DECK_URL);
    deckPath = `/decks/${deckIdFromUrl(phone.url())}`;
    await expectSignedInAs(phone, user.displayName);
  });

  await test.step('revoking it on the computer signs the phone out', async () => {
    await page.goto('/account');
    await expect(signedInDevices(page)).toHaveCount(2);
    const row = bookmarkletRows(page).filter({ hasText: 'Old phone' });
    await expect(row).toContainText('Last used');
    await row.getByRole('button', { name: 'Revoke Old phone' }).click();
    await row.getByRole('group').getByRole('button', { name: 'Revoke bookmarklet' }).click();
    await expect(page.getByText('No bookmarklets yet')).toBeVisible();

    // The computer, which revoked it, stays signed in.
    await expect(signedInDevices(page)).toHaveCount(1);
    await expect(signedInDevices(page)).toContainText('This device');
    await page.reload();
    await expectSignedInAs(page, user.displayName);

    await phone.reload();
    await expect(phone).toHaveURL(`/signin?next=${encodeURIComponent(deckPath)}`);
  });

  await test.step('the same-tab bookmarklet is refused', async () => {
    await phone.goto(mockMoxfield.deckPageUrl(refused.publicId));
    await runBookmarklet(phone, bookmarklets['same-tab']);
    await expect(phone.getByRole('heading', { level: 1, name: 'Reinstall the bookmarklet' })).toBeVisible();
    await expectSignedOut(phone);
  });

  if (testInfo.project.name === 'desktop') {
    await test.step('the popup bookmarklet is refused', async () => {
      await phone.goto(mockMoxfield.deckPageUrl(refused.publicId));
      const popup = await runBookmarklet(phone, bookmarklets.popup);
      const problem = popup.getByRole('alert').filter({ hasText: 'This bookmarklet no longer works' });
      await expect(problem).toBeVisible();
      await expect(problem.getByRole('link', { name: 'Make a new bookmarklet' })).toHaveAttribute(
        'href',
        '/setup',
      );
      // The Moxfield tab is told, too.
      await expect(phone.getByRole('status')).toContainText(
        'git-moxfield: Could not import the deck: This bookmarklet is no longer valid',
      );
      await expectSignedOut(popup);
    });
  }

  await test.step('nothing it sent after the revocation was accepted', async () => {
    await page.goto('/');
    await expect(page.getByRole('link', { name: 'Kept Farm' })).toHaveAttribute('href', deckPath);
    await expect(page.getByText('Refused Farm')).toHaveCount(0);
  });
});
