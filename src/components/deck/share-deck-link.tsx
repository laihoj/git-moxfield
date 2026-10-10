'use client';

import clsx from 'clsx';
import { Share2 } from 'lucide-react';
import { useSelectedLayoutSegment } from 'next/navigation';

import { Link } from '@/components/ui/navigation';
import { routes } from '@/lib/routes';

import { DECK_HEADER_LINK } from './deck-header';

/**
 * The owner's way to a deck's share links (ADR 0007), in the deck header; highlighted
 * while that page is open. Rendered by the owner's deck layout only.
 */
export function ShareDeckLink({ deckId }: { deckId: string }) {
  const current = useSelectedLayoutSegment() === 'share';
  return (
    <Link
      href={routes.deckShare(deckId)}
      aria-current={current ? 'page' : undefined}
      className={clsx(
        DECK_HEADER_LINK,
        current ? 'bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent' : 'text-muted',
      )}
    >
      <Share2 aria-hidden="true" className="size-4" />
      Share
    </Link>
  );
}
