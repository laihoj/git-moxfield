import { CardHistoryView, type CardHistoryViewProps } from '@/components/deck/card-history-view';
import { deckRoutes } from '@/lib/routes';
import { BackLink } from '@/components/ui/back-link';

/** The card key of a `[cardKey]` route segment (decoded), or `null` when it cannot be one. */
export function cardKeySegment(decoded: string): string | null {
  return decoded.trim() === '' || decoded.length > 300 ? null : decoded;
}

/** A card's page: back to Cards, then its history across the deck's versions. */
export function CardHistoryContent(props: CardHistoryViewProps) {
  return (
    <div className="flex flex-col gap-4">
      <BackLink href={deckRoutes(props.scope).cards()}>Cards</BackLink>
      <CardHistoryView {...props} />
    </div>
  );
}
