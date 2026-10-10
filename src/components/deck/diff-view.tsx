import clsx from 'clsx';
import { ArrowRight, Equal } from 'lucide-react';
import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  diffChangeCount,
  groupDiffForDisplay,
  type AddedChange,
  type DeckDiff,
  type DeckInfoChange,
  type DiffSection,
} from '@/core/diff';
import type { CardFacts, CardKey } from '@/core/model';
import { isPlayedZone, sortZones, zoneLabel, type ZoneId } from '@/core/zones';
import { Overline } from '@/components/ui/card';
import { Disclosure } from '@/components/ui/disclosure';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { MINUS_SIGN, pluralize } from '@/lib/format';
import { formatLabel } from '@/lib/presentation';
import { routes } from '@/lib/routes';

import { CardName } from './card-name';
import { DiffRow } from './diff-row';
import { ManaCost } from './mana-cost';
import { zoneTextClass } from './zone-badge';

const COSMETIC_KINDS: ReadonlySet<DiffSection['kind']> = new Set(['printings', 'tags', 'renames']);

export interface DiffViewProps {
  diff: DeckDiff;
  catalog: Record<CardKey, CardFacts>;
  deckId: string;
  /**
   * The "before" side is the empty deck (first version): show counts per zone and a
   * collapsed card list instead of one `+` row per card.
   */
  initial?: boolean;
  /** Where "View diff" for the primer leads (primer tab, compare page, or an anchor). */
  primerHref?: Route;
  /** Text shown when nothing differs. */
  emptyMessage?: ReactNode;
}

/**
 * Semantic diff, in the order of docs/ux.md: Commanders, zones, Moved, Deck info,
 * Primer, then collapsed cosmetic sections (Printings, Card tags, Renamed).
 */
export function DiffView({
  diff,
  catalog,
  deckId,
  initial = false,
  primerHref,
  emptyMessage,
}: DiffViewProps) {
  if (diff.isEmpty) {
    return (
      <p className="flex items-center gap-2 py-2 text-sm text-muted">
        <Equal aria-hidden="true" className="size-4" />
        {emptyMessage ?? 'No differences.'}
      </p>
    );
  }
  if (initial)
    return <InitialVersionView diff={diff} catalog={catalog} deckId={deckId} primerHref={primerHref} />;

  const sections = groupDiffForDisplay(diff);
  const strategic = sections.filter((section) => !COSMETIC_KINDS.has(section.kind));
  const cosmetic = sections.filter((section) => COSMETIC_KINDS.has(section.kind));

  return (
    <div className="flex flex-col gap-5">
      {strategic.map((section) => (
        <ChangeSection key={section.id} section={section} catalog={catalog} deckId={deckId} />
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
                  <DiffRow key={changeKey(change)} change={change} catalog={catalog} deckId={deckId} />
                ))}
              </ul>
            </Disclosure>
          ))}
        </div>
      )}
    </div>
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

/** Number of differences, for headings: `12 changes`. */
export function diffCountLabel(diff: DeckDiff): string {
  return pluralize(diffChangeCount(diff), 'change');
}

function changeKey(change: DiffSection['changes'][number]): string {
  if (change.type === 'moved') return `moved:${change.key}:${change.from}:${change.to}`;
  if ('zone' in change) return `${change.type}:${change.key}:${change.zone}`;
  return `${change.type}:${change.key}`;
}

function ChangeSection({
  section,
  catalog,
  deckId,
}: {
  section: DiffSection;
  catalog: Record<CardKey, CardFacts>;
  deckId: string;
}) {
  const headingId = `diff-${section.id.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <section aria-labelledby={headingId}>
      <Overline
        id={headingId}
        className={clsx('mb-1', section.zone !== undefined && zoneTextClass(section.zone))}
      >
        {section.title}
        <span className="ml-1.5 font-medium text-subtle normal-case tabular">{section.changes.length}</span>
      </Overline>
      <ul className="divide-y divide-border">
        {section.changes.map((change) => (
          <DiffRow key={changeKey(change)} change={change} catalog={catalog} deckId={deckId} />
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

function deckValue(field: DeckInfoChange['field'], value: string | string[]): string {
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ');
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
            {change.field === 'tags' && Array.isArray(change.before) && Array.isArray(change.after) ? (
              <TagListChange before={change.before} after={change.after} />
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

function TagListChange({ before, after }: { before: string[]; after: string[] }) {
  const added = after.filter((tag) => !before.includes(tag));
  const removed = before.filter((tag) => !after.includes(tag));
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
          <span className="text-sm font-medium tabular">
            <span className="text-add">+{diff.primer.addedLines}</span>
            <span className="text-subtle"> / </span>
            <span className="text-remove">
              {MINUS_SIGN}
              {diff.primer.removedLines}
            </span>
            <span className="text-muted"> lines</span>
          </span>
        ) : (
          <span className="text-sm text-muted">
            {diff.primer.status === 'captured'
              ? 'Captured (the previous version has none)'
              : 'Not captured on one side, so changes are unknown'}
          </span>
        )}
      </div>
      {diff.primer.status === 'changed' && primerHref !== undefined && (
        <Link
          href={primerHref}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline md:min-h-0"
        >
          View diff
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      )}
    </section>
  );
}

/** First version: per-zone totals and the full list collapsed. */
function InitialVersionView({
  diff,
  catalog,
  deckId,
  primerHref,
}: {
  diff: DeckDiff;
  catalog: Record<CardKey, CardFacts>;
  deckId: string;
  primerHref: Route | undefined;
}) {
  const byZone = new Map<ZoneId, AddedChange[]>();
  for (const change of diff.changes) {
    if (change.type !== 'added') continue;
    const list = byZone.get(change.zone) ?? [];
    list.push(change);
    byZone.set(change.zone, list);
  }
  const zones = sortZones(byZone.keys());
  const count = (zone: ZoneId): number =>
    (byZone.get(zone) ?? []).reduce((sum, change) => sum + change.quantity, 0);
  const total = zones.reduce((sum, zone) => sum + count(zone), 0);

  return (
    <div className="flex flex-col gap-4">
      <ul aria-label="Cards per zone" className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {zones.map((zone) => (
          <li key={zone} className="rounded-lg border border-border bg-surface-2/60 px-3 py-2">
            <p className={clsx('text-xs font-semibold tracking-wide uppercase', zoneTextClass(zone))}>
              {zoneLabel(zone)}
            </p>
            <p className="mt-0.5 text-lg font-semibold text-fg tabular">{count(zone)}</p>
          </li>
        ))}
      </ul>
      {diff.primer.status === 'changed' && (
        <MetaList aria-label="Primer" className="text-sm text-muted">
          <MetaItem>Primer</MetaItem>
          <MetaItem>{pluralize(diff.primer.addedLines, 'line')}</MetaItem>
          {primerHref !== undefined && (
            <MetaItem>
              <Link href={primerHref} className="font-medium text-accent hover:underline">
                Read primer
              </Link>
            </MetaItem>
          )}
        </MetaList>
      )}
      {diff.primer.status === 'unknown' && <p className="text-sm text-muted">Primer not captured</p>}
      <Disclosure summary={`Show all ${pluralize(total, 'card')}`} variant="card">
        <div className="flex flex-col gap-4">
          {zones.map((zone) => (
            <section key={zone} aria-label={zoneLabel(zone)}>
              <Overline className={clsx('mb-1', zoneTextClass(zone))}>
                {zoneLabel(zone)}
                <span className="ml-1.5 font-medium text-subtle normal-case tabular">{count(zone)}</span>
              </Overline>
              <ul className="divide-y divide-border">
                {(byZone.get(zone) ?? []).map((change) => {
                  const facts = catalog[change.key];
                  return (
                    <li key={change.key} className="flex items-center gap-3 py-1.5 text-sm">
                      <span className="w-6 shrink-0 text-right text-muted tabular">{change.quantity}</span>
                      <CardName
                        name={change.name}
                        scryfallId={facts?.scryfallId}
                        href={routes.card(deckId, change.key)}
                        className="min-w-0 flex-1 text-fg"
                      />
                      {facts !== undefined && <ManaCost cost={facts.manaCost} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}
