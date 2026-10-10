import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CardHistoryView } from '@/components/deck/card-history-view';
import { routes } from '@/lib/routes';
import { deckServices, decodeSegment } from '../../data';

export const dynamic = 'force-dynamic';

async function loadHistory(params: PageProps<'/decks/[deckId]/cards/[cardKey]'>['params']) {
  const { deckId, cardKey } = await params;
  const key = decodeSegment(cardKey);
  if (key.trim() === '' || key.length > 300) return null;
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
    <div className="flex flex-col gap-4">
      <Link
        href={routes.cards(card.deck.id)}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Cards
      </Link>
      <CardHistoryView
        deckId={card.deck.id}
        history={card.history}
        facts={card.facts}
        showAll={all === '1'}
      />
    </div>
  );
}
