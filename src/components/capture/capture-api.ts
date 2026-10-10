/**
 * Client-side call to `POST /api/capture` (same-origin JSON), shared by the bookmarklet
 * receiver and the manual paste form.
 */
import type { CaptureOutcome } from '@/server/services/types';

export type CaptureMethod = 'browser-capture' | 'manual-paste';

export type CaptureResponse = { ok: true; outcome: CaptureOutcome } | { ok: false; message: string };

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

/** Sends a capture (envelope JSON string, or `{ deck, primer }` from the paste form) to the server. */
export async function postCapture(
  payload: unknown,
  method: CaptureMethod,
  track: boolean,
): Promise<CaptureResponse> {
  let response: Response;
  try {
    response = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ payload, method, track }),
    });
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON error page (e.g. a proxy); handled below.
  }
  if (response.ok && isCaptureOutcome(body)) return { ok: true, outcome: body };
  return { ok: false, message: errorMessage(body, response.status) };
}
