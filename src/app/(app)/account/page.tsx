import { Plus } from 'lucide-react';
import type { Metadata } from 'next';

import { DeviceLinkPanel } from '@/components/account/device-link-panel';
import { DeviceList } from '@/components/account/device-list';
import { KeyList } from '@/components/account/key-list';
import { RecoveryHistory } from '@/components/account/recovery-history';
import { RenameForm } from '@/components/account/rename-form';
import { RevokedKeyShareLinks } from '@/components/account/revoked-key-share-links';
import { SignOutPanel } from '@/components/account/sign-out-panel';
import { Avatar } from '@/components/ui/avatar';
import { ButtonLink } from '@/components/ui/button';
import { RoleBadge } from '@/components/account/role-badge';
import { Card, CardHeader, ListCard } from '@/components/ui/card';
import { formatDuration } from '@/lib/format';
import { routes } from '@/lib/routes';
import { DEVICE_LINK_LIFETIME_MS, getAuthService } from '@/server/auth';
import { requireUser } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Account' };

/**
 * The signed-in user's account (ADR 0006): name, signing in another device, bookmarklets
 * (and the share links of revoked ones that still work, ADR 0007), signed-in devices,
 * recovery links that signed in as the user, and signing out. Everything here concerns
 * the user's own account only.
 */
export default async function AccountPage() {
  const user = await requireUser({ next: routes.account() });
  const auth = await getAuthService();
  const [keys, revokedKeyShareLinks, sessions, recoveries] = await Promise.all([
    auth.listKeys(user),
    auth.listRevokedKeyShareLinks(user),
    auth.listSessions(user),
    auth.listRecoveryUses(user),
  ]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex items-center gap-4">
        <Avatar name={user.displayName} size="lg" />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Account</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
            <span className="min-w-0 break-words">Signed in as {user.displayName}</span>
            <RoleBadge role={user.role} />
          </p>
        </div>
      </div>

      <Card as="section" aria-labelledby="profile-heading" className="flex flex-col gap-4">
        <CardHeader id="profile-heading" title="Profile" />
        <RenameForm displayName={user.displayName} />
      </Card>

      <Card as="section" aria-labelledby="device-link-heading" className="flex flex-col gap-4">
        <CardHeader
          id="device-link-heading"
          title="Sign in on another device"
          description={`Sign in on your phone or another computer without a bookmarklet: make a one-time link here and scan or open it there. It works once, for ${formatDuration(DEVICE_LINK_LIFETIME_MS)}.`}
        />
        <DeviceLinkPanel />
      </Card>

      <ListCard
        headingId="keys-heading"
        title="Bookmarklets"
        description="Each one is a personal key that sends decks from Moxfield and signs its browser in. Revoke any you no longer use or have lost."
        actions={
          keys.length > 0 ? (
            <ButtonLink
              href={routes.setup()}
              variant="secondary"
              size="sm"
              icon={<Plus aria-hidden="true" className="size-4" />}
            >
              New bookmarklet
            </ButtonLink>
          ) : undefined
        }
      >
        <KeyList keys={keys} />
      </ListCard>

      {revokedKeyShareLinks.length > 0 && (
        <ListCard
          headingId="revoked-key-links-heading"
          title="Share links of revoked bookmarklets"
          description="Read-only links to your decks, made in browsers these bookmarklets signed in. They kept working when you revoked the bookmarklet. Revoke them if it may have been stolen."
        >
          <RevokedKeyShareLinks keys={revokedKeyShareLinks} />
        </ListCard>
      )}

      <ListCard
        headingId="devices-heading"
        title="Signed-in devices"
        description="Browsers where you are signed in. Sign out any you don’t recognize, then revoke the bookmarklet that signed it in."
      >
        <DeviceList sessions={sessions} />
      </ListCard>

      {recoveries.length > 0 && (
        <ListCard
          headingId="recovery-heading"
          title="Recovery links used"
          description="An admin’s recovery link signed in as you, signed out your other devices, and revoked your bookmarklets and share links. If you didn’t ask for one, tell an admin you trust."
        >
          <RecoveryHistory uses={recoveries} />
        </ListCard>
      )}

      <Card as="section" aria-labelledby="sign-out-heading" className="flex flex-col gap-4">
        <CardHeader
          id="sign-out-heading"
          title="Sign out"
          description="Your decks stay here. Sign in again with your bookmarklet or a device link."
        />
        <SignOutPanel />
      </Card>
    </div>
  );
}
