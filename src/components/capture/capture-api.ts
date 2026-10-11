/**
 * Client-side call to `POST /api/capture` (same-origin JSON, `CaptureRequestBody` in
 * `capture-protocol.ts`), shared by the bookmarklet receiver and the manual paste form.
 */
import { isRecord } from '@/core/guards';
import {
  CAPTURE_API_PATH,
  type CaptureErrorBody,
  type CaptureRequestBody,
} from '@/integrations/moxfield/capture-protocol';
import type { CaptureOutcome, RelinkCandidateDTO } from '@/server/services/types';

export type CaptureMethod = CaptureRequestBody['method'];

/** What to do with the deck, and who sends it (see {@link postCapture}). */
export interface CaptureRequestOptions {
  /** `false`: an untracked deck is answered with `status: 'untracked'` instead of being tracked. */
  track: boolean;
  /** "Continue an existing deck's history": the user's deck the captured deck continues. */
  relinkDeckId?: string;
  /**
   * The bookmarklet key that came with the deck (popup mode): it authenticates the capture
   * and signs this browser in. Without it the browser's session is used.
   */
  key?: string;
}

/**
 * Why the capture was refused, when the server says: `unauthenticated` (no bookmarklet
 * key and no signed-in session: sign in) or `invalid-key` (the bookmarklet's key is
 * unknown or revoked, or the bookmarklet predates accounts: make a new one).
 */
export type CaptureFailureCode = NonNullable<CaptureErrorBody['code']>;

export type CaptureResponse =
  { ok: true; outcome: CaptureOutcome } | { ok: false; message: string; code?: CaptureFailureCode };

const NETWORK_ERROR = 'Could not reach git-moxfield. Check that it is still running and try again.';

function isRelinkCandidate(value: unknown): value is RelinkCandidateDTO {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.externalId === 'string' &&
    typeof value.format === 'string' &&
    typeof value.versionCount === 'number' &&
    typeof value.updatedAt === 'string'
  );
}

/** The server's answer as a {@link CaptureOutcome}, or `null` when it is not one. */
function toCaptureOutcome(value: unknown): CaptureOutcome | null {
  if (!isRecord(value)) return null;
  if (value.status === 'ingested') {
    return typeof value.deckId === 'string' && typeof value.changedSinceLastObservation === 'boolean'
      ? {
          status: 'ingested',
          deckId: value.deckId,
          changedSinceLastObservation: value.changedSinceLastObservation,
        }
      : null;
  }
  if (value.status === 'untracked') {
    if (typeof value.name !== 'string' || typeof value.externalId !== 'string') return null;
    return {
      status: 'untracked',
      source: typeof value.source === 'string' ? value.source : 'moxfield',
      externalId: value.externalId,
      name: value.name,
      decks: Array.isArray(value.decks) ? value.decks.filter(isRelinkCandidate) : [],
    };
  }
  return null;
}

function errorMessage(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.error === 'string' && value.error !== '') return value.error;
  return status === 413
    ? 'The deck data is too large.'
    : `git-moxfield could not import the deck (HTTP ${status}).`;
}

function errorCode(value: unknown): CaptureFailureCode | undefined {
  if (!isRecord(value)) return undefined;
  const { code } = value;
  return code === 'unauthenticated' || code === 'invalid-key' ? code : undefined;
}

/**
 * Sends a capture (the capture payload, or `{ deck, primer }` from the paste form) to the
 * server, to be tracked, continued (`relinkDeckId`) or answered as untracked (see
 * {@link CaptureRequestOptions}). The bookmarklet key is only ever kept in memory for
 * these requests.
 */
export async function postCapture(
  payload: CaptureRequestBody['payload'],
  method: CaptureMethod,
  { track, relinkDeckId, key }: CaptureRequestOptions,
): Promise<CaptureResponse> {
  const body: CaptureRequestBody = {
    payload,
    method,
    track,
    ...(relinkDeckId === undefined ? {} : { relinkDeckId }),
    ...(key === undefined ? {} : { key }),
  };
  let response: Response;
  try {
    response = await fetch(CAPTURE_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // Non-JSON error page (e.g. a proxy); handled below.
  }
  const outcome = response.ok ? toCaptureOutcome(json) : null;
  if (outcome !== null) return { ok: true, outcome };
  const code = response.status === 401 ? errorCode(json) : undefined;
  return code === undefined
    ? { ok: false, message: errorMessage(json, response.status) }
    : { ok: false, message: errorMessage(json, response.status), code };
}
