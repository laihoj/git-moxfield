'use server';

/**
 * Server actions: the UI's only write path. Every action resolves the signed-in user
 * from the session cookie again (redirecting to sign-in without one), validates its input
 * with zod, calls the services bound to the user's workspace, revalidates the affected
 * pages and returns a typed, serializable result. Unexpected errors are logged and
 * replaced by a generic message, so no internal details reach the browser.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { servicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';
import { createLogger } from '@/server/logger';
import { isServiceError, type DeckServices } from '@/server/services';
import { noteText } from '@/lib/presentation';
import { routes } from '@/lib/routes';

import type {
  CommitState,
  NoteState,
  RefreshResult,
  TagResult,
  TrackDeckState,
  UntrackResult,
} from './action-types';

const log = createLogger('actions');

const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * User-facing message for an unexpected failure: service errors (unknown deck,
 * invalid input) carry a message meant for users; anything else is logged and hidden.
 */
function failureMessage(error: unknown, what: string, context: Record<string, unknown>): string {
  if (isServiceError(error)) return error.message;
  log.error(`${what} failed`, { error, ...context });
  return GENERIC_ERROR;
}

const deckIdSchema = z.string().trim().min(1).max(128);
const sequenceSchema = z.coerce.number().int().min(1).max(1_000_000);
/** Sanity bound only; the service normalizes tags and reports precise validation errors. */
const tagSchema = z.string().trim().min(1, 'Enter a tag.').max(200, 'That tag is too long.');

/** Revalidates every page of one deck (status, history, versions, compare, cards) and the deck list. */
function revalidateDeck(deckId: string): void {
  revalidatePath(`/decks/${encodeURIComponent(deckId)}`, 'layout');
  revalidatePath('/');
}

/**
 * Services of the signed-in user. Redirects to sign-in without a session, so call it
 * before any `try` block (the redirect is thrown).
 */
async function ownerServices(): Promise<DeckServices> {
  return servicesFor(await requireUser());
}

function formString(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

/** Tracks a deck from a pasted Moxfield URL or id, then opens its page. */
export async function trackDeckAction(
  _previous: TrackDeckState,
  formData: FormData,
): Promise<TrackDeckState> {
  const services = await ownerServices();
  const input = formString(formData, 'deck').trim();
  if (input === '') return { status: 'error', message: 'Paste a Moxfield deck URL.', input };
  if (input.length > 2048)
    return { status: 'error', message: 'That is too long to be a Moxfield deck URL.', input };

  let deckId: string;
  try {
    const outcome = await services.trackDeck(input);
    if (!outcome.ok) return { status: 'error', message: outcome.reason, input };
    deckId = outcome.deckId;
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'trackDeck', {}), input };
  }
  revalidatePath('/');
  redirect(routes.deck(deckId));
}

/**
 * Fetches the current Moxfield deck server-side. A manual refresh re-renders the deck
 * pages in the same round trip; an automatic (background) refresh only returns its
 * result, and the client calls `router.refresh()` afterwards, so the page never
 * re-renders mid-interaction because of a server action it did not ask for.
 */
export async function refreshAction(deckId: string, trigger: 'manual' | 'auto'): Promise<RefreshResult> {
  const services = await ownerServices();
  const id = deckIdSchema.safeParse(deckId);
  const kind = z.enum(['manual', 'auto']).safeParse(trigger);
  if (!id.success || !kind.success) {
    return { ok: false, code: 'internal', message: 'Invalid request.', retryAfterSeconds: null };
  }
  try {
    const outcome = await services.refresh(id.data, kind.data);
    if (kind.data === 'manual') revalidateDeck(id.data);
    if (outcome.ok) return { ok: true, changed: outcome.changedSinceLastObservation };
    return {
      ok: false,
      code: outcome.error.code,
      message: outcome.error.message,
      retryAfterSeconds: outcome.error.retryAfterSeconds,
    };
  } catch (error) {
    const message = failureMessage(error, 'refresh', { deckId: id.data });
    return { ok: false, code: 'internal', message, retryAfterSeconds: null };
  }
}

const commitSchema = z.object({
  deckId: deckIdSchema,
  message: z
    .string()
    .trim()
    .min(1, 'Write a commit message.')
    .max(500, 'Keep the message under 500 characters.'),
  expectedObservationId: z.string().trim().min(1).max(128),
  /** Empty when committing the first version. */
  expectedHeadCommitId: z.string().trim().max(128),
  tags: z.array(tagSchema).max(20, 'Use at most 20 tags.'),
});

/** Commits the reviewed Moxfield state as the next version. */
export async function commitAction(_previous: CommitState, formData: FormData): Promise<CommitState> {
  const services = await ownerServices();
  const parsed = commitSchema.safeParse({
    deckId: formString(formData, 'deckId'),
    message: formString(formData, 'message'),
    expectedObservationId: formString(formData, 'expectedObservationId'),
    expectedHeadCommitId: formString(formData, 'expectedHeadCommitId'),
    tags: formData.getAll('tags').filter((tag): tag is string => typeof tag === 'string'),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      reason: 'invalid-input',
      message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
    };
  }
  const { deckId, message, expectedObservationId, expectedHeadCommitId, tags } = parsed.data;
  try {
    const outcome = await services.commit(deckId, {
      message,
      expectedObservationId,
      expectedHeadCommitId: expectedHeadCommitId === '' ? null : expectedHeadCommitId,
      tags,
    });
    // Revalidate on failure too: `stale` and `head-moved` mean the page shows outdated state.
    revalidateDeck(deckId);
    if (outcome.ok) {
      return {
        status: 'committed',
        sequence: outcome.version.sequence,
        shortId: outcome.version.shortId,
        message: outcome.version.message,
      };
    }
    return { status: 'error', reason: outcome.reason, message: outcome.message };
  } catch (error) {
    return { status: 'error', reason: 'internal', message: failureMessage(error, 'commit', { deckId }) };
  }
}

const tagInputSchema = z.object({ deckId: deckIdSchema, sequence: sequenceSchema, tag: tagSchema });

/** Adds a tag to a version. Returns the version's tags after the change. */
export async function addTagAction(deckId: string, sequence: number, tag: string): Promise<TagResult> {
  const services = await ownerServices();
  const parsed = tagInputSchema.safeParse({ deckId, sequence, tag });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid tag.' };
  try {
    const outcome = await services.addTag(parsed.data.deckId, parsed.data.sequence, parsed.data.tag);
    if (!outcome.ok) return { ok: false, message: outcome.reason };
    revalidateDeck(parsed.data.deckId);
    return { ok: true, tags: outcome.tags };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'addTag', { deckId, sequence }) };
  }
}

/** Removes a tag from a version. Returns the version's tags after the change. */
export async function removeTagAction(deckId: string, sequence: number, tag: string): Promise<TagResult> {
  const services = await ownerServices();
  const parsed = tagInputSchema.safeParse({ deckId, sequence, tag });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid tag.' };
  try {
    const outcome = await services.removeTag(parsed.data.deckId, parsed.data.sequence, parsed.data.tag);
    if (!outcome.ok) return { ok: false, message: outcome.reason };
    revalidateDeck(parsed.data.deckId);
    return { ok: true, tags: outcome.tags };
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'removeTag', { deckId, sequence }) };
  }
}

const NOTE_MAX_LENGTH = 20_000;

const noteSchema = z.object({
  deckId: deckIdSchema,
  sequence: sequenceSchema,
  text: z.string().max(NOTE_MAX_LENGTH, `Notes can be at most ${NOTE_MAX_LENGTH} characters long.`),
});

/** Saves (or, with empty text, clears) the free-text note of a version. */
export async function setNoteAction(_previous: NoteState, formData: FormData): Promise<NoteState> {
  const services = await ownerServices();
  const parsed = noteSchema.safeParse({
    deckId: formString(formData, 'deckId'),
    sequence: formString(formData, 'sequence'),
    text: formString(formData, 'text').replace(/\r\n?/g, '\n'),
  });
  if (!parsed.success)
    return { status: 'error', message: parsed.error.issues[0]?.message ?? 'Invalid note.' };
  const { deckId, sequence, text } = parsed.data;
  try {
    const note = await services.setNote(deckId, sequence, text);
    revalidateDeck(deckId);
    return {
      status: 'saved',
      text: note === null ? '' : noteText(note.data),
      savedAt: note?.updatedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    return { status: 'error', message: failureMessage(error, 'setNote', { deckId, sequence }) };
  }
}

/** Deletes a deck and its whole history from git-moxfield (never touches Moxfield). */
export async function untrackDeckAction(deckId: string): Promise<UntrackResult> {
  const services = await ownerServices();
  const id = deckIdSchema.safeParse(deckId);
  if (!id.success) return { ok: false, message: 'Invalid request.' };
  try {
    await services.untrackDeck(id.data);
  } catch (error) {
    return { ok: false, message: failureMessage(error, 'untrackDeck', { deckId: id.data }) };
  }
  revalidatePath('/');
  redirect(routes.home());
}
