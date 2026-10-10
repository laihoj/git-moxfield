'use client';

import clsx from 'clsx';
import { GitCompareArrows, X } from 'lucide-react';
import { useState } from 'react';

import type { VersionListItemDTO } from '@/server/services/types';
import { ButtonLink } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { versionLabel } from '@/lib/format';
import { routes } from '@/lib/routes';

import { VersionRow } from './version-row';

export interface VersionTimelineProps {
  deckId: string;
  /** Versions, newest first. */
  versions: readonly VersionListItemDTO[];
  /** Sequence of the latest version (highlighted). */
  headSequence: number | null;
  /** Rows get checkboxes; selecting one or two versions offers comparisons. */
  selectable?: boolean;
  /** Whether a current Moxfield deck exists to compare with. */
  hasWorking?: boolean;
  compact?: boolean;
  /** Draw the list as a card (the compare bar then floats outside it). */
  framed?: boolean;
  className?: string;
}

/**
 * Version list, newest first. With `selectable`, a floating bar offers "Compare
 * selected" for two versions, or "with previous" / "with current Moxfield deck" for one.
 */
export function VersionTimeline({
  deckId,
  versions,
  headSequence,
  selectable = false,
  hasWorking = false,
  compact = false,
  framed = false,
  className,
}: VersionTimelineProps) {
  const [selected, setSelected] = useState<number[]>([]);

  function toggle(sequence: number): void {
    setSelected((current) => {
      if (current.includes(sequence)) return current.filter((value) => value !== sequence);
      // Keep at most two: selecting a third replaces the oldest selection.
      return [...current, sequence].slice(-2);
    });
  }

  return (
    <div className={className}>
      <ol
        className={clsx(
          'divide-y divide-border',
          framed && 'overflow-hidden rounded-xl border border-border bg-surface shadow-card',
        )}
      >
        {versions.map((version) => {
          const isSelected = selected.includes(version.sequence);
          return (
            <VersionRow
              key={version.commitId}
              deckId={deckId}
              version={version}
              latest={version.sequence === headSequence}
              compact={compact}
              selected={isSelected}
              leading={
                selectable ? (
                  <label className="relative z-10 -my-2.5 -mr-1.5 -ml-2.5 flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      className="size-4.5 cursor-pointer rounded accent-(--accent)"
                      aria-label={`Select ${versionLabel(version.sequence)} to compare`}
                      onChange={() => {
                        toggle(version.sequence);
                      }}
                    />
                  </label>
                ) : undefined
              }
            />
          );
        })}
      </ol>
      {selectable && selected.length > 0 && (
        <SelectionBar
          deckId={deckId}
          selected={selected}
          versions={versions}
          hasWorking={hasWorking}
          onClear={() => {
            setSelected([]);
          }}
        />
      )}
    </div>
  );
}

function SelectionBar({
  deckId,
  selected,
  versions,
  hasWorking,
  onClear,
}: {
  deckId: string;
  selected: readonly number[];
  versions: readonly VersionListItemDTO[];
  hasWorking: boolean;
  onClear: () => void;
}) {
  const sorted = [...selected].sort((a, b) => a - b);
  const [first = 0, second] = sorted;
  const previousSequence = versions.find((version) => version.sequence === first)?.parentSequence ?? null;

  return (
    <div
      role="region"
      aria-label="Compare selected versions"
      className={clsx(
        'sticky bottom-[calc(var(--bottom-nav-offset,0px)+env(safe-area-inset-bottom)+0.75rem)] z-30 mx-auto mt-4 flex w-fit max-w-full flex-wrap items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-2 pl-4 shadow-pop md:bottom-4',
      )}
    >
      <p className="text-sm font-medium text-fg tabular">
        {second === undefined
          ? `${versionLabel(first)} selected`
          : `${versionLabel(first)} → ${versionLabel(second)}`}
      </p>
      {second !== undefined ? (
        <ButtonLink
          href={routes.compare(deckId, { from: versionLabel(first), to: versionLabel(second) })}
          variant="primary"
          size="sm"
          icon={<GitCompareArrows aria-hidden="true" className="size-4" />}
        >
          Compare selected
        </ButtonLink>
      ) : (
        <>
          {previousSequence !== null && (
            <ButtonLink
              href={routes.compare(deckId, { from: versionLabel(previousSequence), to: versionLabel(first) })}
              variant="secondary"
              size="sm"
            >
              With previous
            </ButtonLink>
          )}
          {hasWorking && (
            <ButtonLink
              href={routes.compare(deckId, { from: versionLabel(first), to: 'working' })}
              variant="secondary"
              size="sm"
            >
              With current Moxfield deck
            </ButtonLink>
          )}
        </>
      )}
      <IconButton
        label="Clear selection"
        icon={<X aria-hidden="true" className="size-4" />}
        size="sm"
        onClick={onClear}
      />
    </div>
  );
}
