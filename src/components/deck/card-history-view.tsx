import clsx from 'clsx';
import type { Route } from 'next';

import type { CardFacts } from '@/core/model';
import type { CardHistory, CardHistoryEntry, CardHistoryRun, ZoneQuantity } from '@/core/history/types';
import { zoneLabel } from '@/core/zones';
import { Card } from '@/components/ui/card';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { Link } from '@/components/ui/navigation';
import { RelativeTime } from '@/components/ui/relative-time';
import { SegmentedLinks } from '@/components/ui/tabs';
import { formatTimes, joinList, pluralize, versionLabel, versionRangeLabel } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';

import { CardName } from './card-name';
import { ManaCost } from './mana-cost';
import { ZoneBadge } from './zone-badge';

function zoneNames(zones: readonly { zone: ZoneQuantity['zone'] }[]): string {
  return joinList(zones.map(({ zone }) => zoneLabel(zone)));
}

function totalQuantity(zones: readonly ZoneQuantity[]): number {
  return zones.reduce((sum, zone) => sum + zone.quantity, 0);
}

/**
 * User-facing label of a history transition (docs/ux.md: _moved from Mainboard_, _restored_,
 * ...), with the card's previous name when it was renamed at this version.
 */
export function transitionLabel(entry: CardHistoryEntry): string {
  if (!entry.renamedFrom) return zoneTransitionLabel(entry);
  const { name } = entry.renamedFrom;
  return entry.transition === 'unchanged'
    ? `Renamed from ${name}`
    : `${zoneTransitionLabel(entry)}, renamed from ${name}`;
}

function zoneTransitionLabel(entry: CardHistoryEntry): string {
  switch (entry.transition) {
    case 'first-seen':
      return entry.sequence === null ? 'In the current Moxfield deck' : 'In the first version';
    case 'added':
      return 'Added';
    case 'removed':
      return entry.previousZones.length > 0 ? `Removed from ${zoneNames(entry.previousZones)}` : 'Removed';
    case 'moved':
      return entry.previousZones.length > 0 ? `Moved from ${zoneNames(entry.previousZones)}` : 'Moved';
    case 'restored': {
      const restoredFrom = entry.restoredFrom ?? [];
      if (restoredFrom.length === 0) return 'Returned to the deck';
      const last = restoredFrom
        .map(({ lastSequence }) => lastSequence)
        .filter((sequence): sequence is number => sequence !== null);
      const since = last.length > 0 ? ` (last there in ${versionLabel(Math.max(...last))})` : '';
      return `Restored to ${zoneNames(restoredFrom)}${since}`;
    }
    case 'quantity':
      return `${totalQuantity(entry.previousZones)} → ${totalQuantity(entry.zones)} copies`;
    case 'unchanged':
      return 'No change';
  }
}

type TransitionTone = 'add' | 'remove' | 'move' | 'neutral';

function transitionTone(entry: CardHistoryEntry): TransitionTone {
  switch (entry.transition) {
    case 'added':
    case 'restored':
    case 'first-seen':
      return 'add';
    case 'removed':
      return 'remove';
    case 'moved':
      return 'move';
    default:
      return 'neutral';
  }
}

const DOT_TONES: Record<TransitionTone, string> = {
  add: 'bg-add',
  remove: 'bg-remove',
  move: 'bg-move',
  neutral: 'bg-border-strong',
};

/**
 * The history in a few facts: `In 8 of 8 versions`, `played in 3`, `cut once`,
 * `restored once`. The first counts versions with the card on any board (Considering
 * and the sideboard included); `played in` counts versions with the card in a played
 * zone (command zone or mainboard) and is left out when it is the same number.
 */
export function historySummary(history: CardHistory): string[] {
  const { versionCount, versionsPresent: present, versionsInPlayedZones: played } = history.summary;
  const parts = [
    versionCount > 1 && present === versionCount
      ? `In all ${versionCount} versions`
      : `In ${present} of ${pluralize(versionCount, 'version')}`,
  ];
  if (present > 0 && played === 0) parts.push('never played');
  else if (played !== present) parts.push(`played in ${played}`);
  if (history.summary.timesCut > 0) parts.push(`cut ${formatTimes(history.summary.timesCut)}`);
  if (history.summary.timesRestored > 0) parts.push(`restored ${formatTimes(history.summary.timesRestored)}`);
  return parts;
}

export interface CardHistoryViewProps {
  /** The deck pages the timeline links within (the owner's or a share link's). */
  scope: DeckScope;
  history: CardHistory;
  facts: CardFacts | null;
  /** Show every version instead of compressed runs. */
  showAll: boolean;
}

/**
 * A card's history across the deck's versions: header with card facts and current
 * zones, a summary sentence, and a timeline (newest first) of runs where the card's
 * state did not change, labeled with the transition that started each run.
 */
export function CardHistoryView({ scope, history, facts, showAll }: CardHistoryViewProps) {
  const routes = deckRoutes(scope);
  const current = history.summary.currentZones;
  const hasWorking = history.entries.at(-1)?.sequence === null;
  return (
    <div className="flex flex-col gap-5">
      <Card as="section" aria-labelledby="card-heading">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="card-heading"
              className="text-xl font-semibold tracking-tight text-balance break-words text-fg"
            >
              <CardName name={history.name} scryfallId={facts?.scryfallId} />
            </h2>
            {facts !== null && facts.typeLine !== '' && (
              <p className="mt-0.5 text-sm text-muted">{facts.typeLine}</p>
            )}
          </div>
          {facts !== null && <ManaCost cost={facts.manaCost} className="mt-1.5 shrink-0" />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{hasWorking ? 'Now on Moxfield:' : 'In the latest version:'}</span>
          {current.length > 0 ? (
            current.map(({ zone, quantity }) => <ZoneBadge key={zone} zone={zone} quantity={quantity} />)
          ) : (
            <span className="font-medium text-fg">Not in the deck</span>
          )}
        </div>
        <MetaList aria-label="Summary" className="mt-3 text-sm font-medium text-fg">
          {historySummary(history).map((part) => (
            <MetaItem key={part}>{part}</MetaItem>
          ))}
        </MetaList>
        {history.summary.firstSeenSequence !== null && (
          <MetaList aria-label="First and last version" className="mt-0.5 text-sm text-muted">
            <MetaItem>First in {versionLabel(history.summary.firstSeenSequence)}</MetaItem>
            {history.summary.lastSeenSequence !== null &&
              history.summary.lastSeenSequence !== history.summary.firstSeenSequence && (
                <MetaItem>last in {versionLabel(history.summary.lastSeenSequence)}</MetaItem>
              )}
          </MetaList>
        )}
      </Card>

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="timeline-heading" className="text-base font-semibold text-fg">
            Timeline
          </h2>
          <SegmentedLinks
            label="Timeline detail"
            activeId={showAll ? 'all' : 'changes'}
            items={[
              { id: 'changes', label: 'Changes', href: routes.card(history.key) },
              { id: 'all', label: 'Every version', href: routes.card(history.key, { all: true }) },
            ]}
          />
        </div>
        <Card flush>
          <ol aria-label="Card timeline" className="relative py-2">
            {showAll
              ? [...history.entries]
                  .reverse()
                  .map((entry) => (
                    <TimelineItem
                      key={entry.commitId ?? 'working'}
                      scope={scope}
                      entry={entry}
                      range={entry.sequence === null ? 'Current' : versionLabel(entry.sequence)}
                      zones={entry.zones}
                    />
                  ))
              : [...history.runs]
                  .reverse()
                  .map((run) => (
                    <TimelineItem
                      key={run.first.commitId ?? 'working'}
                      scope={scope}
                      entry={run.first}
                      range={runRange(run)}
                      zones={run.zones}
                      length={committedLength(run)}
                    />
                  ))}
          </ol>
        </Card>
      </section>
    </div>
  );
}

/** Versions in a run; a trailing current Moxfield state is not a version. */
function committedLength(run: CardHistoryRun): number {
  return run.last.sequence === null ? run.length - 1 : run.length;
}

function runRange(run: CardHistoryRun): string {
  const first = run.first.sequence;
  const last = run.last.sequence;
  if (first === null) return 'Current';
  if (last === null) return `${versionLabel(first)}–now`;
  return versionRangeLabel(first, last);
}

/** A version's page; the current Moxfield state (owners only) is the deck's Status page. */
function entryHref(scope: DeckScope, entry: CardHistoryEntry): Route {
  const routes = deckRoutes(scope);
  return entry.sequence === null ? routes.overview() : routes.version(entry.sequence);
}

function TimelineItem({
  scope,
  entry,
  range,
  zones,
  length,
}: {
  scope: DeckScope;
  entry: CardHistoryEntry;
  range: string;
  zones: readonly ZoneQuantity[];
  length?: number;
}) {
  const tone = transitionTone(entry);
  const absent = zones.length === 0;
  // An unchanged absent run already reads "Not in the deck"; repeating "No change" adds nothing.
  const label = entry.transition === 'unchanged' && absent ? null : transitionLabel(entry);
  return (
    <li className="group relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2 px-3 py-2.5 md:px-4">
      {/* Rail connecting the dots; it starts at the first dot and ends at the last one. */}
      <span
        aria-hidden="true"
        className="absolute top-0 bottom-0 left-[1.46875rem] w-px bg-border group-first:top-5 group-last:bottom-auto group-last:h-5 group-only:hidden md:left-[1.71875rem]"
      />
      <span aria-hidden="true" className="relative z-[1] flex justify-center pt-1.5">
        <span
          className={clsx(
            'block size-2.5 rounded-full ring-4 ring-surface',
            absent ? 'border-2 border-border-strong bg-surface' : DOT_TONES[tone],
          )}
        />
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={entryHref(scope, entry)}
            className="text-sm font-semibold text-fg tabular hover:text-accent hover:underline"
          >
            {range}
          </Link>
          {length !== undefined && length > 1 && (
            <span className="text-xs text-muted tabular">{pluralize(length, 'version')}</span>
          )}
          <span className="flex flex-wrap gap-1">
            {absent ? (
              <span className="text-xs font-medium text-muted">Not in the deck</span>
            ) : (
              zones.map(({ zone, quantity }) => (
                <ZoneBadge key={zone} zone={zone} quantity={quantity > 1 ? quantity : undefined} />
              ))
            )}
          </span>
        </div>
        {(label !== null || entry.message !== '') && (
          <MetaList className="mt-0.5 text-sm text-muted">
            {label !== null && <MetaItem className="font-medium text-fg">{label}</MetaItem>}
            {entry.message !== '' && <MetaItem>{entry.message}</MetaItem>}
          </MetaList>
        )}
        <p className="text-xs text-muted">
          <RelativeTime value={entry.at} />
        </p>
      </div>
    </li>
  );
}
