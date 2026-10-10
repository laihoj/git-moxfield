import type { Metadata } from 'next';

import { InviteForm } from '@/components/admin/invite-form';
import { InviteList } from '@/components/admin/invite-list';
import { PeopleList } from '@/components/admin/people-list';
import { RecoveryLinkList } from '@/components/admin/recovery-link-list';
import { Card, CardHeader } from '@/components/ui/card';
import { pluralize } from '@/lib/format';
import { routes } from '@/lib/routes';
import { getAuthService, MAX_INVITE_NOTE_LENGTH } from '@/server/auth';
import { requireAdmin } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Admin' };

/**
 * Admin (ADR 0006): invite people, help them back in with recovery links (and see and
 * withdraw the ones that can still be used), disable and enable accounts. Members get a
 * 404, as if the page did not exist. Admins manage accounts, not decks: nobody's decks
 * are reachable from here.
 */
export default async function AdminPage() {
  const admin = await requireAdmin({ next: routes.admin() });
  const auth = getAuthService();
  const [people, invites, recoveryLinks] = await Promise.all([
    auth.listUsers(admin),
    auth.listInvites(admin),
    auth.listRecoveryLinks(admin),
  ]);
  const pending = invites.filter((invite) => invite.status === 'pending').length;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Admin</h1>
        <p className="mt-1 text-sm text-pretty text-muted">
          Invite people and help them back in. Admins manage accounts, not decks. A recovery link signs in as
          the person it is for and signs out their other devices, so give it only to them.
        </p>
      </div>

      <Card as="section" aria-labelledby="invite-heading" className="flex flex-col gap-4">
        <CardHeader
          id="invite-heading"
          title="Invite someone"
          description="Make a one-time link that creates an account. It works for 7 days."
        />
        <InviteForm maxNoteLength={MAX_INVITE_NOTE_LENGTH} />
      </Card>

      <Card as="section" flush aria-labelledby="people-heading">
        <CardHeader
          id="people-heading"
          title="People"
          description={pluralize(people.length, 'account')}
          className="border-b border-border p-4 md:p-5"
        />
        <PeopleList
          people={people}
          currentUserId={admin.id}
          withPendingRecovery={recoveryLinks.map((link) => link.user.id)}
        />
      </Card>

      {recoveryLinks.length > 0 && (
        <Card as="section" flush aria-labelledby="recovery-links-heading">
          <CardHeader
            id="recovery-links-heading"
            title="Recovery links"
            description="Links that can still sign someone in. Withdraw any that should no longer work."
            className="border-b border-border p-4 md:p-5"
          />
          <RecoveryLinkList links={recoveryLinks} />
        </Card>
      )}

      <Card as="section" flush aria-labelledby="invites-heading">
        <CardHeader
          id="invites-heading"
          title="Invites"
          description={invites.length === 0 ? undefined : `${pending} pending · ${invites.length} in total`}
          className="border-b border-border p-4 md:p-5"
        />
        <InviteList invites={invites} />
      </Card>
    </div>
  );
}
