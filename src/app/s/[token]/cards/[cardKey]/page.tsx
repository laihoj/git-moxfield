import type { Metadata } from 'next';
import { cache } from 'react';

import { CardHistoryContent, cardKeySegment } from '@/components/deck-pages/card-history-content';
import { decodeSegment } from '@/app/route-segments';
import { sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';

import { loadSharedDeck, sharedPageMetadata } from '../../data';
import { SharedPageMissing } from '../../page-missing';

export const dynamic = 'force-dynamic';

/** The card's history, once per request (metadata and page); `null` when not found. */
const loadCard = cache(async (token: string, rawCardKey: string) => {
  const key = cardKeySegment(decodeSegment(rawCardKey));
  const access = key === null ? null : await loadSharedDeck(token);
  return access === null || key === null ? null : access.services.cardHistory(key);
});

export async function generateMetadata({
  params,
}: PageProps<'/s/[token]/cards/[cardKey]'>): Promise<Metadata> {
  const { token, cardKey } = await params;
  return sharedPageMetadata(token, async () => {
    const card = await loadCard(token, cardKey);
    return {
      title: card === null ? 'Card not found' : `${card.history.name} · ${sharedDeckTitle(card.deck)}`,
    };
  });
}

/** History of one card across a shared deck's committed versions. */
export default async function SharedCardHistoryPage({
  params,
  searchParams,
}: PageProps<'/s/[token]/cards/[cardKey]'>) {
  const { token, cardKey } = await params;
  const card = await loadCard(token, cardKey);
  if (card === null) return <SharedPageMissing access={await loadSharedDeck(token)} />;
  const { all } = await searchParams;

  return (
    <CardHistoryContent
      scope={sharedDeckRoutes(token).scope}
      history={card.history}
      facts={card.facts}
      showAll={all === '1'}
    />
  );
}
