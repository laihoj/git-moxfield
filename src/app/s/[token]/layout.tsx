import type { Metadata } from 'next';

import { SiteChrome } from '@/components/app/site-chrome';
import { DeckHeader } from '@/components/deck/deck-header';
import { DeckNav } from '@/components/deck/deck-nav';
import { ReadOnlyBanner } from '@/components/deck/read-only-banner';
import { sharedDeckTitle } from '@/lib/presentation';
import { sharedDeckRoutes } from '@/lib/routes';

import { SHARED_PAGE_METADATA } from '../shared-metadata';
import { findSharedOverview, loadSharedOverview, requireSharedDeck } from './data';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: LayoutProps<'/s/[token]'>): Promise<Metadata> {
  const overview = await findSharedOverview((await params).token);
  return {
    ...SHARED_PAGE_METADATA,
    // A link that grants nothing renders `../not-found.tsx` under this title.
    title: overview === null ? 'Link not available' : sharedDeckTitle(overview),
  };
}

/**
 * Every page of a share link (ADR 0007): a minimal frame (the wordmark leads to the
 * shared deck, there is no account menu), the read-only banner, and the same deck header
 * and navigation the owner has, without the owner's controls and without the link to the
 * deck on Moxfield (which would show its live, uncommitted state, and outlive the link).
 * Works signed out: the token is the authorization and no session is looked at. A link
 * that grants nothing answers 404 with `../not-found.tsx`.
 */
export default async function SharedDeckLayout({ params, children }: LayoutProps<'/s/[token]'>) {
  const { token } = await params;
  const { share } = await requireSharedDeck(token);
  const overview = await loadSharedOverview(token);
  const routes = sharedDeckRoutes(token);

  return (
    <SiteChrome homeHref={routes.overview()} banner={<ReadOnlyBanner ownerName={share.ownerDisplayName} />}>
      <div className="flex flex-col gap-5 md:gap-6">
        <div className="flex flex-col gap-3 md:gap-4">
          <DeckHeader
            name={sharedDeckTitle(overview)}
            commanders={overview.commanders}
            format={overview.format}
          />
          <DeckNav scope={routes.scope} />
        </div>
        {children}
      </div>
    </SiteChrome>
  );
}
