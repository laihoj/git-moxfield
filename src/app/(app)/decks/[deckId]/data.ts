/**
 * Request-scoped data loaders for the deck pages. `cache` deduplicates calls within
 * one server render, so the deck layout and the status page share one overview.
 */
import 'server-only';

import type { Metadata } from 'next';
import { cache } from 'react';

import { decodeSegment } from '@/app/route-segments';
import { deckPageTitle, deckTitle } from '@/lib/presentation';
import { routes } from '@/lib/routes';
import { servicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';
import type { DeckServices } from '@/server/services';

/**
 * Deck services of the signed-in user (owner scope); redirects to sign-in, and back to
 * the deck, when signed out. Decks of other users are not found.
 */
export async function deckServices(deckId: string): Promise<DeckServices> {
  return servicesFor(await requireUser({ next: routes.deck(deckId) }));
}

/** The deck overview (status, HEAD → working diff, recent versions), or `null` for an unknown deck. */
export const loadOverview = cache(async (deckId: string) => (await deckServices(deckId)).getOverview(deckId));

/** Every tag used in the deck, with counts. */
export const loadTags = cache(async (deckId: string) => (await deckServices(deckId)).listTags(deckId));

/** The `generateMetadata` of a section page of the owner's deck: `Cards · Blue Farm`. */
export function ownerSectionMetadata(section: string) {
  return async ({ params }: { params: Promise<{ deckId: string }> }): Promise<Metadata> => {
    const overview = await loadOverview(decodeSegment((await params).deckId));
    return { title: deckPageTitle(section, overview === null ? null : deckTitle(overview)) };
  };
}

export { decodeSegment, parseSequence } from '@/app/route-segments';
