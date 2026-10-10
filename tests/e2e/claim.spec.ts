/**
 * First run (ADR 0006): a fresh git-moxfield has no users. Its setup code is printed to
 * the server log (here read through the test-only `GET /api/e2e/setup-code`), and whoever
 * enters it at `/claim` becomes the first admin. Afterwards nobody can claim it again.
 *
 * Runs as the `first-run` project, before every other test: as soon as any user exists,
 * the installation can no longer be claimed (see `playwright.config.ts`).
 */
import { devices } from '@playwright/test';

import { expectSignedInAs, openFromAccountMenu, personRow, readSetupCode } from './support/accounts';
import { expectNoHorizontalOverflow } from './support/decks';
import { expect, test } from './support/fixtures';

const ADMIN_NAME = 'Ada Admin';

test('the first visitor with the setup code becomes the admin', async ({ page, newContext }) => {
  const setupCode = await readSetupCode();
  if (setupCode === null) {
    throw new Error(
      'The e2e installation is claimed already: the global setup deletes its database, so restart a reused app server.',
    );
  }
  expect(setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  await test.step('a fresh installation offers to be set up on the sign-in page', async () => {
    await page.goto('/');
    await expect(page).toHaveURL('/signin');
    const claim = page.getByRole('region', { name: 'This git-moxfield has no admin yet' });
    await expect(claim).toBeVisible();
    await claim.getByRole('link', { name: 'Set up git-moxfield' }).click();
    await expect(page).toHaveURL('/claim');
    await expect(page.getByRole('heading', { level: 1, name: 'Set up git-moxfield' })).toBeVisible();
    await expect(page.getByLabel('Setup code')).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });

  await test.step('the setup page fits a phone', async () => {
    const phone = await (await newContext({ ...devices['Pixel 7'] })).newPage();
    await phone.goto('/claim');
    await expect(phone.getByRole('button', { name: 'Become the admin' })).toBeVisible();
    await expectNoHorizontalOverflow(phone);
  });

  await test.step('a wrong setup code is refused, and what was typed is kept', async () => {
    await page.getByLabel('Setup code').fill('AAAA-BBBB-CCCC');
    await page.getByLabel('Your name').fill(ADMIN_NAME);
    await page.getByRole('button', { name: 'Become the admin' }).click();

    const code = page.getByLabel('Setup code');
    await expect(code).toHaveAttribute('aria-invalid', 'true');
    await expect(code).toHaveAccessibleDescription(/That is not the setup code/);
    await expect(code).toHaveValue('AAAA-BBBB-CCCC');
    await expect(page.getByLabel('Your name')).toHaveValue(ADMIN_NAME);
    await expect(page).toHaveURL('/claim');
  });

  await test.step('the setup code from the server log makes this browser the admin', async () => {
    // Typed the way people do: lower case, spaces instead of dashes.
    await page.getByLabel('Setup code').fill(setupCode.toLowerCase().replaceAll('-', ' '));
    await page.getByRole('button', { name: 'Become the admin' }).click();

    // A fresh installation has no decks to take over: plain "claimed" welcome.
    await expect(page).toHaveURL('/setup?welcome=claimed');
    const welcome = page.getByRole('region', { name: 'You’re the admin of this git-moxfield' });
    await expect(welcome).toContainText('Make your bookmarklet first. Then invite friends from Admin');
    await expect(welcome).not.toContainText('already here');
    await expectSignedInAs(page, ADMIN_NAME);
    // Onboarding leads with making a bookmarklet.
    await expect(page.getByLabel('Name your bookmarklet')).toBeFocused();
    await expectNoHorizontalOverflow(page);

    // The setup code is used up.
    expect(await readSetupCode()).toBeNull();
  });

  await test.step('the admin manages accounts from Admin', async () => {
    await openFromAccountMenu(page, ADMIN_NAME, 'Admin');
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    const me = personRow(page, ADMIN_NAME);
    await expect(me).toHaveCount(1);
    await expect(me).toContainText('You');
    await expect(me).toContainText('Admin');
    // Admins cannot lock themselves out.
    await expect(me.getByRole('button', { name: /^Disable/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  await test.step('nobody can claim it again', async () => {
    const stranger = await (await newContext()).newPage();
    await stranger.goto('/claim');
    await expect(stranger).toHaveURL('/signin');
    await expect(stranger.getByRole('link', { name: 'Set up git-moxfield' })).toHaveCount(0);

    // The admin is sent on to the decks.
    await page.goto('/claim');
    await expect(page).toHaveURL('/');
  });
});
