/**
 * Device links (ADR 0006): on a signed-in device, Account › Sign in on another device
 * makes a one-time link (also shown as a QR code) that signs another browser in without a
 * bookmarklet. Opening the link only shows what it does, so a chat app's link preview
 * cannot use it up; its button signs in, once.
 */
import {
  createDeviceLink,
  expectSignedInAs,
  signIn,
  signInWithLink,
  signedInDevices,
} from './support/accounts';
import { APP_URL } from './support/constants';
import { expectNoHorizontalOverflow } from './support/decks';
import { expect, test } from './support/fixtures';

test('a device link signs another browser in, once', async ({ page, context, newContext }) => {
  const { user } = await signIn(context);
  let url = '';

  await test.step('make a sign-in link on the account page', async () => {
    url = await createDeviceLink(page);
    await expectNoHorizontalOverflow(page);
  });

  // A link preview (or a curious glance) opens the page without using the link.
  const preview = await (await newContext()).newPage();

  await test.step('opening the link only shows who it signs in', async () => {
    await preview.goto(url);
    await expect(
      preview.getByRole('heading', { level: 1, name: `Sign in as ${user.displayName}` }),
    ).toBeVisible();
    await expect(preview.getByText('You made this link on another device')).toBeVisible();
    await expect(preview.getByText(/works once/)).toBeVisible();
    await expect(preview.getByRole('button', { name: /^Account menu/ })).toHaveCount(0);
    await expectNoHorizontalOverflow(preview);
  });

  const other = await (await newContext()).newPage();

  await test.step('its button signs the other browser in', async () => {
    await signInWithLink(other, url, user.displayName);
    await expect(other).toHaveURL('/');
    await expectSignedInAs(other, user.displayName);
  });

  await test.step('using it keeps the browser’s session cookie alive for 400 days from the last visit', async () => {
    // A browser that never runs a bookmarklet gets no new cookie at sign-in again. Pretend
    // its cookie was set long ago: it runs out in an hour, and the daily refresh is due.
    const jar = other.context();
    const session = (await jar.cookies(APP_URL)).find((cookie) => cookie.name === '__Host-gm_session');
    if (session === undefined) throw new Error('No session cookie');
    await jar.clearCookies({ name: '__Host-gm_session_fresh' });
    await jar.addCookies([
      {
        name: session.name,
        value: session.value,
        domain: new URL(APP_URL).hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);

    const response = await other.goto('/');
    expect(await response?.headerValue('set-cookie')).toContain(
      `__Host-gm_session=${session.value}; Path=/; Max-Age=34560000; HttpOnly; SameSite=Lax; Secure`,
    );
    const refreshed = (await jar.cookies(APP_URL)).find((cookie) => cookie.name === '__Host-gm_session');
    expect(refreshed?.value).toBe(session.value);
    expect(refreshed?.expires).toBeGreaterThan(Date.now() / 1000 + 399 * 86_400);
    // Once a day at most: the next page view sets nothing.
    const again = await other.goto('/');
    expect(await again?.headerValue('set-cookie')).toBeNull();
    await expectSignedInAs(other, user.displayName);
  });

  await test.step('the link works only once', async () => {
    // The preview still shows the button; pressing it now fails.
    await preview.getByRole('button', { name: 'Sign in on this device' }).click();
    await expect(preview.getByRole('main').getByRole('alert')).toContainText('This link no longer works');
    await expect(preview).toHaveURL(url);

    await preview.reload();
    await expect(
      preview.getByRole('heading', { level: 1, name: 'This sign-in link was already used' }),
    ).toBeVisible();
    await expect(preview.getByText('Make a new one in Account on a signed-in device')).toBeVisible();
    await expect(preview.getByRole('link', { name: 'Other ways to sign in' })).toHaveAttribute(
      'href',
      '/signin',
    );

    // The browser it signed in is not told how to sign in.
    await other.goto(url);
    await expect(
      other.getByRole('heading', { level: 1, name: 'This sign-in link was already used' }),
    ).toBeVisible();
    await expect(other.getByText('Each link signs in once.', { exact: true })).toBeVisible();
    await expect(other.getByRole('link', { name: 'Back to your decks' })).toHaveAttribute('href', '/');
  });

  await test.step('the account lists both browsers', async () => {
    await page.reload();
    await expect(signedInDevices(page)).toHaveCount(2);
    await expect(signedInDevices(page).first()).toContainText('This device');
    await expect(signedInDevices(page).filter({ hasText: 'Signed in with a device link' })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
  });
});

test('a link that is not valid says so', async ({ page }) => {
  await page.goto(`/signin/gml_${'A'.repeat(43)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'This sign-in link doesn’t work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in on this device' })).toHaveCount(0);
});
