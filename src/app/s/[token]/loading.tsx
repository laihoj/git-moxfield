import { DeckPageSkeleton } from '@/components/deck-pages/deck-page-skeleton';

/** Placeholder for a shared deck page while it loads (the deck header and tabs stay visible). */
export default function SharedDeckLoading() {
  return <DeckPageSkeleton />;
}
