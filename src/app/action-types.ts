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

// ---------------------------------------------------------------------------
// Accounts (ADR 0006): `./auth-actions.ts`, `./account-actions.ts`, `./admin-actions.ts`
// ---------------------------------------------------------------------------

/**
 * State of a sign-in form (claim, invite, one-time link). Success redirects instead of
 * returning. `field` names the input the message is about; `values` keeps what was typed,
 * because React resets a form after its action runs.
 */
export type SignInFormState =
  | { status: 'idle' }
  | {
      status: 'error';
      message: string;
      field?: 'code' | 'name';
      values?: { code?: string; name?: string };
    };

/** Result of a one-off account or admin action (revoke, sign out a device, disable). */
export type AccountActionResult = { ok: true } | { ok: false; message: string };

/** State of the display name form. */
export type RenameState =
  | { status: 'idle' }
  | { status: 'saved'; displayName: string }
  | { status: 'error'; message: string; value: string };

/**
 * State of "Create a bookmarklet". The bookmarklets embed the new key in plaintext: they
 * exist only in this state, in the browser of the user who created them, until the page
 * is left (never stored, never shown again).
 */
export type CreateBookmarkletState =
  | { status: 'idle' }
  | { status: 'created'; id: string; label: string; popup: string; sameTab: string }
  | { status: 'error'; message: string; label: string };

/** A QR code as an SVG path of its dark modules, on a `size` × `size` grid (no quiet zone). */
export interface QrCodeData {
  size: number;
  path: string;
}

/**
 * A new one-time link (device link, invite, recovery link), shown once to whoever made
 * it. `url` contains the link's secret token.
 */
export type IssuedLinkState =
  | { status: 'idle' }
  | { status: 'created'; url: string; expiresAt: string; qr?: QrCodeData }
  | { status: 'error'; message: string };

/** State of the admin's "Invite someone" form. `url` contains the invite's secret token. */
export type CreateInviteState =
  | { status: 'idle' }
  | { status: 'created'; url: string; expiresAt: string; note: string; role: 'admin' | 'member' }
  | { status: 'error'; message: string; values: { note: string; role: string } };
