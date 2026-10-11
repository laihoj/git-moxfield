import clsx from 'clsx';

import type { CardFacts, CardKey } from '@/core/model';
import { deckRoutes, type DeckScope } from '@/lib/routes';

import { CardName } from './card-name';
import { ManaCost } from './mana-cost';

export interface CardRowsProps {
  cards: readonly { key: CardKey; name: string; quantity: number }[];
  catalog: Record<CardKey, CardFacts>;
  /** The deck pages the card names link within (the owner's or a share link's). */
  scope: DeckScope;
  /** Looser rows with a rule between them (a version's collapsed card list). */
  divided?: boolean;
}

/** Cards as rows: quantity, name (linked to the card's history, with a preview) and mana cost. */
export function CardRows({ cards, catalog, scope, divided = false }: CardRowsProps) {
  const routes = deckRoutes(scope);
  return (
    <ul className={clsx(divided && 'divide-y divide-border')}>
      {cards.map((card) => {
        const facts = catalog[card.key];
        return (
          <li
            key={card.key}
            className={clsx('flex items-center text-sm', divided ? 'gap-3 py-1.5' : 'min-h-8 gap-2.5 py-0.5')}
          >
            <span className={clsx('shrink-0 text-right text-muted tabular', divided ? 'w-6' : 'w-5')}>
              {card.quantity}
            </span>
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
