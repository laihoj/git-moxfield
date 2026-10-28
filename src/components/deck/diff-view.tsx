import clsx from 'clsx';
import { ArrowRight, Equal, EyeOff } from 'lucide-react';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { groupInto } from '@/core/collections';
import { DEFAULT_DECK_VIEW, type DeckView } from '@/core/deck-view';
import {
  diffChangeCount,
  groupDiffForDisplay,
  type AddedChange,
  type DeckDiff,
  type DeckInfoChange,
  type DiffSection,
} from '@/core/diff';
import type { CardFacts, CardKey } from '@/core/model';
import { isPlayedZone, zoneEntries, zoneLabel, type ZoneId } from '@/core/zones';
import { Overline } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { ArrowLink, TextLink } from '@/components/ui/text-link';
import { domIdSlug, MINUS_SIGN, pluralize, versionLabel } from '@/lib/format';
import { formatLabel } from '@/lib/presentation';
import type { DeckScope } from '@/lib/routes';

import { CardRows } from './deck-list';
import { DiffRow } from './diff-row';
import { PrimerLineCounts } from './primer-line-counts';
import { zoneTextClass } from './zone-badge';

const COSMETIC_KINDS: ReadonlySet<DiffSection['kind']> = new Set(['printings', 'tags', 'renames']);

export interface DiffViewProps {
  diff: DeckDiff;
  catalog: Record<CardKey, CardFacts>;
  /** The deck pages card names link within (the owner's or a share link's). */
  scope: DeckScope;
  /**
   * The "before" side is the empty deck (first version): show counts per zone and a
   * collapsed card list instead of one `+` row per card.
   */
  initial?: boolean;
  /** Where "View diff" for the primer leads (primer tab, compare page, or an anchor). */
  primerHref?: Route;
  /** Text shown when nothing differs. */
  emptyMessage?: ReactNode;
  /** The deck view the diff was computed for: the cEDH view lists the mainboard as Add and Cut. */
  view?: DeckView;
  /** Differences the view left out of `diff` (see `hiddenChangeCount`); they are mentioned, never listed. */
  hiddenChangeCount?: number;
}

/**
 * Semantic diff, in the order of docs/ux.md: Commanders, zones, Moved, Deck info,
 * Primer, then collapsed cosmetic sections (Printings, Card tags, Renamed). In the cEDH
 * view the mainboard reads as Add and Cut, and a note says how many changes outside the
 * sleeved deck the view leaves out.
 */
export function DiffView({
  diff,
  catalog,
  scope,
  initial = false,
  primerHref,
  emptyMessage,
  view = DEFAULT_DECK_VIEW,
  hiddenChangeCount = 0,
}: DiffViewProps) {
  if (diff.isEmpty) {
    if (hiddenChangeCount > 0) return <HiddenChangesNote count={hiddenChangeCount} standalone />;
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted">
        <Equal aria-hidden="true" className="size-4" />
        {emptyMessage ?? 'No differences.'}
      </p>
    );
  }
  if (initial)
    return <InitialVersionView diff={diff} catalog={catalog} scope={scope} primerHref={primerHref} />;

  const sections = groupDiffForDisplay(diff, view);
  const strategic = sections.filter((section) => !COSMETIC_KINDS.has(section.kind));
  const cosmetic = sections.filter((section) => COSMETIC_KINDS.has(section.kind));

  return (
    <div className="flex flex-col gap-5">
      {strategic.map((section) => (
        <ChangeSection key={section.id} section={section} catalog={catalog} scope={scope} view={view} />
      ))}
      {diff.deck.length > 0 && <DeckInfoSection changes={diff.deck} />}
      <PrimerSection diff={diff} primerHref={primerHref} />
      {cosmetic.length > 0 && (
        <div className="flex flex-col border-t border-border pt-2">
          {cosmetic.map((section) => (
            <Disclosure
              key={section.id}
              summary={<span className="text-muted">{section.title}</span>}
              meta={section.changes.length}
            >
              <ul className="divide-y divide-border">
                {section.changes.map((change) => (
                  <DiffRow
                    key={changeKey(change)}
                    change={change}
                    catalog={catalog}
                    scope={scope}
                    view={view}
                  />
                ))}
              </ul>
            </Disclosure>
          ))}
        </div>
      )}
      {hiddenChangeCount > 0 && <HiddenChangesNote count={hiddenChangeCount} />}
    </div>
  );
}

/**
 * What the cEDH view leaves out: changes in the sideboard, Considering and any other
 * zone outside the sleeved deck. On its own (`standalone`) when they are all there is.
 */
function HiddenChangesNote({ count, standalone = false }: { count: number; standalone?: boolean }) {
  return (
    <p
      className={clsx(
        'flex items-start gap-2 text-sm text-muted',
        standalone ? 'py-2' : 'border-t border-border pt-3',
      )}
    >
      <EyeOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>
        Left out by the cEDH view: {pluralize(count, 'change')} outside the sleeved deck (sideboard,
        Considering).
      </span>
    </p>
  );
}

/**
 * Copies in played zones (commanders, companion, signature spells, mainboard) added by
 * a diff from the empty deck: the size of an initial version.
 */
export function initialPlayedCount(diff: DeckDiff): number {
  return diff.changes.reduce(
    (sum, change) => (change.type === 'added' && isPlayedZone(change.zone) ? sum + change.quantity : sum),
    0,
  );
}

/** Heading of the card that lists a version's (or the working deck's) changes: `Initial version`, or `Changes since v3`. */
export function changesTitle(parentSequence: number | null): string {
  return parentSequence === null ? 'Initial version' : `Changes since ${versionLabel(parentSequence)}`;
}

/** Under an initial version's heading: how big the deck is, `100 cards in the deck`. */
export function initialDescription(cardCount: number): string {
  return `${pluralize(cardCount, 'card')} in the deck`;
}

/** Number of differences, for headings: `12 changes`. */
export function diffCountLabel(diff: DeckDiff): string {
  return pluralize(diffChangeCount(diff), 'change');
}

function changeKey(change: DiffSection['changes'][number]): string {
  if (change.type === 'moved') return `moved:${change.key}:${change.from}:${change.to}`;
  if ('zone' in change) return `${change.type}:${change.key}:${change.zone}`;
  return `${change.type}:${change.key}`;
}

/** The heading color of a section: its zone's, or the add and remove colors of the cEDH view's Add and Cut. */
function sectionTextClass(section: DiffSection): string | undefined {
  if (section.kind === 'add') return 'text-add';
  if (section.kind === 'cut') return 'text-remove';
  return section.zone === undefined ? undefined : zoneTextClass(section.zone);
}

function ChangeSection({
  section,
  catalog,
  scope,
  view,
}: {
  section: DiffSection;
  catalog: Record<CardKey, CardFacts>;
  scope: DeckScope;
  view: DeckView;
}) {
  const headingId = `diff-${domIdSlug(section.id)}`;
  return (
    <section aria-labelledby={headingId}>
      <Overline id={headingId} className={clsx('mb-1', sectionTextClass(section))}>
        {section.title}
        <span className="ml-1.5 font-medium text-subtle normal-case tabular">{section.changes.length}</span>
      </Overline>
      <ul className="divide-y divide-border">
        {section.changes.map((change) => (
          <DiffRow key={changeKey(change)} change={change} catalog={catalog} scope={scope} view={view} />
        ))}
      </ul>
    </section>
  );
}

const DECK_FIELD_LABELS: Record<DeckInfoChange['field'], string> = {
  name: 'Name',
  format: 'Format',
  description: 'Description',
  tags: 'Deck tags',
};

function deckValue(field: 'name' | 'format' | 'description', value: string): string {
  if (field === 'format') return formatLabel(value);
  return value === '' ? 'empty' : value;
}

function DeckInfoSection({ changes }: { changes: DeckInfoChange[] }) {
  return (
    <section aria-labelledby="diff-deck-info">
      <Overline id="diff-deck-info" className="mb-1">
        Deck info
      </Overline>
      <ul className="divide-y divide-border">
        {changes.map((change) => (
          <li key={change.field} className="flex flex-col gap-0.5 py-2 text-sm md:flex-row md:gap-3">
            <span className="w-28 shrink-0 font-medium text-fg">{DECK_FIELD_LABELS[change.field]}</span>
            {change.field === 'tags' ? (
              <TagListChange added={change.added} removed={change.removed} />
            ) : (
              <span className="min-w-0 break-words text-muted">
                <span className="line-clamp-3">
                  <del className="text-remove decoration-remove/40">
                    {deckValue(change.field, change.before)}
                  </del>
                  <ArrowRight
                    aria-label="changed to"
                    className="mx-1.5 inline size-3.5 align-[-2px] text-subtle"
                  />
                  <ins className="text-add no-underline">{deckValue(change.field, change.after)}</ins>
                </span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TagListChange({ added, removed }: { added: string[]; removed: string[] }) {
  return (
    <span className="flex flex-wrap gap-x-2 text-muted">
      {added.map((tag) => (
        <span key={`+${tag}`} className="text-add">
          +{tag}
        </span>
      ))}
      {removed.map((tag) => (
        <span key={`-${tag}`} className="text-remove">
          {MINUS_SIGN}
          {tag}
        </span>
      ))}
    </span>
  );
}

function PrimerSection({ diff, primerHref }: { diff: DeckDiff; primerHref: Route | undefined }) {
  if (diff.primer.status === 'unchanged') return null;
  return (
    <section
      aria-labelledby="diff-primer"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
    >
      <div className="flex items-baseline gap-3">
        <Overline id="diff-primer">Primer</Overline>
        {diff.primer.status === 'changed' ? (
          <PrimerLineCounts added={diff.primer.addedLines} removed={diff.primer.removedLines} />
        ) : (
          <span className="text-sm text-muted">
            {diff.primer.status === 'captured'
              ? 'Captured (the previous version has none)'
              : 'Not captured on one side, so changes are unknown'}
          </span>
        )}
      </div>
      {diff.primer.status === 'changed' && primerHref !== undefined && (
        <ArrowLink href={primerHref}>View diff</ArrowLink>
      )}
    </section>
  );
}

/** First version: per-zone totals and the full list collapsed. */
function InitialVersionView({
  diff,
  catalog,
  scope,
  primerHref,
}: {
  diff: DeckDiff;
  catalog: Record<CardKey, CardFacts>;
  scope: DeckScope;
  primerHref: Route | undefined;
}) {
  const byZone = new Map<ZoneId, AddedChange[]>();
  for (const change of diff.changes) {
    if (change.type !== 'added') continue;
    groupInto(byZone, change.zone, change);
  }
  const zones = zoneEntries(byZone).map(([zone, changes]) => ({
    zone,
    changes,
    count: changes.reduce((sum, change) => sum + change.quantity, 0),
  }));
  const total = zones.reduce((sum, { count }) => sum + count, 0);

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Cards per zone" className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {zones.map(({ zone, count }) => (
          <li key={zone} className="rounded-lg border border-border bg-surface-2/60 px-3 py-2">
            <p className={clsx('text-xs font-semibold tracking-wide uppercase', zoneTextClass(zone))}>
              {zoneLabel(zone)}
            </p>
            <p className="mt-0.5 text-lg font-semibold text-fg tabular">{count}</p>
          </li>
        ))}
      </ul>
      {diff.primer.status === 'changed' && (
        <MetaList aria-label="Primer" className="text-sm text-muted">
          <MetaItem>Primer</MetaItem>
          <MetaItem>{pluralize(diff.primer.addedLines, 'line')}</MetaItem>
          {primerHref !== undefined && (
            <MetaItem>
              <TextLink href={primerHref}>Read primer</TextLink>
            </MetaItem>
          )}
        </MetaList>
      )}
      {diff.primer.status === 'unknown' && <p className="text-sm text-muted">Primer not captured</p>}
      <Disclosure summary={`Show all ${pluralize(total, 'card')}`} variant="card">
        <div className="flex flex-col gap-4">
          {zones.map(({ zone, changes, count }) => (
            <section key={zone} aria-label={zoneLabel(zone)}>
              <Overline className={clsx('mb-1', zoneTextClass(zone))}>
                {zoneLabel(zone)}
                <span className="ml-1.5 font-medium text-subtle normal-case tabular">{count}</span>
              </Overline>
              <CardRows cards={changes} catalog={catalog} scope={scope} divided />
            </section>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
