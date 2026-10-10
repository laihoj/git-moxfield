import type { Metadata } from 'next';

import { CARD_RESULT_LIMIT, CardsContent, cardQuery } from '@/components/deck-pages/cards-content';
import { sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';

import { findSharedOverview, loadSharedDeck, sharedPageMetadata } from '../data';
import { SharedPageMissing } from '../page-missing';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps<'/s/[token]/cards'>): Promise<Metadata> {
  const { token } = await params;
  return sharedPageMetadata(token, async () => {
    const overview = await findSharedOverview(token);
    return { title: overview === null ? 'Cards' : `Cards · ${sharedDeckTitle(overview)}` };
  });
}

/** Search every card of a shared deck's versions; each result links to its card history. */
export default async function SharedCardsPage({ params, searchParams }: PageProps<'/s/[token]/cards'>) {
  const { token } = await params;
  const query = cardQuery((await searchParams).q);
  const access = await loadSharedDeck(token);
  const overview = access === null ? null : await findSharedOverview(token);
  if (access === null || overview === null) return <SharedPageMissing access={access} />;
  const results =
    query === '' || overview.versionCount === 0
      ? []
      : await access.services.searchCards(query, CARD_RESULT_LIMIT);

  return (
    <CardsContent
      scope={sharedDeckRoutes(token).scope}
      query={query}
      versionCount={overview.versionCount}
      results={results}
    />
  );
}
