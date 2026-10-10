import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CardHistoryContent, cardKeySegment } from '@/components/deck-pages/card-history-content';

import { deckServices, decodeSegment } from '../../data';

export const dynamic = 'force-dynamic';

async function loadHistory(params: PageProps<'/decks/[deckId]/cards/[cardKey]'>['params']) {
  const { deckId, cardKey } = await params;
  const key = cardKeySegment(decodeSegment(cardKey));
  if (key === null) return null;
  const id = decodeSegment(deckId);
  return (await deckServices(id)).cardHistory(id, key, { includeWorking: true });
}

export async function generateMetadata({
  params,
}: PageProps<'/decks/[deckId]/cards/[cardKey]'>): Promise<Metadata> {
  const card = await loadHistory(params);
  return { title: card === null ? 'Card not found' : `${card.history.name} · ${card.deck.name}` };
}

/** History of one card across the deck's versions and the current Moxfield deck. */
export default async function CardHistoryPage({
  params,
  searchParams,
}: PageProps<'/decks/[deckId]/cards/[cardKey]'>) {
  const card = await loadHistory(params);
  if (card === null) notFound();
  const { all } = await searchParams;

  return (
    <CardHistoryContent
      scope={{ kind: 'owner', deckId: card.deck.id }}
      history={card.history}
      facts={card.facts}
      showAll={all === '1'}
    />
  );
}
