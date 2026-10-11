import clsx from 'clsx';

import { summarizeDiff, type DeckDiff } from '@/core/diff';
import { Badge } from '@/components/ui/badge';

export interface SummaryChipsProps {
  diff: DeckDiff;
  className?: string;
}

/**
 * One-line summary of a diff as chips (`+2 Mainboard`, `−2 Mainboard`,
 * `2 moved to Considering`, `Primer +14 / −6 lines`). The wording comes from the core
 * (`summarizeDiff`), so it matches suggested commit messages and tests.
 */
export function SummaryChips({ diff, className }: SummaryChipsProps) {
  const chips = summarizeDiff(diff);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Summary of changes" className={clsx('flex flex-wrap gap-1.5', className)}>
      {chips.map((chip) => (
        <li key={chip.label} className="max-w-full">
          <Badge tone={chip.tone} size="md">
            {chip.label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
