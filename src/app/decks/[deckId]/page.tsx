import { ArrowRight, History, X } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { IngestWarning } from '@/core/model';
import { CommitForm } from '@/components/deck/commit-form';
import { DiffView, diffCountLabel, initialPlayedCount } from '@/components/deck/diff-view';
import { SummaryChips } from '@/components/deck/summary-chips';
import { StatusPanel } from '@/components/deck/status-panel';
import { UntrackDeckButton } from '@/components/deck/untrack-deck-button';
import { VersionTimeline } from '@/components/deck/version-timeline';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { EmptyState } from '@/components/ui/empty-state';
import { pluralize, versionLabel } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import { routes } from '@/lib/routes';

import { decodeSegment, loadOverview, loadTags } from './data';

export const dynamic = 'force-dynamic';

const RECENT_VERSIONS_SHOWN = 5;

/** Deck status: Moxfield state, uncommitted changes, commit form and recent versions. */
export default async function DeckStatusPage({ params, searchParams }: PageProps<'/decks/[deckId]'>) {
  const deckId = decodeSegment((await params).deckId);
  const { captured } = await searchParams;
  const [overview, tags] = await Promise.all([loadOverview(deckId), loadTags(deckId)]);
  if (overview === null) notFound();

  const { diff, head, working } = overview;
  const canCommit =
    working !== null &&
    diff !== null &&
    !diff.isEmpty &&
    overview.status !== 'clean' &&
    overview.status !== 'never-fetched';
  const recent = overview.recentVersions.slice(0, RECENT_VERSIONS_SHOWN);

  return (
    <div className="grid items-start gap-5 md:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-5 md:gap-6">
        {captured === '1' && (
          <Alert
            tone="success"
            role="status"
            title="Updated from Moxfield"
            trailing={
              <Link
                href={routes.deck(overview.id)}
                replace
                scroll={false}
                aria-label="Dismiss"
                className="-m-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg"
              >
                <X aria-hidden="true" className="size-4" />
              </Link>
            }
          >
            The deck sent from your browser is now the current Moxfield state below.
          </Alert>
        )}

        <StatusPanel deck={overview}>
          {diff !== null && head !== null && !diff.isEmpty && (
            <SummaryChips diff={diff} className="sm:pl-6" />
          )}
        </StatusPanel>

        {canCommit && (
          <CommitForm
            deckId={overview.id}
            nextSequence={(head?.sequence ?? 0) + 1}
            suggestedMessage={overview.suggestedMessage}
            expectedObservationId={working.id}
            expectedHeadCommitId={head?.commitId ?? null}
            existingTags={tags.map((tag) => tag.name)}
          />
        )}

        {overview.warnings.length > 0 && <WarningsBanner warnings={overview.warnings} />}

        {diff !== null && !diff.isEmpty && (
          <Card as="section" aria-labelledby="changes-heading">
            <CardHeader
              id="changes-heading"
              title={head === null ? 'Initial version' : `Changes since ${versionLabel(head.sequence)}`}
              description={
                head === null
                  ? `${pluralize(initialPlayedCount(diff), 'card')} in the deck. All of it becomes v1.`
                  : diffCountLabel(diff)
              }
              className="mb-4"
            />
            <DiffView
              diff={diff}
              catalog={overview.catalog}
              deckId={overview.id}
              initial={head === null}
              primerHref={routes.compare(overview.id, {
                from: head === null ? 'empty' : 'head',
                to: 'working',
                hash: 'primer',
              })}
            />
          </Card>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-5" aria-label="Versions">
        <Card as="section" aria-labelledby="recent-heading" flush>
          <div className="flex items-center justify-between gap-3 px-4 pt-3 md:px-5 md:pt-4 md:pb-1">
            <h2 id="recent-heading" className="text-base font-semibold text-fg">
              Recent versions
            </h2>
            {overview.versionCount > 0 && (
              <Link
                href={routes.history(overview.id)}
                className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline md:min-h-0"
              >
                All {overview.versionCount}
                <ArrowRight aria-hidden="true" className="size-3.5" />
              </Link>
            )}
          </div>
          {recent.length > 0 ? (
            <VersionTimeline
              deckId={overview.id}
              versions={recent}
              headSequence={head?.sequence ?? null}
              compact
              className="pb-1"
            />
          ) : (
            <EmptyState
              variant="inline"
              className="py-8"
              icon={<History aria-hidden="true" />}
              title="No versions yet"
              description="Your first commit becomes v1."
            />
          )}
        </Card>
        <div className="flex justify-end lg:justify-start">
          <UntrackDeckButton
            deckId={overview.id}
            deckName={deckTitle(overview)}
            versionCount={overview.versionCount}
          />
        </div>
      </aside>
    </div>
  );
}

function WarningsBanner({ warnings }: { warnings: readonly IngestWarning[] }) {
  return (
    <Alert tone="warn" title={`Moxfield data came with ${pluralize(warnings.length, 'warning')}`}>
      <Disclosure summary="Show details">
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
          {warnings.map((warning, index) => (
            <li key={index} className="break-words">
              {warning.message}
            </li>
          ))}
        </ul>
      </Disclosure>
    </Alert>
  );
}
