/**
 * Parsing of dynamic route segments shared by the owner's deck pages (`/decks/[deckId]/…`)
 * and the shared deck pages (`/s/[token]/…`). Pure; no data access.
 */
import { parseSequenceText } from '@/core/sequence';

/**
 * Decodes a dynamic route segment. Next.js hands over segments percent-encoded in some
 * cases (e.g. card keys with spaces or commas); decoding a plain value is a no-op.
 */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Parses `[sequence]` route segments (`12`, also `v12`); `null` when malformed. */
export function parseSequence(segment: string): number | null {
  return parseSequenceText(segment)?.sequence ?? null;
}
