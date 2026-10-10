'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { DeckPageSkeleton } from '@/components/deck-pages/deck-page-skeleton';

/**
 * What a page below a share link renders when the link stopped granting anything
 * (revoked, deck untracked, owner disabled) since the browser loaded the deck's frame.
 *
 * Navigating inside the link re-renders only the page, not the layout that checks the
 * link (`./layout.tsx`), so the page alone cannot replace the frame (the deck's name,
 * its owner) with the "This link doesn't work anymore" page. This re-renders the whole
 * route instead: the layout then answers 404 like for any link that grants nothing, so a
 * revoked link looks exactly like one that never worked. Shows the loading placeholder
 * meanwhile, never the deck or a misleading "not found". On a full page load the layout
 * answers 404 first and this is never shown.
 */
export function SharedLinkGone() {
  const router = useRouter();
  const refreshed = useRef(false);
  useEffect(() => {
    // Once per mount (Strict Mode runs effects twice in development).
    if (refreshed.current) return;
    refreshed.current = true;
    router.refresh();
  }, [router]);
  return <DeckPageSkeleton />;
}
