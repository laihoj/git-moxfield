import clsx from 'clsx';
import type { Route } from 'next';
import type { ReactNode } from 'react';

import { DEFAULT_DECK_VIEW, type DeckView } from '@/core/deck-view';
import type { CanonicalPrinting, CardFacts, CardKey } from '@/core/model';
import type { CardChange } from '@/core/diff/types';
import { zoneLabel } from '@/core/zones';
import { MINUS_SIGN } from '@/lib/format';
import { deckRoutes, type DeckScope } from '@/lib/routes';

import { BADGE_TONE_CLASSES, type BadgeTone } from '@/components/ui/badge';

import { CardName } from './card-name';
import { ManaCost } from './mana-cost';
import { ZoneBadge } from './zone-badge';

type GlyphTone = Extract<BadgeTone, 'add' | 'remove' | 'move' | 'cosmetic'>;

/**
 * Glyph, tone and spoken meaning of a change (meaning is never carried by color alone).
 * In the cEDH view, copies that enter or leave a zone are what to add to and cut from the
 * sleeved deck, and are spoken so.
 */
function glyphOf(change: CardChange, view: DeckView): { glyph: string; tone: GlyphTone; meaning: string } {
  const sleeving = view === 'cedh';
  switch (change.type) {
    case 'added':
      return { glyph: '+', tone: 'add', meaning: sleeving ? 'Add' : 'Added' };
    case 'removed':
      return { glyph: MINUS_SIGN, tone: 'remove', meaning: sleeving ? 'Cut' : 'Removed' };
    case 'moved':
      return {
        glyph: '⇄',
        tone: 'move',
        meaning: `Moved from ${zoneLabel(change.from)} to ${zoneLabel(change.to)}`,
      };
    case 'quantity': {
      const more = change.to > change.from;
      return {
        glyph: '±',
        tone: more ? 'add' : 'remove',
        meaning: sleeving ? (more ? 'Add copies' : 'Cut copies') : more ? 'More copies' : 'Fewer copies',
      };
    }
    case 'printing':
      return { glyph: '~', tone: 'cosmetic', meaning: 'Printing changed' };
    case 'tags':
      return { glyph: '#', tone: 'cosmetic', meaning: 'Card tags changed' };
    case 'renamed':
      return { glyph: '~', tone: 'cosmetic', meaning: 'Renamed' };
  }
}

/** The change glyph in a small tinted square (`+` `−` `⇄` `±`). */
export function ChangeGlyph({ glyph, tone }: { glyph: string; tone: GlyphTone }) {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'flex size-5 shrink-0 items-center justify-center rounded-md text-[0.8125rem] leading-none font-semibold',
        BADGE_TONE_CLASSES[tone],
      )}
    >
      {glyph}
    </span>
  );
}

/** `CMM 703 foil` — compact printing description for printing-change rows. */
export function printingLabel(printing: CanonicalPrinting): string {
  const parts = [`${printing.set.toUpperCase()} ${printing.collectorNumber}`];
  if (printing.finish !== 'nonfoil') parts.push(printing.finish);
  if (printing.lang !== 'en') parts.push(printing.lang.toUpperCase());
  for (const flag of printing.flags ?? []) parts.push(flag);
  const label = parts.join(' ');
  return printing.quantity > 1 ? `${printing.quantity}× ${label}` : label;
}

function printingsText(printings: readonly CanonicalPrinting[]): string {
  return printings.length === 0 ? 'no printing' : printings.map(printingLabel).join(', ');
}

/** Detail text shown after the card name (`3 → 4`, printings, tags, old name). */
function changeDetail(change: CardChange): ReactNode {
  switch (change.type) {
    case 'quantity':
      return (
        <span className="text-muted tabular">
          {change.from} → {change.to}
        </span>
      );
    case 'printing':
      return (
        <span className="text-muted">
          {printingsText(change.before)} → {printingsText(change.after)}
        </span>
      );
    case 'tags':
      return (
        <span className="text-muted">
          {[
            ...change.added.map((tag) => `+${tag}`),
            ...change.removed.map((tag) => `${MINUS_SIGN}${tag}`),
          ].join(' ')}
        </span>
      );
    case 'renamed':
      return <span className="text-muted">was {change.previousName}</span>;
    default:
      return null;
  }
}

/** Copies shown before the name; omitted when it is 1 (docs/ux.md row anatomy). */
function changeQuantity(change: CardChange): number | null {
  switch (change.type) {
    case 'added':
    case 'removed':
    case 'moved':
      return change.quantity > 1 ? change.quantity : null;
    default:
      return null;
  }
}

export interface DiffRowProps {
  change: CardChange;
  catalog: Record<CardKey, CardFacts>;
  /** The deck pages the card name links within (the owner's or a share link's). */
  scope: DeckScope;
  /** Show the zone badge for zone-scoped changes (used where the section is not a zone, e.g. Commanders). */
  showZone?: boolean;
  /** The deck view: the cEDH view speaks additions and removals as adds and cuts. */
  view?: DeckView;
}

/**
 * One change: glyph, quantity (when not 1), card name (linked to its card history),
 * detail, mana cost and, for moves, `from → to` zone badges. On small screens the
 * zone badges wrap below the name.
 */
export function DiffRow({
  change,
  catalog,
  scope,
  showZone = false,
  view = DEFAULT_DECK_VIEW,
}: DiffRowProps) {
  const { glyph, tone, meaning } = glyphOf(change, view);
  const facts = catalog[change.key];
  const quantity = changeQuantity(change);
  const detail = changeDetail(change);
  const href: Route = deckRoutes(scope).card(change.key);

  let zones: ReactNode = null;
  if (change.type === 'moved') {
    zones = (
      // Spoken via the row's "Moved from … to …" prefix; the badges are visual only.
      <span aria-hidden="true" className="flex flex-wrap items-center gap-1 text-xs text-muted">
        <ZoneBadge zone={change.from} /> <span>→</span> <ZoneBadge zone={change.to} />
      </span>
    );
  } else if (showZone && 'zone' in change) {
    zones = <ZoneBadge zone={change.zone} />;
  }

  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2 md:grid-cols-[auto_minmax(0,1fr)_auto_auto] md:items-center">
      <span className="pt-px md:pt-0">
        <ChangeGlyph glyph={glyph} tone={tone} />
      </span>
      <span className="min-w-0 text-sm leading-5">
        <span className="sr-only">{meaning}: </span>
        {quantity !== null && <span className="mr-1 font-medium text-muted tabular">{quantity}×</span>}
        <CardName
          name={change.name}
          scryfallId={facts?.scryfallId}
          href={href}
          className="font-medium text-fg"
        />
        {detail !== null && (
          <>
            {' '}
            <span className="ml-1 text-[0.8125rem]">{detail}</span>
          </>
        )}
      </span>
      {zones !== null && (
        <span className="col-start-2 row-start-2 md:col-start-3 md:row-start-1 md:justify-self-end">
          {zones}
        </span>
      )}
      <span className="col-start-3 row-start-1 flex min-h-5 items-center justify-end md:col-start-4">
        {facts !== undefined && <ManaCost cost={facts.manaCost} />}
      </span>
    </li>
  );
}
