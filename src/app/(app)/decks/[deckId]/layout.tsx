import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DeckFrame } from '@/components/deck/deck-frame';
import { DeckHeader } from '@/components/deck/deck-header';
import { DeckNav } from '@/components/deck/deck-nav';
import { ShareDeckLink } from '@/components/deck/share-deck-link';
import { deckTitle, isUnnamedDeck } from '@/lib/presentation';

import { decodeSegment, loadOverview } from './data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: LayoutProps<'/decks/[deckId]'>): Promise<Metadata> {
  const overview = await loadOverview(decodeSegment((await params).deckId));
  return { title: overview === null ? 'Deck not found' : deckTitle(overview) };
}

/**
 * Deck chrome shared by every deck page of its owner: header (with Share) and Status ·
 * History · Compare · Cards navigation. Share link viewers get the same chrome, read-only
 * (`src/app/s/[token]/layout.tsx`).
 */
export default async function DeckLayout({ params, children }: LayoutProps<'/decks/[deckId]'>) {
  const deckId = decodeSegment((await params).deckId);
  const overview = await loadOverview(deckId);
  if (overview === null) notFound();

  return (
    <DeckFrame
      header={
        <DeckHeader
          name={deckTitle(overview)}
          unnamedId={isUnnamedDeck(overview) ? overview.externalId : undefined}
          commanders={overview.commanders}
          format={overview.format}
          url={overview.url}
          actions={<ShareDeckLink deckId={overview.id} />}
        />
      }
      nav={<DeckNav scope={{ kind: 'owner', deckId: overview.id }} />}
    >
      {children}
    </DeckFrame>
  );
}
