import clsx from 'clsx';
import { History, Tag } from 'lucide-react';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { VersionTimeline } from '@/components/deck/version-timeline';
import { ButtonLink } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/components/ui/navigation';
import { pluralize } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import type { TagCountDTO, VersionListItemDTO } from '@/server/services/types';

import { NoVersionsYet } from './no-versions-yet';

export interface HistoryContentProps {
  scope: DeckScope;
  /** The versions to list (those tagged `tag`, when filtering), newest first. */
  versions: readonly VersionListItemDTO[];
  /** Every tag of the deck, with counts, for the filter. */
  tags: readonly TagCountDTO[];
  /** The tag filter, when one is applied. */
  tag: string | undefined;
  versionCount: number;
  headSequence: number | null;
  /** Whether the current Moxfield deck can be compared with (owners only). */
  hasWorking: boolean;
}

/** The History page of a deck: every version, newest first, a tag filter and compare selection. */
export function HistoryContent({
  scope,
  versions,
  tags,
  tag,
  versionCount,
  headSequence,
  hasWorking,
}: HistoryContentProps) {
  const routes = deckRoutes(scope);

  if (versionCount === 0) {
    return (
      <NoVersionsYet
        scope={scope}
        icon={<History aria-hidden="true" />}
        title="No versions yet"
        ownerDescription="Review the current Moxfield deck on the Status page and commit it as v1."
        viewerDescription="Versions of this deck show up here once they are committed."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-fg">History</h2>
          <p className="text-sm text-muted">
            {tag === undefined
              ? `${pluralize(versionCount, 'version')}. Select two to compare them.`
              : `${pluralize(versions.length, 'version')} tagged “${tag}”`}
          </p>
        </div>
      </div>

      {tags.length > 0 && (
        <nav
          aria-label="Filter by tag"
          className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
        >
          <ul className="flex w-max gap-1.5 sm:w-auto sm:flex-wrap">
            <li>
              <FilterChip href={routes.history()} active={tag === undefined}>
                All
              </FilterChip>
            </li>
            {tags.map((item) => (
              <li key={item.name}>
                <FilterChip href={routes.history({ tag: item.name })} active={tag === item.name}>
                  <Tag aria-hidden="true" className="size-3.5" />
                  {item.name}
                  <span className="text-xs opacity-70 tabular">{item.count}</span>
                </FilterChip>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {versions.length === 0 ? (
        <EmptyState
          icon={<Tag aria-hidden="true" />}
          title={`No versions tagged “${tag ?? ''}”`}
          actions={
            <ButtonLink href={routes.history()} variant="secondary">
              Show all versions
            </ButtonLink>
          }
        />
      ) : (
        <VersionTimeline
          scope={scope}
          versions={versions}
          headSequence={headSequence}
          hasWorking={hasWorking}
          selectable
          framed
        />
      )}
    </div>
  );
}

function FilterChip({ href, active, children }: { href: Route; active: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      scroll={false}
      className={clsx(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors md:h-8',
        active
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-border-strong bg-surface text-muted hover:border-subtle hover:text-fg',
      )}
    >
      {children}
    </Link>
  );
}
