'use server';

/**
 * Server actions of the owner's share links (ADR 0007): read-only links to one of the
 * signed-in user's decks, created and revoked from the deck's Share page.
 *
 * Every action resolves the user from the session cookie again (redirecting to sign-in
 * without one) and uses the share link services bound to that user's workspace and
 * session: a deck or link id from the browser can name nothing outside the workspace.
 *
 * A new link's URL holds its token. It is returned once, to the browser that asked, and
 * never logged. The actions take plain arguments, never a previous result, so the
 * development server's log of server function calls cannot show a URL either.
 */
import { revalidatePath } from 'next/cache';

import { shareLinkServicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';
import { createLogger } from '@/server/logger';
import { isServiceError } from '@/server/services';
import { routes } from '@/lib/routes';

import type { AccountActionResult, CreateShareLinkResult } from './action-types';
import { failureMessage, idSchema, INVALID_REQUEST, MAX_FIELD_LENGTH } from './action-support';
import { actionAppUrl } from './request-origin';

const log = createLogger('share-actions');

/** The pages that show a deck's links: its Share page, and Account (counts per bookmarklet). */
function revalidateShareLinks(deckId: string): void {
  revalidatePath(routes.deckShare(deckId));
  revalidatePath(routes.account());
}

/**
 * Creates a read-only link to one of the user's decks, named `label` (for the owner only),
 * showing the owner's version notes when `includeNotes` is set. Returns the link's URL,
 * the only time it exists in plaintext.
 */
export async function createShareLinkAction(
  deckId: string,
  label: string,
  includeNotes: boolean,
): Promise<CreateShareLinkResult> {
  const id = idSchema.safeParse(deckId);
  const user = await requireUser({ next: id.success ? routes.deckShare(id.data) : routes.home() });
  if (!id.success || typeof label !== 'string' || typeof includeNotes !== 'boolean') {
    return { status: 'error', message: INVALID_REQUEST };
  }
  const app = await actionAppUrl();
  if (!app.ok) return { status: 'error', message: app.message };
  try {
    const shareLinks = await shareLinkServicesFor(user);
    const created = await shareLinks.createShareLink(
      id.data,
      { label: label.slice(0, MAX_FIELD_LENGTH), includeNotes },
      app.appUrl,
    );
    revalidateShareLinks(id.data);
    return { status: 'created', url: created.url, link: created.link };
  } catch (error) {
    // `includeNotes` is checked above, so invalid input is the label.
    if (isServiceError(error, 'invalid-input'))
      return { status: 'error', message: error.message, field: 'label' };
    return {
      status: 'error',
      message: failureMessage(log, error, 'createShareLink', { userId: user.id, deckId: id.data }),
    };
  }
}

/** Revokes one of a deck's links: viewing through it ends at once. */
export async function revokeShareLinkAction(deckId: string, linkId: string): Promise<AccountActionResult> {
  const id = idSchema.safeParse(deckId);
  const link = idSchema.safeParse(linkId);
  const user = await requireUser({ next: id.success ? routes.deckShare(id.data) : routes.home() });
  if (!id.success || !link.success) return { ok: false, message: INVALID_REQUEST };
  try {
    const shareLinks = await shareLinkServicesFor(user);
    const revoked = await shareLinks.revokeShareLink(id.data, link.data);
    revalidateShareLinks(id.data);
    return revoked ? { ok: true } : { ok: false, message: 'This link was already revoked.' };
  } catch (error) {
    return {
      ok: false,
      message: failureMessage(log, error, 'revokeShareLink', { userId: user.id, deckId: id.data }),
    };
  }
}
