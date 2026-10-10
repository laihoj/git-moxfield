import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CARD_RESULT_LIMIT, CardsContent, cardQuery } from '@/components/deck-pages/cards-content';
import { deckTitle } from '@/lib/presentation';

import { deckServices, decodeSegment, loadOverview } from '../data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/decks/[deckId]/cards'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Cards' : `Cards · ${deckTitle(overview)}` };
}

/** Search every card that was ever in the deck; each result links to its card history. */
export default async function CardsPage({ params, searchParams }: PageProps<'/decks/[deckId]/cards'>) {
  const deckId = decodeSegment((await params).deckId);
  const query = cardQuery((await searchParams).q);
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();

  const results =
    query === '' || overview.versionCount === 0
      ? []
      : await (await deckServices(deckId)).searchCards(deckId, query, CARD_RESULT_LIMIT);

  return (
    <CardsContent
      scope={{ kind: 'owner', deckId: overview.id }}
      query={query}
      versionCount={overview.versionCount}
      results={results}
    />
  );
}
