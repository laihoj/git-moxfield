import { ChevronLeft } from 'lucide-react';

import { CardHistoryView, type CardHistoryViewProps } from '@/components/deck/card-history-view';
import { Link } from '@/components/ui/navigation';
import { deckRoutes } from '@/lib/routes';

/** The card key of a `[cardKey]` route segment (decoded), or `null` when it cannot be one. */
export function cardKeySegment(decoded: string): string | null {
  return decoded.trim() === '' || decoded.length > 300 ? null : decoded;
}

/** A card's page: back to Cards, then its history across the deck's versions. */
export function CardHistoryContent(props: CardHistoryViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <Link
        href={deckRoutes(props.scope).cards()}
        className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted hover:text-fg md:min-h-9"
      >
        <ChevronLeft aria-hidden="true" className="size-4" />
        Cards
      </Link>
      <CardHistoryView {...props} />
    </div>
  );
}
