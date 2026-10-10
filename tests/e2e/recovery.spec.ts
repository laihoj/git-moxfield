/**
 * Recovery (ADR 0006): someone who lost every bookmarklet and every signed-in browser
 * asks an admin, who makes a one-time recovery link for them on the admin page. The link
 * signs them in once; their decks and history are untouched, and they make a new
 * bookmarklet. Whoever opens a recovery link is signed in as its person, so using one
 * signs out every other browser of theirs and revokes their bookmarklets (a lost or
 * stolen device is cut off), and their Account page keeps a record of whose link it was.
 * Admins see the links that can still be used and can withdraw them.
 */
import {
  bookmarkletRows,
  expectSignedInAs,
  expectSignedOut,
  personRow,
  readOneTimeLink,
  recoveryLinkRows,
  signIn,
  signOutWithMenu,
  signedInDevices,
  uniqueName,
} from './support/accounts';
import { createBookmarkletOnSetupPage, runBookmarklet } from './support/bookmarklet';
import { APP_URL } from './support/constants';
import { commitVersion, createBlueFarmCopy, expectNoHorizontalOverflow, trackDeck } from './support/decks';
import { expect, test } from './support/fixtures';
import { BLUE_FARM_PUBLIC_ID, mockMoxfield } from './support/mock';

test('a recovery link lets someone back in after they revoked every bookmarklet', async ({
  page,
  context,
  newContext,
}, testInfo) => {
  const { user } = await signIn(context, {
    displayName: uniqueName('Forgetful'),
    bookmarkletLabel: 'Lost laptop',
  });
  const deck = await createBlueFarmCopy(testInfo, 'Treasured Farm');
  const deckId = await trackDeck(page, mockMoxfield.deckPageUrl(deck.publicId));
  await commitVersion(page, { sequence: 1, message: 'Before the loss' });
  await expect(page.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
  let recoveryUrl = '';

  await test.step('they revoke their only bookmarklet and sign out', async () => {
    await page.goto('/account');
    const row = bookmarkletRows(page).filter({ hasText: 'Lost laptop' });
    await row.getByRole('button', { name: 'Revoke Lost laptop' }).click();
    const confirm = row.getByRole('group');
    await expect(confirm).toContainText('Revoke “Lost laptop”? It stops working at once');
    await confirm.getByRole('button', { name: 'Revoke bookmarklet' }).click();
    await expect(page.getByText('No bookmarklets yet')).toBeVisible();

    await signOutWithMenu(page, user.displayName);
    await expectSignedOut(page);
  });

  const adminContext = await newContext();
  const { user: adminUser } = await signIn(adminContext, {
    role: 'admin',
    displayName: uniqueName('Helper'),
  });
  const admin = await adminContext.newPage();

  await test.step('an admin makes a recovery link for them', async () => {
    await admin.goto('/admin');
    const row = personRow(admin, user.displayName);
    await expect(row).toContainText('1 deck');
    await expect(row).toContainText('0 bookmarklets');
    await row.getByRole('button', { name: `Create a recovery link for ${user.displayName}` }).click();
    await expect(row).toContainText(
      `Send this only to ${user.displayName}: whoever opens it signs in as them, and their other devices and bookmarklets are signed out.`,
    );
    recoveryUrl = await readOneTimeLink(row, '/signin/gml_');
    await expectNoHorizontalOverflow(admin);

    // The admin can put the link away; it is never shown again, only listed as outstanding.
    await row.getByRole('button', { name: 'Hide recovery link' }).click();
    await expect(row.getByText(recoveryUrl)).toHaveCount(0);
    const outstanding = recoveryLinkRows(admin).filter({ hasText: `For ${user.displayName}` });
    await expect(outstanding).toContainText(`By ${adminUser.displayName}`);
    await expect(outstanding).toContainText('Expires in');
    await expect(admin.getByRole('main')).not.toContainText(recoveryUrl);
  });

  const newBrowser = await (await newContext()).newPage();

  await test.step('the recovery link signs them in on a new browser', async () => {
    await newBrowser.goto(recoveryUrl);
    await expect(
      newBrowser.getByRole('heading', { level: 1, name: `Sign in as ${user.displayName}` }),
    ).toBeVisible();
    await expect(newBrowser.getByText('Your admin made this recovery link for you.')).toBeVisible();
    await expect(newBrowser.getByText('This signs out every other device')).toBeVisible();
    await expectNoHorizontalOverflow(newBrowser);
    await newBrowser.getByRole('button', { name: 'Sign in on this device' }).click();

    await expect(newBrowser).toHaveURL('/setup?welcome=recovery');
    await expect(newBrowser.getByRole('region', { name: `Welcome back, ${user.displayName}` })).toContainText(
      'Every other device was signed out and your old bookmarklets were revoked',
    );
  });

  await test.step('their account shows whose recovery link signed in, and the admin no longer lists it', async () => {
    await newBrowser.goto('/account');
    const used = newBrowser.getByRole('list', { name: 'Recovery links used' });
    await expect(used).toContainText(`Recovery link from ${adminUser.displayName}`);
    await expect(used).toContainText('Used');
    await expectNoHorizontalOverflow(newBrowser);
    await admin.reload();
    await expect(admin.getByRole('list', { name: 'Recovery links' })).toHaveCount(0);
  });

  await test.step('their decks and history are untouched', async () => {
    await newBrowser.goto('/');
    await newBrowser.getByRole('link', { name: 'Treasured Farm' }).click();
    await expect(newBrowser).toHaveURL(`/decks/${deckId}`);
    await expect(newBrowser.getByRole('heading', { level: 2, name: 'Up to date with v1' })).toBeVisible();
  });

  await test.step('a new bookmarklet works', async () => {
    const bookmarklets = await createBookmarkletOnSetupPage(newBrowser, 'New laptop');
    await newBrowser.goto(mockMoxfield.deckPageUrl(deck.publicId));
    await runBookmarklet(newBrowser, bookmarklets['same-tab']);
    await expect(newBrowser).toHaveURL(`${APP_URL}/decks/${deckId}?captured=1`);
  });

  await test.step('the recovery link is used up', async () => {
    const stranger = await (await newContext()).newPage();
    await stranger.goto(recoveryUrl);
    await expect(
      stranger.getByRole('heading', { level: 1, name: 'This sign-in link was already used' }),
    ).toBeVisible();
  });
});

test('a recovery link signs the lost devices out, and an admin can withdraw one before it is used', async ({
  page,
  context,
  newContext,
  consoleErrors,
}) => {
  // The browser reports the refused capture's status in the console.
  consoleErrors.allow(/Failed to load resource: the server responded with a status of 403/);
  const { user, bookmarklets } = await signIn(context, {
    displayName: uniqueName('Robbed'),
    bookmarkletLabel: 'Stolen laptop',
  });
  const adminContext = await newContext();
  await signIn(adminContext, { role: 'admin' });
  const admin = await adminContext.newPage();
  await admin.goto('/admin');
  const row = personRow(admin, user.displayName);
  const create = row.getByRole('button', { name: `Create a recovery link for ${user.displayName}` });
  let firstUrl = '';

  await test.step('an outstanding recovery link can be withdrawn; it then stops working', async () => {
    await create.click();
    firstUrl = await readOneTimeLink(row, '/signin/gml_');
    const outstanding = recoveryLinkRows(admin).filter({ hasText: `For ${user.displayName}` });
    await outstanding
      .getByRole('button', { name: `Withdraw the recovery link for ${user.displayName}` })
      .click();
    await outstanding.getByRole('group').getByRole('button', { name: 'Withdraw link' }).click();
    await expect(admin.getByRole('list', { name: 'Recovery links' })).toHaveCount(0);

    const stranger = await (await newContext()).newPage();
    await stranger.goto(firstUrl);
    await expect(
      stranger.getByRole('heading', { level: 1, name: 'This sign-in link was withdrawn' }),
    ).toBeVisible();
  });

  await test.step('using a recovery link signs the stolen laptop out and revokes its bookmarklet', async () => {
    // The withdrawn link is no longer shown in the person's row either.
    await expect(row.getByText(firstUrl)).toHaveCount(0);
    await create.click();
    const url = await readOneTimeLink(row, '/signin/gml_');
    const newLaptop = await (await newContext()).newPage();
    await newLaptop.goto(url);
    await newLaptop.getByRole('button', { name: 'Sign in on this device' }).click();
    await expect(newLaptop).toHaveURL('/setup?welcome=recovery');
    await expectSignedInAs(newLaptop, user.displayName);

    await expectSignedOut(page);
    await newLaptop.goto('/account');
    await expect(newLaptop.getByText('No bookmarklets yet')).toBeVisible();
    await expect(signedInDevices(newLaptop)).toHaveCount(1);
    await expect(newLaptop.getByRole('list', { name: 'Recovery links used' })).toContainText(
      'Recovery link from',
    );
  });

  await test.step('the stolen bookmarklet no longer works', async () => {
    await mockMoxfield.setMode('blocked');
    await page.goto(mockMoxfield.deckPageUrl(BLUE_FARM_PUBLIC_ID));
    await runBookmarklet(page, bookmarklets['same-tab']);
    await expect(page.getByRole('heading', { level: 1, name: 'Reinstall the bookmarklet' })).toBeVisible();
  });
});
