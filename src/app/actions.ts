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

import { MAX_SEQUENCE } from '@/core/sequence';
import {
  MAX_COMMIT_DESCRIPTION_LENGTH,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_DECK_INPUT_LENGTH,
  MAX_NOTE_LENGTH,
} from '@/core/text-limits';
import { servicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';
import { createLogger } from '@/server/logger';
import type { DeckServices } from '@/server/services';
import { noteText } from '@/lib/presentation';
import { routes } from '@/lib/routes';

import { failureMessage, formString, idSchema, INVALID_REQUEST, UNBOUNDED } from './action-support';
import type {
  CommitState,
  NoteState,
  RefreshResult,
  RelinkDeckState,
  TagResult,
  TrackDeckState,
  UntrackResult,
} from './action-types';

const log = createLogger('actions');

const sequenceSchema = z.coerce.number().int().min(1).max(MAX_SEQUENCE);
/** Sanity bound only; the service normalizes tags and reports precise validation errors. */
const tagSchema = z.string().trim().min(1, 'Enter a tag.').max(200, 'That tag is too long.');

/** Revalidates every page of one deck (status, history, versions, compare, cards) and the deck list. */
function revalidateDeck(deckId: string): void {
  revalidatePath(routes.deck(deckId), 'layout');
  revalidatePath(routes.home());
}

/**
 * Services of the signed-in user. Redirects to sign-in without a session, so call it
 * before any `try` block (the redirect is thrown).
 */
async function ownerServices(): Promise<DeckServices> {
  return servicesFor(await requireUser());
}

/** Tracks a deck from a pasted Moxfield URL or id, then opens its page. */
export async function trackDeckAction(
  _previous: TrackDeckState,
  formData: FormData,
): Promise<TrackDeckState> {
  const services = await ownerServices();
  const input = formString(formData, 'deck', UNBOUNDED).trim();
  if (input === '') return { status: 'error', message: 'Paste a Moxfield deck URL.', input };
  if (input.length > MAX_DECK_INPUT_LENGTH)
    return { status: 'error', message: 'That is too long to be a Moxfield deck URL.', input };

  let deckId: string;
  try {
    const outcome = await services.trackDeck(input);
    if (!outcome.ok) return { status: 'error', message: outcome.reason, input };
    deckId = outcome.deckId;
  } catch (error) {
    return { status: 'error', message: failureMessage(log, error, 'trackDeck'), input };
  }
  revalidatePath(routes.home());
  redirect(routes.deck(deckId));
}

/**
 * Fetches the current Moxfield deck server-side, when the user asks for it (the Refresh
 * button; nothing fetches in the background, ADR 0009), and re-renders the deck pages in
 * the same round trip.
 */
export async function refreshAction(deckId: string): Promise<RefreshResult> {
  const services = await ownerServices();
  const id = idSchema.safeParse(deckId);
  if (!id.success) {
    return { ok: false, code: 'internal', message: INVALID_REQUEST, retryAfterSeconds: null };
  }
  try {
    const outcome = await services.refresh(id.data);
    revalidateDeck(id.data);
    if (outcome.ok) return { ok: true, changed: outcome.changedSinceLastObservation };
    return {
      ok: false,
      code: outcome.error.code,
      message: outcome.error.message,
      retryAfterSeconds: outcome.error.retryAfterSeconds,
    };
  } catch (error) {
    const message = failureMessage(log, error, 'refresh', { deckId: id.data });
    return { ok: false, code: 'internal', message, retryAfterSeconds: null };
  }
}

const commitSchema = z.object({
  deckId: idSchema,
  message: z
    .string()
    .trim()
    .min(1, 'Write a commit message.')
    // A sanity bound only: the service counts code points of the normalized message (two
    // UTF-16 units at most, which is what `max` counts) and reports the exact limit.
    .max(
      MAX_COMMIT_MESSAGE_LENGTH * 2,
      `Commit messages can be at most ${MAX_COMMIT_MESSAGE_LENGTH} characters long.`,
    ),
  /** More about the change, kept after the subject (optional); the same sanity bound as the message's. */
  description: z
    .string()
    .trim()
    .max(
      MAX_COMMIT_DESCRIPTION_LENGTH * 2,
      `Commit descriptions can be at most ${MAX_COMMIT_DESCRIPTION_LENGTH} characters long.`,
    ),
  expectedObservationId: idSchema,
  /** Empty when committing the first version. */
  expectedHeadCommitId: z.string().trim().max(128),
  tags: z.array(tagSchema).max(20, 'Use at most 20 tags.'),
});

/** Commits the reviewed Moxfield state as the next version. */
export async function commitAction(_previous: CommitState, formData: FormData): Promise<CommitState> {
  const services = await ownerServices();
  const parsed = commitSchema.safeParse({
    deckId: formString(formData, 'deckId', UNBOUNDED),
    message: formString(formData, 'message', UNBOUNDED),
    description: formString(formData, 'description', UNBOUNDED),
    expectedObservationId: formString(formData, 'expectedObservationId', UNBOUNDED),
    expectedHeadCommitId: formString(formData, 'expectedHeadCommitId', UNBOUNDED),
    tags: formData.getAll('tags').filter((tag): tag is string => typeof tag === 'string'),
  });
  if (!parsed.success) {
    return {
      status: 'error',
      reason: 'invalid-input',
      message: parsed.error.issues[0]?.message ?? 'Check the form and try again.',
    };
  }
  const { deckId, message, description, expectedObservationId, expectedHeadCommitId, tags } = parsed.data;
  try {
    const outcome = await services.commit(deckId, {
      message,
      description,
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
    return { status: 'error', reason: 'internal', message: failureMessage(log, error, 'commit', { deckId }) };
  }
}

const tagInputSchema = z.object({ deckId: idSchema, sequence: sequenceSchema, tag: tagSchema });

async function changeTagAction(
  op: 'add' | 'remove',
  deckId: string,
  sequence: number,
  tag: string,
): Promise<TagResult> {
  const services = await ownerServices();
  const parsed = tagInputSchema.safeParse({ deckId, sequence, tag });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Invalid tag.' };
  try {
    const { deckId: id, sequence: version, tag: name } = parsed.data;
    const outcome =
      op === 'add' ? await services.addTag(id, version, name) : await services.removeTag(id, version, name);
    if (outcome.ok) revalidateDeck(parsed.data.deckId);
    return outcome;
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, `${op}Tag`, { deckId, sequence }) };
  }
}

/** Adds a tag to a version. Returns the version's tags after the change. */
export async function addTagAction(deckId: string, sequence: number, tag: string): Promise<TagResult> {
  return changeTagAction('add', deckId, sequence, tag);
}

/** Removes a tag from a version. Returns the version's tags after the change. */
export async function removeTagAction(deckId: string, sequence: number, tag: string): Promise<TagResult> {
  return changeTagAction('remove', deckId, sequence, tag);
}

const noteSchema = z.object({
  deckId: idSchema,
  sequence: sequenceSchema,
  // A sanity bound only (UTF-16 units, line breaks as typed): the service counts code points
  // of the normalized note and reports the exact limit.
  text: z.string().max(MAX_NOTE_LENGTH * 2, `Notes can be at most ${MAX_NOTE_LENGTH} characters long.`),
});

/** Saves (or, with empty text, clears) the free-text note of a version. */
export async function setNoteAction(_previous: NoteState, formData: FormData): Promise<NoteState> {
  const services = await ownerServices();
  const parsed = noteSchema.safeParse({
    deckId: formString(formData, 'deckId', UNBOUNDED),
    sequence: formString(formData, 'sequence', UNBOUNDED),
    text: formString(formData, 'text', UNBOUNDED),
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
    return { status: 'error', message: failureMessage(log, error, 'setNote', { deckId, sequence }) };
  }
}

/**
 * Points a deck at another Moxfield deck ("Change Moxfield deck": the deck was deleted on
 * Moxfield and made again under a new link). Keeps every version; on success opens the
 * deck's Status page, which greets the change.
 */
export async function relinkDeckAction(
  _previous: RelinkDeckState,
  formData: FormData,
): Promise<RelinkDeckState> {
  const services = await ownerServices();
  const input = formString(formData, 'deck', UNBOUNDED).trim();
  const id = idSchema.safeParse(formString(formData, 'deckId', UNBOUNDED));
  if (!id.success) return { status: 'error', message: INVALID_REQUEST, input };
  const deckId = id.data;
  if (input === '') return { status: 'error', message: 'Paste the new Moxfield deck URL.', input };
  if (input.length > MAX_DECK_INPUT_LENGTH)
    return { status: 'error', message: 'That is too long to be a Moxfield deck URL.', input };

  try {
    const outcome = await services.relinkDeck(deckId, input);
    if (!outcome.ok) {
      const { trackedBy } = outcome;
      return trackedBy === undefined
        ? { status: 'error', message: outcome.message, input }
        : {
            status: 'error',
            message: outcome.message,
            input,
            trackedBy: { deckId: trackedBy.deckId, name: trackedBy.name },
          };
    }
  } catch (error) {
    return { status: 'error', message: failureMessage(log, error, 'relinkDeck', { deckId }), input };
  }
  revalidateDeck(deckId);
  redirect(routes.deck(deckId, { relinked: true }));
}

/** Deletes a deck and its whole history from git-moxfield (never touches Moxfield). */
export async function untrackDeckAction(deckId: string): Promise<UntrackResult> {
  const services = await ownerServices();
  const id = idSchema.safeParse(deckId);
  if (!id.success) return { ok: false, message: INVALID_REQUEST };
  try {
    await services.untrackDeck(id.data);
  } catch (error) {
    return { ok: false, message: failureMessage(log, error, 'untrackDeck', { deckId: id.data }) };
  }
  revalidatePath(routes.home());
  redirect(routes.home());
}
