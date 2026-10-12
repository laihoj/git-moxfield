import type { Metadata } from 'next';

import { InviteForm } from '@/components/admin/invite-form';
import { InviteList } from '@/components/admin/invite-list';
import { PeopleList } from '@/components/admin/people-list';
import { RecoveryLinkList } from '@/components/admin/recovery-link-list';
import { ServerFetchCard } from '@/components/admin/server-fetch-card';
import { Card, CardHeader, ListCard } from '@/components/ui/card';
import { formatDuration, pluralize } from '@/lib/format';
import { routes } from '@/lib/routes';
import { getServerFetchAdminInfo } from '@/server/access';
import { getAuthService, INVITE_LIFETIME_MS } from '@/server/auth';
import { requireAdmin } from '@/server/auth/current-user';
import { PageHeader } from '@/components/ui/page-header';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Admin' };

/**
 * Admin (ADR 0006): invite people, help them back in with recovery links (and see and
 * withdraw the ones that can still be used), disable and enable accounts, and see and
 * resume server fetching from Moxfield (ADR 0009). Members get a 404, as if the page did
 * not exist. Admins manage accounts, not decks: nobody's decks
 * are reachable from here.
 */
export default async function AdminPage() {
  const admin = await requireAdmin({ next: routes.admin() });
  const auth = await getAuthService();
  const [people, invites, recoveryLinks, serverFetch] = await Promise.all([
    auth.listUsers(admin),
    auth.listInvites(admin),
    auth.listRecoveryLinks(admin),
    getServerFetchAdminInfo(),
  ]);
  const pending = invites.filter((invite) => invite.status === 'pending').length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <PageHeader
        title="Admin"
        description="Invite people and help them back in. Admins manage accounts, not decks. A recovery link signs in as the person it is for and signs out their other devices, so give it only to them."
      />

      <Card as="section" aria-labelledby="invite-heading" className="flex flex-col gap-4">
        <CardHeader
          id="invite-heading"
          title="Invite someone"
          description={`Make a one-time link that creates an account. It works for ${formatDuration(INVITE_LIFETIME_MS)}.`}
        />
        <InviteForm />
      </Card>

      <ListCard headingId="people-heading" title="People" description={pluralize(people.length, 'account')}>
        <PeopleList
          people={people}
          currentUserId={admin.id}
          withPendingRecovery={recoveryLinks.map((link) => link.user.id)}
        />
      </ListCard>

      {recoveryLinks.length > 0 && (
        <ListCard
          headingId="recovery-links-heading"
          title="Recovery links"
          description="Links that can still sign someone in. Withdraw any that should no longer work."
        >
          <RecoveryLinkList links={recoveryLinks} />
        </ListCard>
      )}

      <ListCard
        headingId="invites-heading"
        title="Invites"
        description={invites.length === 0 ? undefined : `${pending} pending · ${invites.length} in total`}
      >
        <InviteList invites={invites} />
      </ListCard>

      <ServerFetchCard info={serverFetch} />
    </div>
  );
}
