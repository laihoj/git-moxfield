import { ArrowRight, History } from 'lucide-react';

import { VersionTimeline } from '@/components/deck/version-timeline';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Link } from '@/components/ui/navigation';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import type { VersionListItemDTO } from '@/server/services/types';

/** Versions listed on the deck's first page; History has all of them. */
export const RECENT_VERSIONS_SHOWN = 5;

export interface RecentVersionsProps {
  scope: DeckScope;
  /** The newest versions, newest first (only the first {@link RECENT_VERSIONS_SHOWN} are shown). */
  versions: readonly VersionListItemDTO[];
  versionCount: number;
  headSequence: number | null;
  /** What happens before there is a version (the owner commits; viewers wait for one). */
  emptyDescription: string;
}

/**
 * The deck's newest versions in a card, with a link to the whole history: the sidebar of
 * the owner's Status page and of a share link's overview.
 */
export function RecentVersions({
  scope,
  versions,
  versionCount,
  headSequence,
  emptyDescription,
}: RecentVersionsProps) {
  const recent = versions.slice(0, RECENT_VERSIONS_SHOWN);
  return (
    <Card as="section" aria-labelledby="recent-heading" flush>
      <div className="flex items-center justify-between gap-3 px-4 pt-3 md:px-5 md:pt-4 md:pb-1">
        <h2 id="recent-heading" className="text-base font-semibold text-fg">
          Recent versions
        </h2>
        {versionCount > 0 && (
          <Link
            href={deckRoutes(scope).history()}
            className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline md:min-h-0"
          >
            All {versionCount}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        )}
      </div>
      {recent.length > 0 ? (
        <VersionTimeline
          scope={scope}
          versions={recent}
          headSequence={headSequence}
          compact
          className="pb-1"
        />
      ) : (
        <EmptyState
          variant="inline"
          className="py-8"
          icon={<History aria-hidden="true" />}
          title="No versions yet"
          description={emptyDescription}
        />
      )}
    </Card>
  );
}
