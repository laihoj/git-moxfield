import clsx from 'clsx';

import { snapshotZones, zoneCards, zoneCount } from '@/core/canonical';
import type { CanonicalCard, CanonicalSnapshot, CardFacts, CardKey } from '@/core/model';
import { zoneLabel, type ZoneId } from '@/core/zones';
import { deckRoutes, type DeckScope } from '@/lib/routes';

import { CardName } from './card-name';
import { ManaCost } from './mana-cost';
import { zoneTextClass } from './zone-badge';

/** Type groups in Moxfield's order. Cards whose primary type is none of these go to "Other". */
const TYPE_ORDER = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
] as const;

const TYPE_PLURALS: Record<string, string> = {
  Creature: 'Creatures',
  Planeswalker: 'Planeswalkers',
  Battle: 'Battles',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other',
};

/** Zones listed flat (few cards, no grouping): the command zone. */
const FLAT_ZONES: ReadonlySet<ZoneId> = new Set(['commanders', 'companions', 'signatureSpells']);

interface TypeGroup {
  type: string;
  cards: CanonicalCard[];
  count: number;
}

/** Groups cards by primary type in Moxfield order; unknown types last as "Other". */
export function groupByType(
  cards: readonly CanonicalCard[],
  catalog: Record<CardKey, CardFacts>,
): TypeGroup[] {
  const groups = new Map<string, CanonicalCard[]>();
  for (const card of cards) {
    const primary = catalog[card.key]?.primaryType ?? 'Other';
    const type = (TYPE_ORDER as readonly string[]).includes(primary) ? primary : 'Other';
    const list = groups.get(type) ?? [];
    list.push(card);
    groups.set(type, list);
  }
  return [...TYPE_ORDER, 'Other']
    .filter((type) => groups.has(type))
    .map((type) => {
      const list = groups.get(type) ?? [];
      return { type, cards: list, count: list.reduce((sum, card) => sum + card.quantity, 0) };
    });
}

export interface DeckListProps {
  snapshot: CanonicalSnapshot;
  catalog: Record<CardKey, CardFacts>;
  /** The deck pages card names link within (the owner's or a share link's). */
  scope: DeckScope;
}

/**
 * The full deck of a version, by zone. The command zone is listed flat; other zones
 * are grouped by card type in Moxfield's order, in two columns on wide screens.
 */
export function DeckList({ snapshot, catalog, scope }: DeckListProps) {
  const zones = snapshotZones(snapshot);
  if (zones.length === 0) return <p className="text-sm text-muted">This version has no cards.</p>;
  return (
    <div className="flex flex-col gap-6">
      {zones.map((zone) => {
        const cards = zoneCards(snapshot, zone);
        const headingId = `deck-zone-${zone.replace(/[^a-z0-9-]/gi, '-')}`;
        return (
          <section key={zone} aria-labelledby={headingId}>
            <h3
              id={headingId}
              className={clsx(
                'mb-2 flex items-baseline gap-2 border-b border-border pb-1.5 text-sm font-semibold tracking-wide uppercase',
                zoneTextClass(zone),
              )}
            >
              {zoneLabel(zone)}
              <span className="font-medium text-subtle tabular">{zoneCount(snapshot, zone)}</span>
            </h3>
            {FLAT_ZONES.has(zone) ? (
              <CardRows cards={cards} catalog={catalog} scope={scope} />
            ) : (
              <div className="gap-x-8 md:columns-2">
                {groupByType(cards, catalog).map((group) => (
                  <div key={group.type} className="mb-4 break-inside-avoid">
                    <h4 className="mb-0.5 flex items-baseline gap-1.5 text-xs font-semibold text-muted">
                      {TYPE_PLURALS[group.type] ?? group.type}
                      <span className="font-medium text-subtle tabular">{group.count}</span>
                    </h4>
                    <CardRows cards={group.cards} catalog={catalog} scope={scope} />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CardRows({
  cards,
  catalog,
  scope,
}: {
  cards: readonly CanonicalCard[];
  catalog: Record<CardKey, CardFacts>;
  scope: DeckScope;
}) {
  const routes = deckRoutes(scope);
  return (
    <ul>
      {cards.map((card) => {
        const facts = catalog[card.key];
        return (
          <li key={card.key} className="flex min-h-8 items-center gap-2.5 py-0.5 text-sm">
            <span className="w-5 shrink-0 text-right text-muted tabular">{card.quantity}</span>
            <CardName
              name={card.name}
              scryfallId={facts?.scryfallId}
              href={routes.card(card.key)}
              className="min-w-0 flex-1 text-fg"
            />
            {facts !== undefined && <ManaCost cost={facts.manaCost} />}
          </li>
        );
      })}
    </ul>
  );
}
