import { ArrowDown, ArrowRight, GitCompareArrows } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CompareForm } from '@/components/deck/compare-form';
import { DiffView, diffCountLabel } from '@/components/deck/diff-view';
import { PrimerDiffView } from '@/components/deck/primer-diff-view';
import { CopyButton } from '@/components/ui/copy-button';
import { SummaryChips } from '@/components/deck/summary-chips';
import { VersionBadge } from '@/components/deck/version-row';
import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { RelativeTime } from '@/components/ui/relative-time';
import { versionLabel } from '@/lib/format';
import { deckTitle } from '@/lib/presentation';
import { routes } from '@/lib/routes';
import type { CompareSideDTO, DeckOverviewDTO } from '@/server/services/types';

import { deckServices, decodeSegment, loadOverview } from '../data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/decks/[deckId]/compare'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Compare' : `Compare · ${deckTitle(overview)}` };
}

function param(value: string | string[] | undefined): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? undefined : text.slice(0, 80);
}

/**
 * Default comparison: the latest version against the current Moxfield deck when they
 * differ (what would be committed), otherwise the last two versions.
 */
function defaultRefs(overview: DeckOverviewDTO): { from: string; to: string } | null {
  if (overview.working !== null && overview.status !== 'clean') {
    return { from: overview.head === null ? 'empty' : 'head', to: 'working' };
  }
  const [latest, previous] = overview.recentVersions;
  if (latest === undefined) return null;
  return {
    from: previous === undefined ? 'empty' : versionLabel(previous.sequence),
    to: versionLabel(latest.sequence),
  };
}

/** The ref of a resolved side, as used by the pickers (`v12`, `working`, `empty`). */
function sideRef(side: CompareSideDTO): string {
  switch (side.kind) {
    case 'version':
      return versionLabel(side.version.sequence);
    case 'working':
      return 'working';
    case 'empty':
      return 'empty';
  }
}

/** Compare any two versions, the current Moxfield deck, or the empty deck. */
export default async function ComparePage({ params, searchParams }: PageProps<'/decks/[deckId]/compare'>) {
  const deckId = decodeSegment((await params).deckId);
  const query = await searchParams;
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();

  const defaults = defaultRefs(overview);
  if (defaults === null) {
    return (
      <EmptyState
        icon={<GitCompareArrows aria-hidden="true" />}
        title="Nothing to compare yet"
        description="Once the deck has been fetched from Moxfield or committed, you can compare any two states here."
        actions={
          <ButtonLink href={routes.deck(overview.id)} variant="primary">
            Go to Status
          </ButtonLink>
        }
      />
    );
  }

  const from = param(query.from) ?? defaults.from;
  const to = param(query.to) ?? defaults.to;
  const services = await deckServices(deckId);
  const comparison = await services.compare(deckId, from, to);

  if (comparison === null) {
    const versions = await services.listVersions(deckId);
    // The pickers list concrete versions, so `head` is shown as the version it points to.
    const pickerRef = (ref: string): string =>
      ref === 'head' ? (overview.head === null ? 'empty' : versionLabel(overview.head.sequence)) : ref;
    return (
      <div className="flex flex-col gap-5">
        <Card>
          <CompareForm
            deckId={overview.id}
            versions={versions}
            hasWorking={overview.working !== null}
            from={pickerRef(defaults.from)}
            to={pickerRef(defaults.to)}
          />
        </Card>
        <Alert tone="error" title="Could not find one of the sides" role="alert">
          “{from}” or “{to}” is not a version of this deck. Pick two sides above.
        </Alert>
      </div>
    );
  }

  const { diff, primerDiff } = comparison;
  const fromEmpty = comparison.from.kind === 'empty';

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <Card as="section" aria-label="Choose what to compare">
        <CompareForm
          deckId={overview.id}
          versions={comparison.versions}
          hasWorking={comparison.hasWorking}
          from={sideRef(comparison.from)}
          to={sideRef(comparison.to)}
        />
      </Card>

      <div className="grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-3">
        <SideSummary side={comparison.from} label="From" deckId={overview.id} />
        <span aria-hidden="true" className="flex items-center justify-center text-subtle">
          <ArrowDown className="size-4 md:hidden" />
          <ArrowRight className="hidden size-5 md:block" />
        </span>
        <SideSummary side={comparison.to} label="To" deckId={overview.id} />
      </div>

      <Card as="section" aria-labelledby="compare-changes">
        <CardHeader
          id="compare-changes"
          title="Changes"
          description={diff.isEmpty ? 'Both sides are identical.' : diffCountLabel(diff)}
          className={diff.isEmpty ? undefined : 'mb-3'}
        />
        {!diff.isEmpty && (
          <>
            {!fromEmpty && <SummaryChips diff={diff} className="mb-5" />}
            <DiffView
              diff={diff}
              catalog={comparison.catalog}
              deckId={overview.id}
              initial={fromEmpty}
              primerHref={routes.compare(overview.id, {
                from: sideRef(comparison.from),
                to: sideRef(comparison.to),
                hash: 'primer',
              })}
            />
          </>
        )}
      </Card>

      {(primerDiff.unknown || primerDiff.hunks.length > 0) && (
        <Card as="section" aria-labelledby="primer" className="scroll-mt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id="primer" className="text-base font-semibold text-fg">
              Primer
            </h2>
            <div className="flex flex-wrap gap-2">
              <PrimerCopyButton side={comparison.from} primer={comparison.primers.from} />
              <PrimerCopyButton side={comparison.to} primer={comparison.primers.to} />
            </div>
          </div>
          <PrimerDiffView diff={primerDiff} />
        </Card>
      )}
    </div>
  );
}

/**
 * Copies one side's primer source, to put that primer back on Moxfield (a diff mixes
 * both sides, so it is not something to copy from). Nothing to copy for the empty deck,
 * an uncaptured primer or a version without a primer.
 */
function PrimerCopyButton({ side, primer }: { side: CompareSideDTO; primer: string | null }) {
  if (side.kind === 'empty' || primer === null || primer === '') return null;
  const name = side.kind === 'version' ? versionLabel(side.version.sequence) : 'current';
  return <CopyButton text={primer} label={`Copy ${name} primer`} subject={`${name} primer`} size="sm" />;
}

function SideSummary({ side, label, deckId }: { side: CompareSideDTO; label: string; deckId: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
      {/* Every kind of side gets a title row as tall as the version badge, so both cards line up. */}
      {side.kind === 'version' && (
        <>
          <Link
            href={routes.version(deckId, side.version.sequence)}
            className="flex min-h-6 min-w-0 items-center gap-2 text-sm font-medium text-fg hover:text-accent"
          >
            <VersionBadge sequence={side.version.sequence} />
            <span className="truncate" title={side.version.message}>
              {side.version.message}
            </span>
          </Link>
          <MetaList className="text-xs text-muted">
            <MetaItem>
              Committed <RelativeTime value={side.version.createdAt} />
            </MetaItem>
            {side.version.sourceVersion !== null && (
              <MetaItem>Moxfield version {side.version.sourceVersion}</MetaItem>
            )}
          </MetaList>
        </>
      )}
      {side.kind === 'working' && (
        <>
          <p className="flex min-h-6 items-center text-sm font-medium text-fg">Current Moxfield deck</p>
          <MetaList className="text-xs text-muted">
            <MetaItem>
              As of <RelativeTime value={side.observation.fetchedAt} />
            </MetaItem>
            {side.observation.sourceVersion !== null && (
              <MetaItem>Moxfield version {side.observation.sourceVersion}</MetaItem>
            )}
          </MetaList>
        </>
      )}
      {side.kind === 'empty' && (
        <>
          <p className="flex min-h-6 items-center text-sm font-medium text-fg">Empty deck</p>
          <p className="text-xs text-muted">No cards</p>
        </>
      )}
    </div>
  );
}
