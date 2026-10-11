import { ArrowDown, ArrowRight, GitCompareArrows } from 'lucide-react';

import { CompareForm } from '@/components/deck/compare-form';
import { DiffView, diffCountLabel } from '@/components/deck/diff-view';
import { PrimerDiffView } from '@/components/deck/primer-diff-view';
import { SummaryChips } from '@/components/deck/summary-chips';
import { VersionBadge } from '@/components/deck/version-row';
import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { RelativeTime } from '@/components/ui/relative-time';
import { versionLabel } from '@/lib/format';
import { deckRoutes, type DeckScope, PAGE_ANCHORS } from '@/lib/routes';
import { searchParamText } from '@/lib/search-params';
import type { CompareDTO, CompareSideDTO, VersionRefDTO } from '@/server/services/types';
import { EMPTY_REF, WORKING_REF } from '@/lib/version-refs';

import { NoVersionsYet } from './no-versions-yet';

/** Both sides of a comparison, as version refs (`v12`, `head`, `working`, `empty`). */
export interface CompareRefs {
  from: string;
  to: string;
}

/**
 * The comparison shown without `?from&to`: the last two versions (the first version
 * against the empty deck). `null` without versions. (The owner's page puts the current
 * Moxfield deck first when it differs from the latest version.)
 */
export function latestVersionsRefs(newestVersions: readonly VersionRefDTO[]): CompareRefs | null {
  const [latest, previous] = newestVersions;
  if (latest === undefined) return null;
  return {
    from: previous === undefined ? EMPTY_REF : versionLabel(previous.sequence),
    to: versionLabel(latest.sequence),
  };
}

/** A `?from=` / `?to=` value: trimmed, bounded, `undefined` when absent. */
export function compareParam(value: string | string[] | undefined): string | undefined {
  return searchParamText(value, 80);
}

/** The sides a Compare page shows: those the query asks for, the defaults for the rest. */
export function requestedRefs(
  query: { from?: string | string[]; to?: string | string[] },
  defaults: CompareRefs,
): CompareRefs {
  return { from: compareParam(query.from) ?? defaults.from, to: compareParam(query.to) ?? defaults.to };
}

/** The ref of a resolved side, as used by the pickers (`v12`, `working`, `empty`). */
function sideRef(side: CompareSideDTO): string {
  switch (side.kind) {
    case 'version':
      return versionLabel(side.version.sequence);
    case 'working':
      return WORKING_REF;
    case 'empty':
      return EMPTY_REF;
  }
}

/** Compare before the deck has anything to compare. */
export function NothingToCompare({ scope }: { scope: DeckScope }) {
  return (
    <NoVersionsYet
      scope={scope}
      icon={<GitCompareArrows aria-hidden="true" />}
      title="Nothing to compare yet"
      ownerDescription="Once the deck has been fetched from Moxfield or committed, you can compare any two states here."
      viewerDescription="Once versions of this deck are committed, you can compare any two of them here."
    />
  );
}

export interface CompareSidesNotFoundProps {
  scope: DeckScope;
  /** Every version, newest first, for the pickers. */
  versions: readonly VersionRefDTO[];
  hasWorking: boolean;
  /** What the pickers start with (the default comparison). */
  defaults: CompareRefs;
  /** What was asked for and not found. */
  requested: CompareRefs;
}

/** Compare when `?from` or `?to` names no version of the deck: the pickers and what went wrong. */
export function CompareSidesNotFound({
  scope,
  versions,
  hasWorking,
  defaults,
  requested,
}: CompareSidesNotFoundProps) {
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CompareForm
          scope={scope}
          versions={versions}
          hasWorking={hasWorking}
          from={defaults.from}
          to={defaults.to}
        />
      </Card>
      <Alert tone="error" title="Could not find one of the sides" role="alert">
        “{requested.from}” or “{requested.to}” is not a version of this deck. Pick two sides above.
      </Alert>
    </div>
  );
}

export interface CompareContentProps {
  scope: DeckScope;
  /** The comparison (a viewer's, whose sides are never the working state, fits too). */
  comparison: Omit<CompareDTO, 'deck'>;
}

/** Compare: the pickers, both sides, the diff between them and the primer diff. */
export function CompareContent({ scope, comparison }: CompareContentProps) {
  const { diff, primerDiff } = comparison;
  const fromEmpty = comparison.from.kind === 'empty';
  const routes = deckRoutes(scope);

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <Card as="section" aria-label="Choose what to compare">
        <CompareForm
          scope={scope}
          versions={comparison.versions}
          hasWorking={comparison.hasWorking}
          from={sideRef(comparison.from)}
          to={sideRef(comparison.to)}
        />
      </Card>

      <div className="grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:gap-3">
        <SideSummary side={comparison.from} label="From" scope={scope} />
        <span aria-hidden="true" className="flex items-center justify-center text-subtle">
          <ArrowDown className="size-4 md:hidden" />
          <ArrowRight className="hidden size-5 md:block" />
        </span>
        <SideSummary side={comparison.to} label="To" scope={scope} />
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
              scope={scope}
              initial={fromEmpty}
              primerHref={routes.compare({
                from: sideRef(comparison.from),
                to: sideRef(comparison.to),
                section: 'primer',
              })}
            />
          </>
        )}
      </Card>

      {(primerDiff.unknown || primerDiff.hunks.length > 0) && (
        <Card as="section" aria-labelledby={PAGE_ANCHORS.comparePrimer} className="scroll-mt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h2 id={PAGE_ANCHORS.comparePrimer} className="text-base font-semibold text-fg">
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

function SideSummary({ side, label, scope }: { side: CompareSideDTO; label: string; scope: DeckScope }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-border bg-surface px-4 py-3 shadow-card">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">{label}</p>
      {/* Every kind of side gets a title row as tall as the version badge, so both cards line up. */}
      {side.kind === 'version' && (
        <>
          <Link
            href={deckRoutes(scope).version(side.version.sequence)}
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
