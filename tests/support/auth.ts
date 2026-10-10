/**
 * Helpers for tests of the account system: signing users in through the real invite
 * flow, and reading tokens back out of the links and bookmarklets the auth service
 * hands out (which is the only place they appear in plaintext).
 */
import { expect } from 'vitest';

import { SYSTEM_ACTOR, type AuthService } from '@/server/auth/service';
import type { SignIn, UserRole } from '@/server/auth/types';

/** The token at the end of a link path (`/invite/gmi_…`, `/signin/gml_…`). */
export function tokenOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The bookmarklet key embedded in a `javascript:` bookmarklet. */
export function keyOfBookmarklet(bookmarklet: string): string {
  const source = decodeURIComponent(bookmarklet.slice('javascript:'.length));
  const match = /"key":"(gmk_[A-Za-z0-9_-]{43})"/.exec(source);
  if (match?.[1] === undefined) throw new Error('No key in the bookmarklet');
  return match[1];
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
  const error: unknown = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toMatchObject({ name: 'ServiceError', code });
}
