/**
 * Helpers for tests of the account system: signing users in through the real invite
 * flow, and reading tokens back out of the links and bookmarklets the auth service
 * hands out (which is the only place they appear in plaintext).
 */
import { expect } from 'vitest';

import { SYSTEM_ACTOR, type AuthService } from '@/server/auth/service';
import { tokenOfLinkPath } from '@/server/auth/paths';
import type { SessionUser, SignIn, UserRole } from '@/server/auth/types';

import { bookmarkletKey } from './bookmarklet';
import { rejectionOf } from './errors';

/** The token at the end of a link path (`/invite/gmi_…`, `/signin/gml_…`). */
export const tokenOfPath = tokenOfLinkPath;

/** The bookmarklet key embedded in a `javascript:` bookmarklet. */
export { bookmarkletKey as keyOfBookmarklet };

/**
 * Creates a bookmarklet key for `user` and returns it (`gmk_…`). Defaults: the label
 * `Laptop`, the popup bookmarklet, `http://localhost:3000` as the app.
 */
export async function createKey(
  auth: AuthService,
  user: SessionUser,
  options: { label?: string; mode?: 'popup' | 'sameTab'; appUrl?: string } = {},
): Promise<string> {
  const { label = 'Laptop', mode = 'popup', appUrl = 'http://localhost:3000' } = options;
  return bookmarkletKey((await auth.createBookmarkletKey(user, label, appUrl)).bookmarklets[mode]);
}

/** Creates a user through an invite from the command line and signs them in. */
export async function signUp(
  auth: AuthService,
  displayName: string,
  options: { role?: UserRole; userAgent?: string } = {},
): Promise<SignIn> {
  const invite = await auth.createInvite(SYSTEM_ACTOR, { role: options.role ?? 'member' });
  const outcome = await auth.acceptInvite(
    tokenOfPath(invite.path),
    displayName,
    options.userAgent ?? 'Test browser',
  );
  if (!outcome.ok) throw new Error(`Invite not accepted: ${outcome.message}`);
  return outcome.signIn;
}

/** Asserts that `promise` rejects with a ServiceError of `code`. */
export async function expectServiceError(promise: Promise<unknown>, code: string): Promise<void> {
  expect(await rejectionOf(promise)).toMatchObject({ name: 'ServiceError', code });
}
