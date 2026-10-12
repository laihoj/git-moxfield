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
import { redirect } from 'next/navigation';

import { getAuthService } from '@/server/auth';
import { endBrowserSession } from '@/server/auth/cookies';
import { requireUser } from '@/server/auth/current-user';
import { createLogger } from '@/server/logger';
import { absoluteAppUrl } from '@/core/http-url';
import { routePatterns, routes } from '@/lib/routes';

import type {
  AccountActionResult,
  CreateBookmarkletState,
  IssuedLinkState,
  RenameState,
} from './action-types';
import { qrCode } from './qr-code';
import { failureMessage, formString, idSchema, INVALID_REQUEST } from './action-support';
import { actionAppUrl } from './request-origin';

const log = createLogger('account-actions');

function revalidateAccount(): void {
  revalidatePath(routes.account());
  revalidatePath(routes.setup());
}

/** Changes the signed-in user's display name. */
export async function renameSelfAction(_previous: RenameState, formData: FormData): Promise<RenameState> {
  const user = await requireUser({ next: routes.account() });
  const value = formString(formData, 'name');
  try {
    const auth = await getAuthService();
    const outcome = await auth.renameSelf(user, value);
    if (!outcome.ok) return { status: 'error', message: outcome.message, value };
    // The header shows the name on every page.
    revalidatePath(routes.home(), 'layout');
    return { status: 'saved', displayName: outcome.user.displayName };
  } catch (error) {
    return { status: 'error', message: failureMessage(log, error, 'renameSelf', { userId: user.id }), value };
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
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message, label };
  try {
    const auth = await getAuthService();
    const created = await auth.createBookmarkletKey(user, label, app.appUrl);
    revalidateAccount();
    return {
      status: 'created',
      id: created.key.id,
      label: created.key.label,
      popup: created.bookmarklets.popup,
      sameTab: created.bookmarklets.sameTab,
    };
  } catch (error) {
    return {
      status: 'error',
      message: failureMessage(log, error, 'createBookmarkletKey', { userId: user.id }),
      label,
    };
  }
}

/**
 * Revokes one of the user's bookmarklets: browsers it signed in, and browsers signed in
 * with a device link made on one of those, are signed out (except this one). With
 * `includeDerived`, also the bookmarklets made in those browsers; with
 * `includeShareLinks`, also the share links made in those browsers (ADR 0007), which
 * would otherwise keep working.
 */
export async function revokeKeyAction(
  keyId: string,
  includeDerived = false,
  includeShareLinks = false,
): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  const id = idSchema.safeParse(keyId);
  if (!id.success || typeof includeDerived !== 'boolean' || typeof includeShareLinks !== 'boolean') {
    return { ok: false, message: INVALID_REQUEST };
  }
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeKey(user, id.data, { includeDerived, includeShareLinks });
    revalidateAccount();
    // Every deck's Share page lists its links.
    if (includeShareLinks) revalidatePath(routePatterns.deckShare, 'page');
    return revoked ? { ok: true } : { ok: false, message: 'This bookmarklet was already revoked.' };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'revokeKey', { userId: user.id }) };
  }
}

/**
 * Revokes the share links (ADR 0007) made in browsers one of the user's bookmarklets
 * signed in, also after the bookmarklet itself was revoked without them.
 */
export async function revokeKeyShareLinksAction(keyId: string): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  const id = idSchema.safeParse(keyId);
  if (!id.success) return { ok: false, message: INVALID_REQUEST };
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeKeyShareLinks(user, id.data);
    revalidatePath(routes.account());
    // Every deck's Share page lists its links.
    revalidatePath(routePatterns.deckShare, 'page');
    return revoked > 0 ? { ok: true } : { ok: false, message: 'These share links were already revoked.' };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'revokeKeyShareLinks', { userId: user.id }) };
  }
}

/** Signs one of the user's other devices out. */
export async function revokeSessionAction(sessionId: string): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  const id = idSchema.safeParse(sessionId);
  if (!id.success) return { ok: false, message: INVALID_REQUEST };
  if (id.data === user.sessionId) {
    return { ok: false, message: 'Use “Sign out” to sign this device out.' };
  }
  try {
    const auth = await getAuthService();
    await auth.revokeSession(user, id.data);
    revalidatePath(routes.account());
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'revokeSession', { userId: user.id }) };
  }
}

/** Signs every device of the user out except this one, and withdraws unused device links. */
export async function signOutOtherDevicesAction(): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  try {
    const auth = await getAuthService();
    await auth.endOtherSessions(user);
    revalidatePath(routes.account());
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'signOutOtherDevices', { userId: user.id }) };
  }
}

/** Signs every device of the user out, this one included, and opens the sign-in page. */
export async function signOutEverywhereAction(): Promise<AccountActionResult> {
  const user = await requireUser({ next: routes.account() });
  try {
    const auth = await getAuthService();
    await auth.endAllSessions(user);
    await endBrowserSession();
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'signOutEverywhere', { userId: user.id }) };
  }
  redirect(routes.signIn());
}

/** A one-time link (and its QR code) that signs another device in as this user, for 15 minutes. */
export async function createDeviceLinkAction(): Promise<IssuedLinkState> {
  const user = await requireUser({ next: routes.account() });
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message };
  try {
    const auth = await getAuthService();
    const link = await auth.createDeviceLink(user);
    const url = absoluteAppUrl(link.path, app.appUrl);
    return { status: 'created', url, expiresAt: link.expiresAt, qr: qrCode(url) };
  } catch (error) {
    return { status: 'error', message: failureMessage(log, error, 'createDeviceLink', { userId: user.id }) };
  }
}
