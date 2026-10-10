import clsx from 'clsx';
import { ArrowLeftRight, FileText } from 'lucide-react';

import type { DiffStats, PrimerChange } from '@/core/diff/types';
import { MINUS_SIGN } from '@/lib/format';

export interface StatTotals {
  /** Copies added (additions and quantity increases), moves excluded. */
  added: number;
  /** Copies removed (removals and quantity decreases), moves excluded. */
  removed: number;
  /** Copies moved between zones. */
  moved: number;
  /** Printing, card tag and rename changes. */
  cosmetic: number;
}

/** Totals over all zones of a diff's statistics. */
export function statTotals(stats: DiffStats): StatTotals {
  return {
    added: stats.zones.reduce((sum, zone) => sum + zone.added, 0),
    removed: stats.zones.reduce((sum, zone) => sum + zone.removed, 0),
    moved: stats.moves.reduce((sum, move) => sum + move.quantity, 0),
    cosmetic: stats.printingChanges + stats.tagChanges,
  };
}

export interface DiffStatsInlineProps {
  stats: DiffStats;
  primer?: PrimerChange;
  className?: string;
}

/**
 * Compact counters for lists (`+3 −2 ⇄2`), colored and labelled for screen readers.
 * Renders "No card changes" when nothing strategic changed.
 */
export function DiffStatsInline({ stats, primer, className }: DiffStatsInlineProps) {
  const totals = statTotals(stats);
  const primerChanged = primer?.status === 'changed' || primer?.status === 'captured';
  const empty = totals.added === 0 && totals.removed === 0 && totals.moved === 0;
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
      {empty && totals.cosmetic > 0 && <span className="text-cosmetic">Printings only</span>}
      {empty && totals.cosmetic === 0 && !primerChanged && (
        <span className="text-subtle">No card changes</span>
      )}
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
