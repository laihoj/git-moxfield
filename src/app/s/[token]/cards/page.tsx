import {
  CARD_RESULT_LIMIT,
  CardsContent,
  cardQuery,
  cardResults,
} from '@/components/deck-pages/cards-content';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck, sharedSectionMetadata } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

export const generateMetadata = sharedSectionMetadata('Cards');

/** Search every card of a shared deck's versions; each result links to its card history. */
export default async function SharedCardsPage({ params, searchParams }: PageProps<'/s/[token]/cards'>) {
  const { token } = await params;
  const query = cardQuery((await searchParams).q);
  const access = await loadSharedDeck(token);
  const overview = access === null ? null : await findSharedOverview(token);
  if (access === null || overview === null) return <SharedPageMissing access={access} />;
  const results = await cardResults(query, overview.versionCount, (text) =>
    access.services.searchCards(text, CARD_RESULT_LIMIT),
  );

  return (
    <CardsContent
      scope={sharedDeckRoutes(token).scope}
      query={query}
      versionCount={overview.versionCount}
      results={results}
    />
  );
}
