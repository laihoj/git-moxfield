import { Link2Off } from 'lucide-react';
import type { Metadata } from 'next';

import { SiteChrome } from '@/components/app/site-chrome';
import { EmptyState } from '@/components/ui/empty-state';

import { SHARED_PAGE_METADATA } from './shared-metadata';

export const metadata: Metadata = { ...SHARED_PAGE_METADATA, title: 'Link not available' };

/**
 * A share link that grants nothing (ADR 0007): mistyped or cut off, revoked, its deck
 * untracked or its owner disabled. Every case gets exactly this page and a 404, so a
 * revoked link reveals nothing a mistyped one does not. The frame has no way into the
 * app: whoever holds the link may have no account.
 */
export default function SharedLinkNotFound() {
  return (
    <SiteChrome>
      <EmptyState
        className="mx-auto mt-6 max-w-xl"
        headingLevel={1}
        icon={<Link2Off aria-hidden="true" />}
        title="This link doesn’t work anymore"
        description="Whoever shared the deck may have stopped sharing it, or the link was not copied completely. Ask them for a new link."
      />
    </SiteChrome>
  );
}
