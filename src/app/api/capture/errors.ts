/**
 * Error classification for the capture endpoints.
 */
import 'server-only';

import { isDeckSourceError, type DeckSourceError } from '@/integrations/deck-source';
import { isCapturePayloadError } from '@/integrations/moxfield/capture-codec';

/** Whether `error` is a `DeckSourceError` with code `schema` (unusable capture data). */
export function isUnusableCaptureError(error: unknown): error is DeckSourceError & { code: 'schema' } {
  return isDeckSourceError(error) && error.code === 'schema';
}

/** How a capture endpoint answers a capture it cannot use. */
export interface RejectedCapture {
  /** HTTP status of `POST /api/capture`: 413 for an oversized payload, 400 otherwise. */
  status: 400 | 413;
  /** `?error=` code for the paste form, where `POST /api/capture/form` redirects. */
  formError: 'too-large' | 'invalid';
  /** User-facing message; never contains the payload. */
  message: string;
}

/**
 * Classifies an error from decoding (`decodeCapturePayload`) or ingesting a capture:
 * a payload over the size limits is `too-large` (413), any other unusable capture data
 * (damaged compression, an unknown encoding, JSON that is not a Moxfield deck) is
 * `invalid` (400). `null` for every other error, which is unexpected.
 */
export function classifyRejectedCapture(error: unknown): RejectedCapture | null {
  if (isCapturePayloadError(error) && error.reason === 'too-large') {
    return { status: 413, formError: 'too-large', message: error.message };
  }
  if (isUnusableCaptureError(error)) return { status: 400, formError: 'invalid', message: error.message };
  return null;
}
