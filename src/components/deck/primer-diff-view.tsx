import clsx from 'clsx';
import { FileQuestion } from 'lucide-react';
import { Fragment, useId } from 'react';

import type { PrimerDiff, PrimerDiffLine, PrimerHunk } from '@/core/primer/types';
import { MINUS_SIGN, pluralize } from '@/lib/format';

import { PrimerLineCounts } from './primer-line-counts';

export interface PrimerDiffViewProps {
  diff: PrimerDiff;
  className?: string;
}

/** Unchanged lines before `hunk` that no hunk shows (between the previous hunk and this one). */
function hiddenLinesBefore(hunk: PrimerHunk, previous: PrimerHunk | undefined): number {
  const shownUntil = previous === undefined ? 0 : previous.oldStart + previous.oldLines - 1;
  return Math.max(0, hunk.oldStart - 1 - shownUntil);
}

const LINE_STYLES: Record<PrimerDiffLine['type'], string> = {
  add: 'bg-add-bg',
  remove: 'bg-remove-bg',
  context: '',
};

const SIGNS: Record<PrimerDiffLine['type'], { sign: string; spoken: string; className: string }> = {
  add: { sign: '+', spoken: 'Added', className: 'text-add' },
  remove: { sign: MINUS_SIGN, spoken: 'Removed', className: 'text-remove' },
  context: { sign: '', spoken: 'Unchanged', className: 'text-subtle' },
};

/**
 * Line diff of two primers as unified hunks: old/new line numbers, `+`/`−` signs and
 * tinted backgrounds, with unchanged regions between hunks collapsed into a count.
 * A CSS-only toggle switches to a monospace font.
 */
export function PrimerDiffView({ diff, className }: PrimerDiffViewProps) {
  const toggleId = useId();
  if (diff.unknown) {
    return (
      <div className={clsx('flex items-start gap-3 text-sm text-muted', className)}>
        <FileQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>
          <span className="font-medium text-fg">Primer not captured.</span> One side has no captured primer
          (for example, Moxfield did not return it), so primer changes are unknown.
        </p>
      </div>
    );
  }
  if (diff.hunks.length === 0) {
    return <p className={clsx('text-sm text-muted', className)}>No primer changes.</p>;
  }

  return (
    <div className={clsx('primer-diff-root flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <PrimerLineCounts added={diff.addedLines} removed={diff.removedLines} />
        <span className="flex items-center gap-2 text-xs text-muted">
          <input id={toggleId} type="checkbox" className="size-4 accent-(--accent)" />
          <label htmlFor={toggleId} className="cursor-pointer select-none">
            Monospace
          </label>
        </span>
      </div>
      <div
        className={clsx(
          'overflow-hidden rounded-lg border border-border text-[0.8125rem] leading-6',
          // CSS-only toggle: the "Monospace" checkbox switches the font via :has().
          '[.primer-diff-root:has(input:checked)_&]:font-mono',
        )}
      >
        {diff.hunks.map((hunk, index) => {
          const hidden = hiddenLinesBefore(hunk, diff.hunks[index - 1]);
          return (
            <Fragment key={`${hunk.oldStart}:${hunk.newStart}`}>
              {hidden > 0 && (
                <p className="border-y border-border bg-surface-2 px-3 py-1 text-xs text-muted first:border-t-0">
                  ⋯ {pluralize(hidden, 'unchanged line')}
                </p>
              )}
              <ol aria-label={`Lines ${hunk.newStart} to ${hunk.newStart + Math.max(0, hunk.newLines - 1)}`}>
                {hunk.lines.map((line, lineIndex) => {
                  const { sign, spoken, className: signClass } = SIGNS[line.type];
                  return (
                    <li
                      key={lineIndex}
                      className={clsx(
                        'grid grid-cols-[2.5rem_1.25rem_minmax(0,1fr)] sm:grid-cols-[2.5rem_2.5rem_1.25rem_minmax(0,1fr)]',
                        LINE_STYLES[line.type],
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className="hidden pr-2 text-right text-subtle select-none tabular sm:block"
                      >
                        {line.oldNumber ?? ''}
                      </span>
                      <span aria-hidden="true" className="pr-2 text-right text-subtle select-none tabular">
                        {line.newNumber ?? ''}
                      </span>
                      <span
                        aria-hidden="true"
                        className={clsx('text-center font-semibold select-none', signClass)}
                      >
                        {sign}
                      </span>
                      <span className="pr-3 break-words whitespace-pre-wrap text-fg">
                        <span className="sr-only">{spoken}: </span>
                        {line.text === '' ? ' ' : line.text}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
