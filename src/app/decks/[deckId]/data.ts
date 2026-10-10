/**
 * Request-scoped data loaders for the deck pages. `cache` deduplicates calls within
 * one server render, so the deck layout and the status page share one overview.
 */
import 'server-only';

import { cache } from 'react';

import { getServices } from '@/server/services';

/** The deck overview (status, HEAD → working diff, recent versions), or `null` for an unknown deck. */
export const loadOverview = cache((deckId: string) => getServices().getOverview(deckId));

/** Every tag used in the deck, with counts. */
export const loadTags = cache((deckId: string) => getServices().listTags(deckId));

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
  const match = /^v?(\d{1,9})$/i.exec(segment);
  if (match === null) return null;
  const sequence = Number(match[1]);
  return sequence >= 1 ? sequence : null;
}
