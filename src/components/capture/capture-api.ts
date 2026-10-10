/**
 * Client-side call to `POST /api/capture` (same-origin JSON, `CaptureRequestBody` in
 * `capture-protocol.ts`), shared by the bookmarklet receiver and the manual paste form.
 */
import {
  CAPTURE_API_PATH,
  type CaptureErrorBody,
  type CaptureRequestBody,
} from '@/integrations/moxfield/capture-protocol';
import type { CaptureOutcome } from '@/server/services/types';

export type CaptureMethod = CaptureRequestBody['method'];

/**
 * Why the capture was refused, when the server says: `unauthenticated` (no bookmarklet
 * key and no signed-in session: sign in) or `invalid-key` (the bookmarklet's key is
 * unknown or revoked, or the bookmarklet predates accounts: make a new one).
 */
export type CaptureFailureCode = NonNullable<CaptureErrorBody['code']>;

export type CaptureResponse =
  { ok: true; outcome: CaptureOutcome } | { ok: false; message: string; code?: CaptureFailureCode };

const NETWORK_ERROR = 'Could not reach git-moxfield. Check that it is still running and try again.';

function isCaptureOutcome(value: unknown): value is CaptureOutcome {
  if (typeof value !== 'object' || value === null || !('status' in value)) return false;
  const { status } = value;
  return status === 'ingested' || status === 'untracked';
}

function errorMessage(value: unknown, status: number): string {
  if (typeof value === 'object' && value !== null && 'error' in value) {
    const { error } = value;
    if (typeof error === 'string' && error !== '') return error;
  }
  return status === 413
    ? 'The deck data is too large.'
    : `git-moxfield could not import the deck (HTTP ${status}).`;
}

function errorCode(value: unknown): CaptureFailureCode | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  const { code } = value;
  return code === 'unauthenticated' || code === 'invalid-key' ? code : undefined;
}

/**
 * Sends a capture (envelope JSON string, or `{ deck, primer }` from the paste form) to
 * the server. `key` is the bookmarklet key that came with the deck (popup mode): it
 * authenticates the capture and signs this browser in. Without it the browser's session
 * is used. The key is only ever kept in memory for these requests.
 */
export async function postCapture(
  payload: CaptureRequestBody['payload'],
  method: CaptureMethod,
  track: boolean,
  key?: string,
): Promise<CaptureResponse> {
  const body: CaptureRequestBody =
    key === undefined ? { payload, method, track } : { payload, method, track, key };
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
  if (response.ok && isCaptureOutcome(json)) return { ok: true, outcome: json };
  const code = response.status === 401 ? errorCode(json) : undefined;
  return code === undefined
    ? { ok: false, message: errorMessage(json, response.status) }
    : { ok: false, message: errorMessage(json, response.status), code };
}
