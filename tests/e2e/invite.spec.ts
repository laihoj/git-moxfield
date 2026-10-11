/**
 * Invites (ADR 0006): an admin makes a one-time invite link on the admin page and sends
 * it; the friend opens it in their own browser, picks a name, and is signed in to a new,
 * empty account. Next they make their personal bookmarklet, which sends decks and signs
 * their browsers in. The link works once; withdrawn invites stop working; members have
 * no admin page.
 */
import {
  expectSignedInAs,
  inviteRow,
  openFromAccountMenu,
  personRow,
  readOneTimeLink,
  signIn,
  uniqueName,
  openAccountMenu,
} from './support/accounts';
import { createBookmarkletOnSetupPage, runBookmarklet } from './support/bookmarklet';
import { CAPTURED_DECK_URL, createBlueFarmCopy, expectNoHorizontalOverflow } from './support/decks';
import { expect, test } from './support/fixtures';
import { mockMoxfield } from './support/mock';

test('an admin invites a friend, who makes an account and a bookmarklet', async ({
  page,
  context,
  newContext,
  consoleErrors,
}, testInfo) => {
  const { user: admin } = await signIn(context, { role: 'admin', displayName: uniqueName('Admin') });
  const friendName = uniqueName('Mikko');
  const note = `${friendName} from the Tuesday pod`;
  const friend = await (await newContext()).newPage();
  let inviteUrl = '';

  await test.step('the admin makes an invite link', async () => {
    await page.goto('/');
    await openFromAccountMenu(page, admin.displayName, 'Admin');
    await page.getByLabel('Who is it for?').fill(note);
    await expect(page.getByRole('radio', { name: /^Member/ })).toBeChecked();
    await page.getByRole('button', { name: 'Create invite link' }).click();

    const created = page.getByRole('status', { name: 'New invite link' });
    await expect(created).toContainText('Invite link ready');
    await expect(created).toContainText(`Send it to ${note}. It makes one member account.`);
    inviteUrl = await readOneTimeLink(created, '/invite/gmi_');
    await expect(created.getByRole('button', { name: 'Copy invite link' })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const row = inviteRow(page, note);
    await expect(row).toContainText('Pending');
    await expect(row).toContainText(`By ${admin.displayName}`);
  });

  await test.step('the friend opens the link and makes an account', async () => {
    await friend.goto(inviteUrl);
    await expect(
      friend.getByRole('heading', { level: 1, name: 'You’re invited to git-moxfield' }),
    ).toBeVisible();
    await expect(friend.getByText('Member', { exact: true })).toBeVisible();
    // Signed out, the header shows only the brand.
    await expect(friend.getByRole('button', { name: /^Account menu/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(friend);

    const name = friend.getByLabel('Your name');
    await expect(name).toBeFocused();
    await name.fill(friendName);
    await friend.getByRole('button', { name: 'Create my account' }).click();

    await expect(friend).toHaveURL('/setup?welcome=invite');
    await expect(
      friend.getByRole('region', { name: `Welcome to git-moxfield, ${friendName}` }),
    ).toBeVisible();
    await expectSignedInAs(friend, friendName);
    await expectNoHorizontalOverflow(friend);
  });

  await test.step('the friend makes a bookmarklet, named after their browser', async () => {
    const label = friend.getByLabel('Name your bookmarklet');
    await expect(label).toBeFocused();
    await expect(label).toHaveValue(
      testInfo.project.name === 'mobile' ? 'Chrome on Android' : 'Chrome on Windows',
    );
    const bookmarklets = await createBookmarkletOnSetupPage(friend, 'My browser');

    // It works: it sends a deck into the friend's new account.
    await mockMoxfield.setMode('blocked');
    const deck = await createBlueFarmCopy(testInfo, 'First Farm');
    await friend.goto(mockMoxfield.deckPageUrl(deck.publicId));
    await runBookmarklet(friend, bookmarklets['same-tab']);
    await expect(friend).toHaveURL(CAPTURED_DECK_URL);
    await expect(friend.getByRole('heading', { level: 1, name: 'First Farm' })).toBeVisible();
    await expectSignedInAs(friend, friendName);
  });

  await test.step('the invite is used up', async () => {
    await friend.goto(inviteUrl);
    await expect(
      friend.getByRole('heading', { level: 1, name: 'This invite has already been used' }),
    ).toBeVisible();
    await expect(friend.getByRole('link', { name: 'Back to your decks' })).toBeVisible();

    await page.reload();
    const row = inviteRow(page, note);
    await expect(row).toContainText('Accepted');
    await expect(row).toContainText(`Accepted by ${friendName}`);
    await expect(row.getByRole('button', { name: /^Withdraw/ })).toHaveCount(0);
    const person = personRow(page, friendName);
    await expect(person).not.toContainText('Admin');
    await expect(person).toContainText('1 deck');
    await expect(person).toContainText('1 bookmarklet');
  });

  await test.step('members have no admin page', async () => {
    const header = await openAccountMenu(friend, friendName);
    await expect(header.getByRole('link', { name: 'Account', exact: true })).toBeVisible();
    await expect(header.getByRole('link', { name: 'Admin', exact: true })).toHaveCount(0);
    // As if it did not exist (the browser reports the 404 in the console).
    consoleErrors.allowHttpStatus(404);
    const response = await friend.goto('/admin');
    expect(response?.status()).toBe(404);
    await expect(friend.getByRole('heading', { level: 1, name: 'We couldn’t find that' })).toBeVisible();
  });
});

test('an admin invite makes another admin, and a withdrawn invite stops working', async ({
  page,
  context,
  newContext,
}) => {
  const { user: admin } = await signIn(context, { role: 'admin', displayName: uniqueName('Admin') });
  const coAdminName = uniqueName('Co-admin');
  const withdrawnNote = uniqueName('Not after all');

  await page.goto('/admin');
  await page.getByLabel('Who is it for?').fill(coAdminName);
  await page.getByRole('radio', { name: /^Admin/ }).check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const adminInvite = page.getByRole('status', { name: 'New invite link' });
  await expect(adminInvite).toContainText('It makes one admin account.');
  const adminInviteUrl = await readOneTimeLink(adminInvite, '/invite/gmi_');

  await page.getByLabel('Who is it for?').fill(withdrawnNote);
  await page.getByRole('radio', { name: /^Member/ }).check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const memberInvite = page.getByRole('status', { name: 'New invite link' });
  await expect(memberInvite).toContainText(`Send it to ${withdrawnNote}.`);
  const withdrawnUrl = await readOneTimeLink(memberInvite, '/invite/gmi_');

  await test.step('the admin withdraws an invite; its link stops working', async () => {
    const row = inviteRow(page, withdrawnNote);
    await row.getByRole('button', { name: `Withdraw the invite for ${withdrawnNote}` }).click();
    await row.getByRole('group').getByRole('button', { name: 'Withdraw invite' }).click();
    await expect(row).toContainText('Withdrawn');

    const stranger = await (await newContext()).newPage();
    await stranger.goto(withdrawnUrl);
    await expect(
      stranger.getByRole('heading', { level: 1, name: 'This invite was withdrawn' }),
    ).toBeVisible();
    await expect(stranger.getByRole('button', { name: 'Create my account' })).toHaveCount(0);
  });

  await test.step('an admin invite makes an admin', async () => {
    const coAdmin = await (await newContext()).newPage();
    await coAdmin.goto(adminInviteUrl);
    await expect(coAdmin.getByText('Admin', { exact: true })).toBeVisible();
    await coAdmin.getByLabel('Your name').fill(coAdminName);
    await coAdmin.getByRole('button', { name: 'Create my account' }).click();
    await expect(coAdmin).toHaveURL('/setup?welcome=invite');
    await openFromAccountMenu(coAdmin, coAdminName, 'Admin');
    await expect(personRow(coAdmin, coAdminName)).toContainText('You');
    await expect(personRow(coAdmin, admin.displayName)).toContainText('Admin');
    // Admins manage accounts, never decks: nothing on the page leads to anyone's decks.
    await expect(coAdmin.getByRole('main').locator('a[href^="/decks/"]')).toHaveCount(0);
  });
});
