'use server';

/**
 * Server actions of the admin page (ADR 0006): invites, recovery links, and disabling
 * or enabling people. Admins manage accounts, not decks: no action here reaches anyone's
 * decks. A recovery link signs in as the person it is for; the auth service makes using
 * one sign out their other devices and shows it on their Account page.
 *
 * Every action resolves the signed-in user again and hands that user to the auth
 * service as the actor; the service re-checks the role against the database on every
 * call (a member, or an admin demoted since the page loaded, gets "forbidden"). Ids from
 * the browser are only looked up by the service. New links carry a secret token: they
 * are returned once to the admin who asked and never logged.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { USER_ROLES } from '@/core/roles';
import { getAuthService } from '@/server/auth';
import { requireUser } from '@/server/auth/current-user';
import type { SessionUser } from '@/server/auth/types';
import { createLogger } from '@/server/logger';
import { isServiceError } from '@/server/services';
import { absoluteAppUrl } from '@/core/http-url';
import { routes } from '@/lib/routes';

import type { AccountActionResult, CreateInviteState, IssuedLinkState } from './action-types';
import { actionAppUrl } from './request-origin';

const log = createLogger('admin-actions');

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/** Sanity bound for ids from the browser; the auth service looks them up. */
const idSchema = z.string().trim().min(1).max(128);
const roleSchema = z.enum(USER_ROLES);

/** Longest form value read at all; the auth service validates the exact rules. */
const MAX_FIELD_LENGTH = 1024;

function formString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : '';
}

/** The signed-in user, who must be an admin for the service calls below to succeed. */
async function actor(): Promise<SessionUser> {
  return requireUser({ next: routes.admin() });
}

/** User-facing message: service errors (forbidden, invalid input) carry one; others are logged. */
function failureMessage(error: unknown, what: string, user: SessionUser): string {
  if (isServiceError(error)) return error.message;
  log.error(`${what} failed`, { error, userId: user.id });
  return GENERIC_ERROR;
}

/** Creates an invite and returns its link, shown once. */
export async function createInviteAction(
  _previous: CreateInviteState,
  formData: FormData,
): Promise<CreateInviteState> {
  const user = await actor();
  const note = formString(formData, 'note');
  const rawRole = formString(formData, 'role');
  const values = { note, role: rawRole };
  const role = roleSchema.safeParse(rawRole);
  if (!role.success) return { status: 'error', message: 'Choose member or admin.', values };
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message, values };
  try {
    const auth = await getAuthService();
    const issued = await auth.createInvite(user, { role: role.data, note });
    revalidatePath('/admin');
    return {
      status: 'created',
      url: absoluteAppUrl(issued.path, app.appUrl),
      expiresAt: issued.expiresAt,
      note: issued.invite.note,
      role: issued.invite.role,
    };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'createInvite', user), values };
  }
}

/** Withdraws an invite that has not been used yet. */
export async function revokeInviteAction(inviteId: string): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { ok: false, message: 'Invalid request.' };
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeInvite(user, id.data);
    revalidatePath('/admin');
    return revoked ? { ok: true } : { ok: false, message: 'This invite was already used or withdrawn.' };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'revokeInvite', user) };
  }
}

/** Disables (signing them out everywhere) or enables a person. */
export async function setUserDisabledAction(userId: string, disabled: boolean): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(userId);
  if (!id.success || typeof disabled !== 'boolean') return { ok: false, message: 'Invalid request.' };
  try {
    const auth = await getAuthService();
    const outcome = disabled ? await auth.disableUser(user, id.data) : await auth.enableUser(user, id.data);
    revalidatePath('/admin');
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  } catch (error) {
    return { ok: false, message: failureMessage(error, disabled ? 'disableUser' : 'enableUser', user) };
  }
}

/** A one-time link that signs a person in once, for 24 hours, shown once to the admin. */
export async function createRecoveryLinkAction(userId: string): Promise<IssuedLinkState> {
  const user = await actor();
  const id = idSchema.safeParse(userId);
  if (!id.success) return { status: 'error', message: 'Invalid request.' };
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message };
  try {
    const auth = await getAuthService();
    const link = await auth.createRecoveryLink(user, id.data);
    // The page lists the recovery links that can still be used.
    revalidatePath('/admin');
    return { status: 'created', url: absoluteAppUrl(link.path, app.appUrl), expiresAt: link.expiresAt };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'createRecoveryLink', user) };
  }
}

/** Withdraws a recovery link that has not been used yet. */
export async function revokeRecoveryLinkAction(linkId: string): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(linkId);
  if (!id.success) return { ok: false, message: 'Invalid request.' };
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeRecoveryLink(user, id.data);
    revalidatePath('/admin');
    return revoked
      ? { ok: true }
      : { ok: false, message: 'This recovery link was already used or withdrawn.' };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'revokeRecoveryLink', user) };
  }
}
