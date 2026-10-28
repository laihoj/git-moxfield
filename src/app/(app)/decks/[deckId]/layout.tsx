import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DeckHeader } from '@/components/deck/deck-header';
import { DeckNav } from '@/components/deck/deck-nav';
import { DeckViewToggle } from '@/components/deck/deck-view-toggle';
import { ShareDeckLink } from '@/components/deck/share-deck-link';
import { deckTitle, isUnnamedDeck } from '@/lib/presentation';
import { currentDeckView } from '@/server/deck-view';

import { decodeSegment, loadOverview } from './data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: LayoutProps<'/decks/[deckId]'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Deck not found' : deckTitle(overview) };
}

/**
 * Deck chrome shared by every deck page of its owner: header (with Share), Status ·
 * History · Compare · Cards navigation and the deck view toggle (MTG · cEDH). Share link
 * viewers get the same chrome, read-only (`src/app/s/[token]/layout.tsx`).
 */
export default async function DeckLayout({ params, children }: LayoutProps<'/decks/[deckId]'>) {
  const deckId = decodeSegment((await params).deckId);
  const [overview, view] = await Promise.all([loadOverview(deckId), currentDeckView()]);
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
          actions={<ShareDeckLink deckId={overview.id} />}
        />
        <DeckNav scope={{ kind: 'owner', deckId: overview.id }} trailing={<DeckViewToggle view={view} />} />
      </div>
      {children}
    </div>
  );
}
