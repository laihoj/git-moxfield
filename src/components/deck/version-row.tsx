import clsx from 'clsx';
import { Crown } from 'lucide-react';
import type { ReactNode } from 'react';

import type { VersionListItemDTO } from '@/server/services/types';
import { INITIAL_VERSION_MESSAGE } from '@/core/diff/present';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { RelativeTime } from '@/components/ui/relative-time';
import { pluralize, versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';

import { DiffStatsInline } from './diff-stats';
import { TagChip } from './tag-chip';

/** `v47` in a compact pill; the latest version is highlighted. */
export function VersionBadge({ sequence, latest = false }: { sequence: number; latest?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex h-6 min-w-10 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-semibold tabular',
        latest ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-fg ring-1 ring-border ring-inset',
      )}
    >
      {versionLabel(sequence)}
    </span>
  );
}

/** The title of a version's page: its badge, then the heading (the commit message, or what the page does). */
export function VersionTitle({
  sequence,
  latest = false,
  children,
}: {
  sequence: number;
  latest?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <VersionBadge sequence={sequence} latest={latest} />
      <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight break-words text-fg">
        {children}
      </h2>
    </div>
  );
}

export interface VersionRowProps {
  /** The deck pages the row links within (the owner's or a share link's). */
  scope: DeckScope;
  version: VersionListItemDTO;
  latest: boolean;
  /** Leading control (selection checkbox) rendered above the stretched link. */
  leading?: ReactNode;
  /** Denser layout for the deck page's sidebar. */
  compact?: boolean;
  selected?: boolean;
}

/**
 * One version in a timeline: vN, message, relative date, tags, change counters and
 * primer/commander indicators. The whole row links to the version page.
 */
export function VersionRow({
  scope,
  version,
  latest,
  leading,
  compact = false,
  selected = false,
}: VersionRowProps) {
  return (
    <li
      className={clsx(
        'relative flex items-start gap-3 px-4 transition-colors md:px-5',
        compact ? 'py-3' : 'py-3.5',
        selected ? 'bg-accent-soft/60' : 'hover:bg-surface-2/70',
      )}
    >
      {leading}
      <Link
        href={deckRoutes(scope).version(version.sequence)}
        className="shrink-0 rounded-md after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-4"
        aria-label={`${versionLabel(version.sequence)}: ${version.message}`}
      >
        <VersionBadge sequence={version.sequence} latest={latest} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="line-clamp-2 min-w-0 flex-1 text-sm font-medium break-words text-fg">
            {version.message}
          </p>
          <RelativeTime
            value={version.createdAt}
            style="short"
            className="shrink-0 text-xs text-muted tabular"
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          {version.tags.length > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-1">
              {version.tags.map((tag) => (
                <TagChip key={tag} tag={tag} size="sm" />
              ))}
            </ul>
          )}
          {version.parentSequence === null ? (
            <MetaList className="text-xs text-muted tabular">
              {/* The default first commit message already says it. */}
              {version.message.trim().toLowerCase() !== INITIAL_VERSION_MESSAGE.toLowerCase() && (
                <MetaItem>{INITIAL_VERSION_MESSAGE}</MetaItem>
              )}
              <MetaItem>{pluralize(version.playedCardCount, 'card')}</MetaItem>
            </MetaList>
          ) : (
            <DiffStatsInline stats={version.stats} primer={version.primer} />
          )}
          {version.commandersChanged && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-zone-commanders">
              <Crown aria-hidden="true" className="size-3" />
              Commanders
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
