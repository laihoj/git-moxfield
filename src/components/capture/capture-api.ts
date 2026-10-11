/**
 * Client-side call to `POST /api/capture` (same-origin JSON, `CaptureRequestBody` in
 * `capture-protocol.ts`), shared by the bookmarklet receiver and the manual paste form.
 */
import { isRecord } from '@/core/guards';
import {
  CAPTURE_API_PATH,
  CAPTURE_FAILURE_CODES,
  type CaptureFailureCode,
  type CaptureRequestBody,
} from '@/integrations/moxfield/capture-protocol';
import type { CaptureOutcome, RelinkCandidateDTO } from '@/server/services/types';

export type CaptureMethod = CaptureRequestBody['method'];

/**
 * What to do with the deck, and who sends it (see {@link postCapture}): `track`,
 * `relinkDeckId` and the bookmarklet `key` of the request body, whose documentation they
 * share. Without a `key` the browser's session is used.
 */
export type CaptureRequestOptions = Pick<CaptureRequestBody, 'track' | 'relinkDeckId' | 'key'>;

export type { CaptureFailureCode };

export type CaptureResponse =
  { ok: true; outcome: CaptureOutcome } | { ok: false; message: string; code?: CaptureFailureCode };

const NETWORK_ERROR = 'Could not reach git-moxfield. Check that it is still running and try again.';

/** The type of every field of a relink candidate; the `satisfies` makes a new DTO field a compile error here. */
const RELINK_CANDIDATE_FIELDS = {
  id: 'string',
  name: 'string',
  externalId: 'string',
  format: 'string',
  versionCount: 'number',
  updatedAt: 'string',
} as const satisfies Record<keyof RelinkCandidateDTO, 'string' | 'number'>;

function isRelinkCandidate(value: unknown): value is RelinkCandidateDTO {
  return (
    isRecord(value) &&
    Object.entries(RELINK_CANDIDATE_FIELDS).every(([field, type]) => typeof value[field] === type)
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
  return CAPTURE_FAILURE_CODES.find((known) => known === code);
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
