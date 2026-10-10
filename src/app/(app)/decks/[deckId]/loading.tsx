import { DeckPageSkeleton } from '@/components/deck-pages/deck-page-skeleton';

/** Placeholder for deck page content while it loads (the deck header and tabs stay visible). */
export default function DeckLoading() {
  return <DeckPageSkeleton />;
}
