import { X } from 'lucide-react';
import { notFound } from 'next/navigation';

import type { IngestWarning } from '@/core/model';
import type { DeckOverviewDTO } from '@/server/services/types';
import { CommitForm } from '@/components/deck/commit-form';
import {
  changesTitle,
  DiffView,
  diffCountLabel,
  initialDescription,
  initialPlayedCount,
} from '@/components/deck/diff-view';
import { MoxfieldDeckPanel } from '@/components/deck/moxfield-deck-panel';
import { SummaryChips } from '@/components/deck/summary-chips';
import { StatusPanel } from '@/components/deck/status-panel';
import { UntrackDeckButton } from '@/components/deck/untrack-deck-button';
import { RecentVersions } from '@/components/deck-pages/recent-versions';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { Link } from '@/components/ui/navigation';
import { SidebarLayout } from '@/components/ui/sidebar-layout';
import { pluralize, versionLabel } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import { ownerDeckRoutes, routes } from '@/lib/routes';
import { EMPTY_REF, HEAD_REF, WORKING_REF } from '@/lib/version-refs';

import { decodeSegment, loadOverview, loadTags } from './data';

export const dynamic = 'force-dynamic';

/** Deck status: Moxfield state, uncommitted changes, commit form and recent versions. */
export default async function DeckStatusPage({ params, searchParams }: PageProps<'/decks/[deckId]'>) {
  const deckId = decodeSegment((await params).deckId);
  const { captured, relinked } = await searchParams;
  const [overview, tags] = await Promise.all([loadOverview(deckId), loadTags(deckId)]);
  if (overview === null) notFound();

  const { diff, head, working } = overview;
  const links = ownerDeckRoutes(overview.id);
  const canCommit =
    working !== null &&
    diff !== null &&
    !diff.isEmpty &&
    overview.status !== 'clean' &&
    overview.status !== 'never-fetched';

  return (
    <SidebarLayout>
      <div className="flex min-w-0 flex-col gap-5 md:gap-6">
        {(captured === '1' || relinked === '1') && (
          <Greeting deck={overview} captured={captured === '1'} relinked={relinked === '1'} />
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
              title={changesTitle(head?.sequence ?? null)}
              description={
                head === null
                  ? `${initialDescription(initialPlayedCount(diff))}. All of it becomes v1.`
                  : diffCountLabel(diff)
              }
              className="mb-4"
            />
            <DiffView
              diff={diff}
              catalog={overview.catalog}
              scope={links.scope}
              initial={head === null}
              primerHref={links.compare({
                from: head === null ? EMPTY_REF : HEAD_REF,
                to: WORKING_REF,
                section: 'primer',
              })}
            />
          </Card>
        )}
      </div>

      <aside className="flex min-w-0 flex-col gap-5" aria-label="Versions">
        <RecentVersions
          scope={links.scope}
          versions={overview.recentVersions}
          versionCount={overview.versionCount}
          headSequence={head?.sequence ?? null}
          emptyDescription="Your first commit becomes v1."
        />
        <MoxfieldDeckPanel
          deckId={overview.id}
          externalId={overview.externalId}
          url={overview.url}
          relinks={overview.relinks}
        />
        <div className="flex justify-end lg:justify-start">
          <UntrackDeckButton
            deckId={overview.id}
            deckName={deckTitle(overview)}
            versionCount={overview.versionCount}
          />
        </div>
      </aside>
    </SidebarLayout>
  );
}

/**
 * The notice after arriving from the bookmarklet (`captured`), from "Change Moxfield deck"
 * (`relinked`), or from a capture that continued the deck's history (both).
 */
function Greeting({
  deck,
  captured,
  relinked,
}: {
  deck: Pick<DeckOverviewDTO, 'id' | 'head' | 'working' | 'status'>;
  captured: boolean;
  relinked: boolean;
}) {
  const since = deck.head === null ? null : versionLabel(deck.head.sequence);
  let title = 'Updated from Moxfield';
  let text = 'The deck sent from your browser is now the current Moxfield state below.';
  if (relinked && captured) {
    title = 'Continued with the new Moxfield deck';
    if (since === null) {
      text = 'This deck now follows the Moxfield deck you sent, which is its current Moxfield state below.';
    } else if (deck.status === 'clean') {
      text = `This deck now follows the Moxfield deck you sent. Its versions are kept, and the deck matches ${since}.`;
    } else {
      text = `This deck now follows the Moxfield deck you sent. Its versions are kept; below is what changed since ${since}.`;
    }
  } else if (relinked) {
    title = 'Moxfield deck changed';
    text =
      deck.working === null
        ? 'This deck now follows the new Moxfield deck, and its versions are kept. Send the new deck with the bookmarklet to see what changed.'
        : 'This deck now follows the new Moxfield deck, and its versions are kept.';
  }
  return (
    <Alert
      tone="success"
      role="status"
      title={title}
      trailing={
        <Link
          href={routes.deck(deck.id)}
          replace
          scroll={false}
          aria-label="Dismiss"
          className="-m-1.5 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface hover:text-fg"
        >
          <X aria-hidden="true" className="size-4" />
        </Link>
      }
    >
      {text}
    </Alert>
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
