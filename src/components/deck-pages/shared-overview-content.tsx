import { History, Undo2 } from 'lucide-react';

import { changesTitle, DiffView, diffCountLabel, initialDescription } from '@/components/deck/diff-view';
import { SummaryChips } from '@/components/deck/summary-chips';
import { VersionBadge } from '@/components/deck/version-row';
import { VersionTags } from '@/components/deck/version-tags';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader, Overline } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { RelativeTime } from '@/components/ui/relative-time';
import { SidebarLayout } from '@/components/ui/sidebar-layout';
import { pluralize, versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';
import type { SharedOverviewDTO, SharedVersionDetailDTO } from '@/server/services/types';

import { RecentVersions } from './recent-versions';

export interface SharedOverviewContentProps {
  scope: DeckScope;
  overview: SharedOverviewDTO;
  /** The latest version in full; `null` before the first version. */
  latest: SharedVersionDetailDTO | null;
}

/**
 * The first page of a shared deck, in the place of the owner's Status page: the latest
 * version and what it changed, beside the recent versions. Viewers see committed
 * versions only, so there is no Moxfield status and nothing to commit.
 */
export function SharedOverviewContent({ scope, overview, latest }: SharedOverviewContentProps) {
  return (
    <SidebarLayout>
      <div className="flex min-w-0 flex-col gap-5 md:gap-6">
        {latest === null ? (
          <EmptyState
            icon={<History aria-hidden="true" />}
            title="Nothing committed yet"
            description="This deck has no versions yet. They show up here once they are committed."
          />
        ) : (
          <LatestVersion scope={scope} detail={latest} />
        )}
      </div>
      <aside className="flex min-w-0 flex-col gap-5" aria-label="Versions">
        <RecentVersions
          scope={scope}
          versions={overview.recentVersions}
          versionCount={overview.versionCount}
          headSequence={overview.head?.sequence ?? null}
          emptyDescription="Versions show up here once they are committed."
        />
      </aside>
    </SidebarLayout>
  );
}

/** The latest version: what it is, its tags, then everything it changed. */
function LatestVersion({ scope, detail }: { scope: DeckScope; detail: SharedVersionDetailDTO }) {
  const { version, diff, catalog } = detail;
  const routes = deckRoutes(scope);
  const initial = version.parentSequence === null;

  return (
    <>
      {/* The restore button sits beside the title from `sm` up, and closes the card on phones. */}
      <Card
        as="section"
        aria-labelledby="latest-heading"
        className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="min-w-0">
          <Overline>Latest version</Overline>
          <h2 id="latest-heading" className="mt-1.5 flex items-start gap-2.5 text-base font-semibold text-fg">
            <VersionBadge sequence={version.sequence} latest />
            <Link href={routes.version(version.sequence)} className="min-w-0 break-words hover:text-accent">
              <span className="sr-only">{versionLabel(version.sequence)}: </span>
              {version.message}
            </Link>
          </h2>
          <MetaList className="mt-1.5 text-sm text-muted tabular">
            <MetaItem>
              Committed <RelativeTime value={version.createdAt} />
            </MetaItem>
            {version.sourceVersion !== null && <MetaItem>Moxfield version {version.sourceVersion}</MetaItem>}
            <MetaItem>{pluralize(version.playedCardCount, 'card')}</MetaItem>
          </MetaList>
        </div>
        <div className="order-last sm:order-none sm:col-start-2 sm:row-start-1">
          <ButtonLink
            href={routes.restore(version.sequence)}
            variant="secondary"
            size="sm"
            icon={<Undo2 aria-hidden="true" className="size-4" />}
          >
            Restore to Moxfield
          </ButtonLink>
        </div>
        {version.tags.length > 0 && (
          <div className="sm:col-span-2">
            <VersionTags tags={version.tags} />
          </div>
        )}
        {!initial && <SummaryChips diff={diff} view={detail.view} className="sm:col-span-2" />}
      </Card>

      <Card as="section" aria-labelledby="changes-heading">
        <CardHeader
          id="changes-heading"
          title={changesTitle(version.parentSequence)}
          description={initial ? initialDescription(version.playedCardCount) : diffCountLabel(diff)}
          className="mb-4"
        />
        <DiffView
          diff={diff}
          catalog={catalog}
          scope={scope}
          initial={initial}
          primerHref={routes.version(version.sequence, 'primer')}
          emptyMessage="This version is identical to the previous one."
          view={detail.view}
          hiddenChangeCount={detail.hiddenChangeCount}
        />
      </Card>
    </>
  );
}
