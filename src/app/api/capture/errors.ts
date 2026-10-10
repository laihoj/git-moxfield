/**
 * Error classification for the capture endpoints.
 */
import 'server-only';

import { isDeckSourceError, type DeckSourceError } from '@/integrations/deck-source';

/** Whether `error` is a `DeckSourceError` with code `schema` (unusable capture data). */
export function isUnusableCaptureError(error: unknown): error is DeckSourceError & { code: 'schema' } {
  return isDeckSourceError(error) && error.code === 'schema';
}
