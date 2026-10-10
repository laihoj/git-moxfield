/**
 * The signed-in user of the current request, for pages, server actions and route
 * handlers. Every request resolves the session again from its cookie (server actions
 * included), so nothing trusts a user id sent by the client.
 */
import 'server-only';

import type { Route } from 'next';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';

import { getAuthService } from './index';
import { readSessionToken } from './cookies';
import { signInPath } from './paths';
import type { SessionUser } from './types';

/**
 * The user of the request's session cookie, or `null` when signed out (or the session
 * ended, expired or its user was disabled). Memoized per server render with React's
 * `cache`, so a layout and its page resolve the session once.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  return getAuthService().resolveSession(await readSessionToken());
});

export interface RequireUserOptions {
  /** Local path to return to after signing in (default `/`). */
  next?: string;
}

/**
 * The signed-in user; redirects to `/signin?next=…` when there is none. Call it outside
 * `try` blocks: the redirect is thrown.
 */
export async function requireUser(options: RequireUserOptions = {}): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (user === null) redirect(signInPath(options.next) as Route);
  return user;
}

/**
 * The signed-in admin; redirects to sign-in when signed out and answers 404 to members,
 * as if admin pages did not exist. The auth service re-checks the role on every admin
 * operation as well.
 */
export async function requireAdmin(options: RequireUserOptions = {}): Promise<SessionUser> {
  const user = await requireUser(options);
  if (user.role !== 'admin') notFound();
  return user;
}
