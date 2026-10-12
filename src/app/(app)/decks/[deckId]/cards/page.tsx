import { notFound } from 'next/navigation';

import { CARD_RESULT_LIMIT, CardsContent, cardQuery } from '@/components/deck-pages/cards-content';

import { deckServices, decodeSegment, loadOverview, ownerSectionMetadata } from '../data';

export const dynamic = 'force-dynamic';

export const generateMetadata = ownerSectionMetadata('Cards');

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
