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
import { absoluteAppUrl } from '@/core/http-url';
import { routes } from '@/lib/routes';

import type { AccountActionResult, CreateInviteState, IssuedLinkState } from './action-types';
import { failureMessage, formString, idSchema, INVALID_REQUEST } from './action-support';
import { actionAppUrl } from './request-origin';

const log = createLogger('admin-actions');

const roleSchema = z.enum(USER_ROLES);

/** The signed-in user, who must be an admin for the service calls below to succeed. */
async function actor(): Promise<SessionUser> {
  return requireUser({ next: routes.admin() });
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
    revalidatePath(routes.admin());
    return {
      status: 'created',
      url: absoluteAppUrl(issued.path, app.appUrl),
      expiresAt: issued.expiresAt,
      note: issued.invite.note,
      role: issued.invite.role,
    };
  } catch (error) {
    return {
      status: 'error',
      message: failureMessage(log, error, 'createInvite', { userId: user.id }),
      values,
    };
  }
}

/** Withdraws an invite that has not been used yet. */
export async function revokeInviteAction(inviteId: string): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(inviteId);
  if (!id.success) return { ok: false, message: INVALID_REQUEST };
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeInvite(user, id.data);
    revalidatePath(routes.admin());
    return revoked
      ? { ok: true }
      : { ok: false, message: 'This invite was already used, withdrawn or expired.' };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'revokeInvite', { userId: user.id }) };
  }
}

/** Disables (signing them out everywhere) or enables a person. */
export async function setUserDisabledAction(userId: string, disabled: boolean): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(userId);
  if (!id.success || typeof disabled !== 'boolean') return { ok: false, message: INVALID_REQUEST };
  try {
    const auth = await getAuthService();
    const outcome = disabled ? await auth.disableUser(user, id.data) : await auth.enableUser(user, id.data);
    revalidatePath(routes.admin());
    return outcome.ok ? { ok: true } : { ok: false, message: outcome.message };
  } catch (error) {
    return {
      ok: false,
      message: failureMessage(log, error, disabled ? 'disableUser' : 'enableUser', { userId: user.id }),
    };
  }
}

/** A one-time link that signs a person in once, for 24 hours, shown once to the admin. */
export async function createRecoveryLinkAction(userId: string): Promise<IssuedLinkState> {
  const user = await actor();
  const id = idSchema.safeParse(userId);
  if (!id.success) return { status: 'error', message: INVALID_REQUEST };
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message };
  try {
    const auth = await getAuthService();
    const link = await auth.createRecoveryLink(user, id.data);
    // The page lists the recovery links that can still be used.
    revalidatePath(routes.admin());
    return { status: 'created', url: absoluteAppUrl(link.path, app.appUrl), expiresAt: link.expiresAt };
  } catch (error) {
    return {
      status: 'error',
      message: failureMessage(log, error, 'createRecoveryLink', { userId: user.id }),
    };
  }
}

/** Withdraws a recovery link that has not been used yet. */
export async function revokeRecoveryLinkAction(linkId: string): Promise<AccountActionResult> {
  const user = await actor();
  const id = idSchema.safeParse(linkId);
  if (!id.success) return { ok: false, message: INVALID_REQUEST };
  try {
    const auth = await getAuthService();
    const revoked = await auth.revokeRecoveryLink(user, id.data);
    revalidatePath(routes.admin());
    return revoked
      ? { ok: true }
      : { ok: false, message: 'This recovery link was already used, withdrawn or expired.' };
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'revokeRecoveryLink', { userId: user.id }) };
  }
}
