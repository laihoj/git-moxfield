import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DeckHeader } from '@/components/deck/deck-header';
import { DeckNav } from '@/components/deck/deck-nav';
import { deckTitle, isUnnamedDeck } from '@/lib/presentation';

import { decodeSegment, loadOverview } from './data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: LayoutProps<'/decks/[deckId]'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Deck not found' : deckTitle(overview) };
}

/** Deck chrome shared by every deck page: header and Status · History · Compare · Cards navigation. */
export default async function DeckLayout({ params, children }: LayoutProps<'/decks/[deckId]'>) {
  const deckId = decodeSegment((await params).deckId);
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();

  return (
    <div className="flex flex-col gap-5 md:gap-6">
      <div className="flex flex-col gap-3 md:gap-4">
        <DeckHeader
          name={deckTitle(overview)}
          unnamedId={isUnnamedDeck(overview) ? overview.externalId : undefined}
          commanders={overview.commanders}
          format={overview.format}
          url={overview.url}
        />
        <DeckNav deckId={overview.id} />
      </div>
      {children}
    </div>
  );
}
