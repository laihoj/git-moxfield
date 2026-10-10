'use server';

/**
 * Server actions of the signed-in user's own account (ADR 0006): display name,
 * bookmarklets (keys), signed-in devices (sessions) and device links.
 *
 * Every action resolves the user from the session cookie again (redirecting to sign-in
 * without one) and passes that user to the auth service, which only ever touches the
 * user's own keys, sessions and links: an id sent by the browser can name nothing else.
 * Secrets created here (the key inside new bookmarklets, a device link's token) are
 * returned once to the browser that asked, and never logged.
 */
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { getAuthService } from '@/server/auth';
import { endBrowserSession } from '@/server/auth/cookies';
import { requireUser } from '@/server/auth/current-user';
import type { SessionUser } from '@/server/auth/types';
import { createLogger } from '@/server/logger';
import { isServiceError } from '@/server/services';
import { routes } from '@/lib/routes';

import type {
  AccountActionResult,
  CreateBookmarkletState,
  IssuedLinkState,
  RenameState,
} from './action-types';
import { qrCode } from './qr-code';
import { publicAppUrl } from './request-origin';

const log = createLogger('account-actions');

const GENERIC_ERROR = 'Something went wrong. Please try again.';
const NO_APP_URL =
  'git-moxfield could not tell its own address from this request. Set PUBLIC_APP_URL (for example http://localhost:3000) and try again.';

/** Sanity bound for ids from the browser; the services look them up within the user's scope. */
const idSchema = z.string().trim().min(1).max(128);

/** Longest form value read at all; the auth service validates the exact rules. */
const MAX_FIELD_LENGTH = 512;

function formString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';
}

/** User-facing message: service errors carry one; anything else is logged and hidden. */
function failureMessage(error: unknown, what: string, user: SessionUser): string {
  if (isServiceError(error)) return error.message;
  log.error(`${what} failed`, { error, userId: user.id });
  return GENERIC_ERROR;
}

function revalidateAccount(): void {
  revalidatePath('/account');
  revalidatePath('/setup');
}

/** Changes the signed-in user's display name. */
export async function renameSelfAction(_previous: RenameState, formData: FormData): Promise<RenameState> {
  const user = await requireUser({ next: routes.account() });
  const value = formString(formData, 'name');
  try {
    const outcome = await getAuthService().renameSelf(user, value);
    if (!outcome.ok) return { status: 'error', message: outcome.message, value };
    // The header shows the name on every page.
    revalidatePath('/', 'layout');
    return { status: 'saved', displayName: outcome.user.displayName };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'renameSelf', user), value };
  }
}

/**
 * Creates a bookmarklet key and returns its two bookmarklets, which embed the key. This
 * is the only time they exist outside the user's bookmarks.
 */
export async function createBookmarkletAction(
  _previous: CreateBookmarkletState,
  formData: FormData,
): Promise<CreateBookmarkletState> {
  const user = await requireUser({ next: routes.setup() });
  const label = formString(formData, 'label');
  const appUrl = publicAppUrl(await headers());
  if (appUrl === null) return { status: 'error', message: NO_APP_URL, label };
  try {
    const created = await getAuthService().createBookmarkletKey(user, label, appUrl);
    revalidateAccount();
    return {
      status: 'created',
      id: created.key.id,
      label: created.key.label,
      popup: created.bookmarklets.popup,
      sameTab: created.bookmarklets.sameTab,
    };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'createBookmarkletKey', user), label };
  }
}

/**
 * Revokes one of the user's bookmarklets: browsers it signed in, and browsers signed in
 * with a device link made on one of those, are signed out (except this one). With
 * `includeDerived`, also the bookmarklets made in those browsers.
 */
export async function revokeKeyAction(keyId: string, includeDerived = false): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  const id = idSchema.safeParse(keyId);
  if (!id.success || typeof includeDerived !== 'boolean') return { ok: false, message: 'Invalid request.' };
  try {
    const revoked = await getAuthService().revokeKey(user, id.data, { includeDerived });
    revalidateAccount();
    return revoked ? { ok: true } : { ok: false, message: 'This bookmarklet was already revoked.' };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'revokeKey', user) };
  }
}

/** Signs one of the user's other devices out. */
export async function revokeSessionAction(sessionId: string): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  const id = idSchema.safeParse(sessionId);
  if (!id.success) return { ok: false, message: 'Invalid request.' };
  if (id.data === user.sessionId) {
    return { ok: false, message: 'Use “Sign out” to sign this device out.' };
  }
  try {
    await getAuthService().revokeSession(user, id.data);
    revalidatePath('/account');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'revokeSession', user) };
  }
}

/** Signs every device of the user out except this one, and withdraws unused device links. */
export async function signOutOtherDevicesAction(): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  try {
    await getAuthService().endOtherSessions(user);
    revalidatePath('/account');
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'signOutOtherDevices', user) };
  }
}

/** Signs every device of the user out, this one included, and opens the sign-in page. */
export async function signOutEverywhereAction(): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  try {
    await getAuthService().endAllSessions(user);
    await endBrowserSession();
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'signOutEverywhere', user) };
  }
  redirect(routes.signIn());
}

/** A one-time link (and its QR code) that signs another device in as this user, for 15 minutes. */
export async function createDeviceLinkAction(): Promise<IssuedLinkState> {
  const user = await requireUser({ next: routes.account() });
  const appUrl = publicAppUrl(await headers());
  if (appUrl === null) return { status: 'error', message: NO_APP_URL };
  try {
    const link = await getAuthService().createDeviceLink(user);
    const url = new URL(link.path, appUrl).href;
    return { status: 'created', url, expiresAt: link.expiresAt, qr: qrCode(url) };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'createDeviceLink', user) };
  }
}
