import clsx from 'clsx';
import { ArrowLeftRight, FileText } from 'lucide-react';

import { primerHasChange, type DiffStats, type PrimerChange } from '@/core/diff/types';
import { MINUS_SIGN } from '@/lib/format';
import { cosmeticChange } from '@/lib/presentation';

interface StatTotals {
  /** Copies added (additions and quantity increases), moves excluded. */
  added: number;
  /** Copies removed (removals and quantity decreases), moves excluded. */
  removed: number;
  /** Copies moved between zones. */
  moved: number;
}

/** Totals over all zones of a diff's statistics. */
function statTotals(stats: DiffStats): StatTotals {
  return {
    added: stats.zones.reduce((sum, zone) => sum + zone.added, 0),
    removed: stats.zones.reduce((sum, zone) => sum + zone.removed, 0),
    moved: stats.moves.reduce((sum, move) => sum + move.quantity, 0),
  };
}

const COSMETIC_ONLY_LABELS = {
  renames: 'Renamed only',
  printings: 'Printings only',
  both: 'Printings and renames only',
} as const;

export interface DiffStatsInlineProps {
  stats: DiffStats;
  primer?: PrimerChange;
  className?: string;
}

/**
 * Compact counters for lists (`+3 −2 ⇄2`), colored and labelled for screen readers.
 * When no card was added, removed or moved, says what changed instead ("Renamed only",
 * "Printings only"), or "No card changes".
 */
export function DiffStatsInline({ stats, primer, className }: DiffStatsInlineProps) {
  const totals = statTotals(stats);
  const primerChanged = primerHasChange(primer);
  const empty = totals.added === 0 && totals.removed === 0 && totals.moved === 0;
  const cosmetic = cosmeticChange(stats);
  return (
    <span
      className={clsx(
        'inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium tabular',
        className,
      )}
    >
      {totals.added > 0 && (
        <span className="text-add">
          +{totals.added}
          <span className="sr-only"> added</span>
        </span>
      )}
      {totals.removed > 0 && (
        <span className="text-remove">
          {MINUS_SIGN}
          {totals.removed}
          <span className="sr-only"> removed</span>
        </span>
      )}
      {totals.moved > 0 && (
        <span className="inline-flex items-center gap-0.5 text-move">
          <ArrowLeftRight aria-hidden="true" className="size-3" />
          {totals.moved}
          <span className="sr-only"> moved</span>
        </span>
      )}
      {empty && cosmetic !== null && <span className="text-cosmetic">{COSMETIC_ONLY_LABELS[cosmetic]}</span>}
      {empty && cosmetic === null && !primerChanged && <span className="text-subtle">No card changes</span>}
      {primerChanged && (
        <span className="inline-flex items-center gap-0.5 text-muted">
          <FileText aria-hidden="true" className="size-3" />
          Primer
          <span className="sr-only"> changed</span>
        </span>
      )}
    </span>
  );
}
