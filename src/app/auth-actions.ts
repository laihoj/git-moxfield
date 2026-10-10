'use server';

/**
 * Server actions that sign a browser in or out (ADR 0006): claiming the installation,
 * accepting an invite, using a device or recovery link, and signing out.
 *
 * One-time things are only ever used up here, by a POST: pages that show an invite or a
 * link never consume it while rendering, because chat apps and mail scanners fetch links
 * to preview them. Tokens arrive as form fields, are checked by the auth service, and
 * are never logged. On success the action sets the session cookie (ending the session
 * the browser held before) and redirects, outside any `try` block.
 */
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { getAuthService } from '@/server/auth';
import { endBrowserSession, establishSession } from '@/server/auth/cookies';
import { createLogger } from '@/server/logger';
import { routes, type WelcomeReason } from '@/lib/routes';

import type { SignInFormState } from './action-types';

const log = createLogger('auth-actions');

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** Longest form value read at all; the auth service validates the exact formats. */
const MAX_FIELD_LENGTH = 512;

function formString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';
}

async function userAgent(): Promise<string | null> {
  return (await headers()).get('user-agent');
}

/** Signs this browser out and opens the sign-in page. */
export async function signOutAction(): Promise<void> {
  await endBrowserSession();
  redirect(routes.signIn());
}

/**
 * Claims a fresh installation with the setup code from the server log: creates the first
 * admin, signs this browser in and continues to creating a bookmarklet.
 */
export async function claimAction(_previous: SignInFormState, formData: FormData): Promise<SignInFormState> {
  const code = formString(formData, 'code');
  const name = formString(formData, 'name');
  let welcome: WelcomeReason;
  try {
    const auth = await getAuthService();
    const outcome = await auth.claim(code, name, await userAgent());
    if (!outcome.ok) {
      return {
        status: 'error',
        message: outcome.message,
        field:
          outcome.reason === 'invalid-code' ? 'code' : outcome.reason === 'invalid-name' ? 'name' : undefined,
        values: { code, name },
      };
    }
    await establishSession(outcome.signIn.session);
    welcome = outcome.adoptedLocalWorkspace ? 'claimed-local' : 'claimed';
  } catch (error) {
    log.error('Claim failed', { error });
    return { status: 'error', message: GENERIC_ERROR, values: { code, name } };
  }
  redirect(routes.setup({ welcome }));
}

/** Accepts an invite: creates the account, signs this browser in, continues to creating a bookmarklet. */
export async function acceptInviteAction(
  _previous: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const token = formString(formData, 'token');
  const name = formString(formData, 'name');
  try {
    const auth = await getAuthService();
    const outcome = await auth.acceptInvite(token, name, await userAgent());
    if (!outcome.ok) {
      return {
        status: 'error',
        message: outcome.message,
        field: outcome.reason === 'invalid-name' ? 'name' : undefined,
        values: { name },
      };
    }
    await establishSession(outcome.signIn.session);
  } catch (error) {
    log.error('Accepting an invite failed', { error });
    return { status: 'error', message: GENERIC_ERROR, values: { name } };
  }
  redirect(routes.setup({ welcome: 'invite' }));
}

/**
 * Uses up a device or recovery link and signs this browser in. A device link opens the
 * decks; a recovery link continues to creating a new bookmarklet, since the user lost
 * theirs.
 */
export async function signInWithLinkAction(
  _previous: SignInFormState,
  formData: FormData,
): Promise<SignInFormState> {
  const token = formString(formData, 'token');
  let recovery: boolean;
  try {
    const auth = await getAuthService();
    const link = await auth.getLoginLink(token);
    const signIn = link.status === 'valid' ? await auth.consumeLoginLink(token, await userAgent()) : null;
    if (link.status !== 'valid' || signIn === null) {
      return {
        status: 'error',
        message:
          link.status === 'expired'
            ? 'This link has expired. Create a new one.'
            : 'This link no longer works: it was already used, or it is not valid. Create a new one.',
      };
    }
    await establishSession(signIn.session);
    recovery = link.purpose === 'recovery';
  } catch (error) {
    log.error('Signing in with a one-time link failed', { error });
    return { status: 'error', message: GENERIC_ERROR };
  }
  redirect(recovery ? routes.setup({ welcome: 'recovery' }) : routes.home());
}
