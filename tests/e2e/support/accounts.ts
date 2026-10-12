/**
 * Accounts in e2e tests (ADR 0006). Every page needs a signed-in user, and every test
 * works as users of its own, so tests never see each other's decks.
 *
 * {@link signIn} creates a fresh user through the app's test-only endpoint
 * (`POST /api/e2e/session`, enabled by `GIT_MOXFIELD_E2E=true` in `playwright.config.ts`)
 * and puts the session cookie into a browser context, exactly as the app set it
 * (`HttpOnly`, `SameSite=Lax`, and on http://localhost `Secure` with the `__Host-` name). Optionally the user gets a bookmarklet key, and the
 * response carries both bookmarklets, ready for `runBookmarklet` (`./bookmarklet.ts`).
 * Journeys that are about signing in use the real flows instead (invites, links,
 * bookmarklets); this is the shortcut for everything else.
 *
 * The other helpers are the account UI steps journeys share.
 */
import { randomBytes } from 'node:crypto';

import { test, type BrowserContext, type Locator, type Page } from '@playwright/test';

import type { UserRole } from '@/core/roles';

import type { Bookmarklets } from './bookmarklet';
import { APP_URL } from './constants';
import { expect } from './fixtures';

export interface E2EUser {
  id: string;
  displayName: string;
  role: UserRole;
  workspaceId: string;
}

export interface SignedIn {
  user: E2EUser;
  /** The user's bookmarklets, when `bookmarkletLabel` was given. */
  bookmarklets?: Bookmarklets;
}

/** {@link SignedIn} of a user with a bookmarklet. */
export interface SignedInWithBookmarklets extends SignedIn {
  bookmarklets: Bookmarklets;
}

export interface SignInOptions {
  /** Default: a unique `Tester <hex>`. */
  displayName?: string;
  /** Default: `member`. */
  role?: UserRole;
  /** Creates a bookmarklet key with this label and returns its bookmarklets. */
  bookmarkletLabel?: string;
}

interface SessionResponse {
  user: E2EUser;
  sessionCookie: { name: string; value: string; expiresAt: string; secure: boolean };
  bookmarklets?: { popup: string; sameTab: string };
}

/**
 * A display name no other test uses (the database is shared by every test of a run):
 * `base` plus a random suffix, e.g. `Mikko 3fa9c1`.
 */
export function uniqueName(base: string): string {
  return `${base} ${randomBytes(3).toString('hex')}`;
}

/**
 * Creates a new user and signs `context` in as that user. The session is recorded with
 * the project's browser User-Agent, so device lists name it as the app would.
 */
export async function signIn(
  context: BrowserContext,
  options: SignInOptions & { bookmarkletLabel: string },
): Promise<SignedInWithBookmarklets>;
export async function signIn(context: BrowserContext, options?: SignInOptions): Promise<SignedIn>;
export async function signIn(context: BrowserContext, options: SignInOptions = {}): Promise<SignedIn> {
  const userAgent = test.info().project.use.userAgent;
  const response = await fetch(`${APP_URL}/api/e2e/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(userAgent === undefined ? {} : { 'user-agent': userAgent }),
    },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    throw new Error(
      `POST ${APP_URL}/api/e2e/session answered ${response.status}: ${await response.text()}. Is the app running with GIT_MOXFIELD_E2E=true?`,
    );
  }
  const body = (await response.json()) as SessionResponse;
  const { name, value, expiresAt, secure } = body.sessionCookie;
  // A domain without a leading dot is host-only, as `__Host-` cookies must be. (Chromium
  // refuses `__Host-` cookies given by an http `url` here, though it accepts them from
  // http://localhost responses.)
  await context.addCookies([
    {
      name,
      value,
      domain: new URL(APP_URL).hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure,
      expires: Math.floor(Date.parse(expiresAt) / 1000),
    },
  ]);
  return {
    user: body.user,
    ...(body.bookmarklets === undefined
      ? {}
      : { bookmarklets: { popup: body.bookmarklets.popup, 'same-tab': body.bookmarklets.sameTab } }),
  };
}

/** The setup code while the e2e installation is unclaimed (`null` once any user exists). */
export async function readSetupCode(): Promise<string | null> {
  const response = await fetch(`${APP_URL}/api/e2e/setup-code`);
  if (!response.ok) throw new Error(`GET ${APP_URL}/api/e2e/setup-code answered ${response.status}`);
  return ((await response.json()) as { setupCode: string | null }).setupCode;
}

/**
 * Issues an invite from the command line that expires in `seconds`, for journeys in
 * which it expires while a page shows it (`POST /api/e2e/invite`). Resolves with its expiry.
 */
export async function createExpiringInvite(note: string, seconds: number): Promise<Date> {
  const response = await fetch(`${APP_URL}/api/e2e/invite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note, expiresInSeconds: seconds }),
  });
  if (!response.ok) throw new Error(`POST ${APP_URL}/api/e2e/invite answered ${response.status}`);
  return new Date(((await response.json()) as { expiresAt: string }).expiresAt);
}

/** The header's account menu button of a signed-in page. */
export function accountMenuButton(page: Page, displayName: string): Locator {
  return page.getByRole('button', { name: `Account menu, signed in as ${displayName}` });
}

/** Asserts that the page's header shows `displayName` as the signed-in user. */
export async function expectSignedInAs(page: Page, displayName: string): Promise<void> {
  await expect(accountMenuButton(page, displayName)).toBeVisible();
}

/**
 * Asserts that the page's browser is signed out: the decks page sends it to sign in, and
 * the header has no account menu.
 */
export async function expectSignedOut(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL('/signin');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to git-moxfield' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Account menu/ })).toHaveCount(0);
}

/**
 * Opens the header's account menu (a disclosure, not an ARIA menu) and resolves with the
 * header, where its items are.
 */
export async function openAccountMenu(page: Page, displayName: string): Promise<Locator> {
  const button = accountMenuButton(page, displayName);
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  return page.getByRole('banner');
}

/** Opens the header's account menu and follows one of its links (`Account`, `Admin`). */
export async function openFromAccountMenu(
  page: Page,
  displayName: string,
  item: 'Account' | 'Admin',
): Promise<void> {
  const header = await openAccountMenu(page, displayName);
  await header.getByRole('link', { name: item, exact: true }).click();
  await expect(page).toHaveURL(item === 'Account' ? '/account' : '/admin');
}

/** Signs the page's browser out with the header's account menu; resolves on the sign-in page. */
export async function signOutWithMenu(page: Page, displayName: string): Promise<void> {
  const header = await openAccountMenu(page, displayName);
  await header.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL('/signin');
}

/** The full URL in a one-time link panel (device, recovery or invite link) inside `container`. */
export async function readOneTimeLink(
  container: Locator,
  path: '/signin/gml_' | '/invite/gmi_',
): Promise<string> {
  const link = container.getByText(new RegExp(`^https?://[^\\s]+${path}[A-Za-z0-9_-]{43}$`));
  await expect(link).toBeVisible();
  const url = (await link.textContent())?.trim() ?? '';
  expect(new URL(url).origin).toBe(new URL(APP_URL).origin);
  return url;
}

/**
 * Account › Sign in on another device: creates a one-time device link on `page` (signed
 * in) and returns its URL. Asserts that the QR code is shown with it.
 */
export async function createDeviceLink(page: Page): Promise<string> {
  await page.goto('/account');
  const panel = page.getByRole('region', { name: 'Sign in on another device' });
  await panel.getByRole('button', { name: 'Create a sign-in link' }).click();
  await expect(panel.getByRole('img', { name: 'QR code of the sign-in link' })).toBeVisible();
  await expect(panel).toContainText('works once');
  return readOneTimeLink(panel, '/signin/gml_');
}

/**
 * Opens a one-time device or recovery link on `page` and signs in with its button, as
 * `displayName`. Resolves once the browser has left the link page.
 */
export async function signInWithLink(page: Page, url: string, displayName: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: `Sign in as ${displayName}` })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in on this device' }).click();
  await page.waitForURL((current) => !current.pathname.startsWith('/signin'));
  await expectSignedInAs(page, displayName);
}

/**
 * On the page that asks before a same-tab bookmarklet signs a browser in (a browser that
 * is signed out, or signed in as someone else, gets there): checks that it names the
 * account and the bookmarklet, confirms, and resolves once the browser has left it,
 * signed in as `displayName`.
 */
export async function confirmBookmarkletSignIn(
  page: Page,
  displayName: string,
  bookmarkletLabel: string,
): Promise<void> {
  await expect(page).toHaveURL(/\/signin\/bookmarklet(\?|$)/);
  await expect(page.getByRole('heading', { level: 1, name: `Sign in as ${displayName}?` })).toBeVisible();
  await expect(page.getByRole('main')).toContainText(`“${bookmarkletLabel}”`);
  await page.getByRole('button', { name: `Sign in as ${displayName}`, exact: true }).click();
  await page.waitForURL((current) => current.pathname !== '/signin/bookmarklet');
  await expectSignedInAs(page, displayName);
}

/**
 * The rows of a list, without the list items nested inside them (each row's `·`-joined
 * facts are a list of their own).
 */
function rowsOf(list: Locator): Locator {
  return list.locator(':scope > li');
}

/** The rows of Account › Signed-in devices, this device first. */
export function signedInDevices(page: Page): Locator {
  return rowsOf(page.getByRole('list', { name: 'Signed-in devices' }));
}

/** The rows of Account › Bookmarklets. */
export function bookmarkletRows(page: Page): Locator {
  // Exact: the Account page also lists "Share links of revoked bookmarklets".
  return rowsOf(page.getByRole('list', { name: 'Bookmarklets', exact: true }));
}

/** The row of a person on the admin page. */
export function personRow(page: Page, displayName: string): Locator {
  return rowsOf(page.getByRole('list', { name: 'People' })).filter({
    has: page.getByText(displayName, { exact: true }),
  });
}

/** The rows of the admin page's recovery links that can still be used. */
export function recoveryLinkRows(page: Page): Locator {
  return rowsOf(page.getByRole('list', { name: 'Recovery links' }));
}

/** The row of an invite on the admin page, by its note. */
export function inviteRow(page: Page, note: string): Locator {
  return rowsOf(page.getByRole('list', { name: 'Invites' })).filter({
    has: page.getByText(note, { exact: true }),
  });
}
