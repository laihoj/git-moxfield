/** What a deck's history holds, counted before an import and again after it. */
import 'server-only';

import type { DeckHistoryRows } from '@/server/repositories';

/** What a deck's history holds. */
export interface ImportCounts {
  versions: number;
  tags: number;
  notes: number;
  observations: number;
  /** Recorded changes of Moxfield deck. */
  relinks: number;
}

/** The rows of `rows`, by kind. */
export function countsOf(rows: DeckHistoryRows): ImportCounts {
  return {
    versions: rows.commits.length,
    tags: rows.versionTags.length,
    notes: rows.commitNotes.length,
    observations: rows.observations.length,
    relinks: rows.relinks.length,
  };
}
