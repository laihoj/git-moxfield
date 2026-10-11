import { notFound } from 'next/navigation';

import { CreateShareLink } from '@/components/share/create-share-link';
import { ShareLinkExplainer } from '@/components/share/share-link-explainer';
import { ShareLinkList } from '@/components/share/share-link-list';
import { Card, CardHeader, ListCard } from '@/components/ui/card';
import { SidebarLayout } from '@/components/ui/sidebar-layout';
import { routes } from '@/lib/routes';
import { shareLinkServicesFor } from '@/server/access';
import { requireUser } from '@/server/auth/current-user';

import { decodeSegment, loadOverview, ownerSectionMetadata } from '../data';

export const dynamic = 'force-dynamic';

export const generateMetadata = ownerSectionMetadata('Share');

/**
 * Share a deck (ADR 0007): create read-only links for people (no account needed), see
 * the deck's links with when they were last viewed, and revoke them. A new link's URL is
 * shown once, by the component that created it; this page never sees it.
 */
export default async function SharePage({ params }: PageProps<'/decks/[deckId]/share'>) {
  const deckId = decodeSegment((await params).deckId);
  const user = await requireUser({ next: routes.deckShare(deckId) });
  const [overview, links] = await Promise.all([
    loadOverview(deckId),
    shareLinkServicesFor(user).then((shareLinks) => shareLinks.listShareLinks(deckId)),
  ]);
  if (overview === null) notFound();

  return (
    // One column on phones (create, what viewers see, the links); the explanation moves
    // to a sidebar from `lg` up.
    <SidebarLayout>
      <Card as="section" aria-labelledby="new-link-heading" className="flex flex-col gap-4 lg:col-start-1">
        <CardHeader
          id="new-link-heading"
          title="Share this deck"
          description="Create a read-only link to its versions for a friend or your playgroup. They don’t need an account."
        />
        <CreateShareLink deckId={overview.id} />
      </Card>

      <div className="min-w-0 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <ShareLinkExplainer ownerName={user.displayName} />
      </div>

      <ListCard
        headingId="links-heading"
        title={links.length === 0 ? 'Links' : `Links (${links.length})`}
        description="Each link works until you revoke it. Revoking ends its access at once."
        className="lg:col-start-1"
      >
        <ShareLinkList deckId={overview.id} links={links} />
      </ListCard>
    </SidebarLayout>
  );
}
