/**
 * Result types of the server actions in `./actions.ts`. Kept in a plain module so
 * client components can import them without importing the actions' server code.
 */
import type { DeckSourceErrorCode } from '@/integrations/deck-source';
import type { CommitOutcome } from '@/server/services/types';

/** State of the "Track a Moxfield deck" form (`useActionState`). */
export type TrackDeckState = { status: 'idle' } | { status: 'error'; message: string; input: string };

/** Result of a server-side refresh from Moxfield. */
export type RefreshResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: DeckSourceErrorCode | 'internal'; message: string; retryAfterSeconds: number | null };

type CommitFailureReason = Extract<CommitOutcome, { ok: false }>['reason'];

/** State of the commit form (`useActionState`). */
export type CommitState =
  | { status: 'idle' }
  | { status: 'committed'; sequence: number; shortId: string; message: string }
  | { status: 'error'; reason: CommitFailureReason | 'invalid-input' | 'internal'; message: string };

/** Result of adding or removing a version tag. */
export type TagResult = { ok: true; tags: string[] } | { ok: false; message: string };

/** State of the notes editor (`useActionState`). */
export type NoteState =
  | { status: 'idle' }
  | { status: 'saved'; text: string; savedAt: string }
  | { status: 'error'; message: string };

/** Result of untracking a deck (on success the action redirects instead of returning). */
export interface UntrackResult {
  ok: false;
  message: string;
}
