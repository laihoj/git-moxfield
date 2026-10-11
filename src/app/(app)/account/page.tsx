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
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { roleLabel } from '@/lib/accounts';
import { formatDuration } from '@/lib/format';
import { routes } from '@/lib/routes';
import { DEVICE_LINK_LIFETIME_MS, getAuthService, MAX_DISPLAY_NAME_LENGTH } from '@/server/auth';
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
            {user.role === 'admin' && <Badge tone="accent">{roleLabel(user.role)}</Badge>}
          </p>
        </div>
      </div>

      <Card as="section" aria-labelledby="profile-heading" className="flex flex-col gap-4">
        <CardHeader id="profile-heading" title="Profile" />
        <RenameForm displayName={user.displayName} maxLength={MAX_DISPLAY_NAME_LENGTH} />
      </Card>

      <Card as="section" aria-labelledby="device-link-heading" className="flex flex-col gap-4">
        <CardHeader
          id="device-link-heading"
          title="Sign in on another device"
          description={`Sign in on your phone or another computer without a bookmarklet: make a one-time link here and scan or open it there. It works once, for ${formatDuration(DEVICE_LINK_LIFETIME_MS)}.`}
        />
        <DeviceLinkPanel />
      </Card>

      <Card as="section" flush aria-labelledby="keys-heading">
        <CardHeader
          id="keys-heading"
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
          className="border-b border-border p-4 md:p-5"
        />
        <KeyList keys={keys} />
      </Card>

      {revokedKeyShareLinks.length > 0 && (
        <Card as="section" flush aria-labelledby="revoked-key-links-heading">
          <CardHeader
            id="revoked-key-links-heading"
            title="Share links of revoked bookmarklets"
            description="Read-only links to your decks, made in browsers these bookmarklets signed in. They kept working when you revoked the bookmarklet. Revoke them if it may have been stolen."
            className="border-b border-border p-4 md:p-5"
          />
          <RevokedKeyShareLinks keys={revokedKeyShareLinks} />
        </Card>
      )}

      <Card as="section" flush aria-labelledby="devices-heading">
        <CardHeader
          id="devices-heading"
          title="Signed-in devices"
          description="Browsers where you are signed in. Sign out any you don’t recognize, then revoke the bookmarklet that signed it in."
          className="border-b border-border p-4 md:p-5"
        />
        <DeviceList sessions={sessions} />
      </Card>

      {recoveries.length > 0 && (
        <Card as="section" flush aria-labelledby="recovery-heading">
          <CardHeader
            id="recovery-heading"
            title="Recovery links used"
            description="An admin’s recovery link signed in as you, signed out your other devices, and revoked your bookmarklets and share links. If you didn’t ask for one, tell an admin you trust."
            className="border-b border-border p-4 md:p-5"
          />
          <RecoveryHistory uses={recoveries} />
        </Card>
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
