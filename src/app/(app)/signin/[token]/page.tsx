import { LifeBuoy, MonitorSmartphone } from 'lucide-react';
import type { Metadata } from 'next';

import { AuthPanel } from '@/components/auth/auth-panel';
import { DeadLinkPanel, LINK_PROBLEM_ICONS, SignedInAsAlert } from '@/components/auth/dead-link-panel';
import { LoginLinkForm } from '@/components/auth/login-link-form';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { ExpiryTime } from '@/components/ui/relative-time';
import { formatDuration } from '@/lib/format';
import {
  DEVICE_LINK_LIFETIME_MS,
  getAuthService,
  RECOVERY_LINK_LIFETIME_MS,
  type OneTimeLinkProblem,
} from '@/server/auth';
import { getCurrentUser } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

// The URL holds a secret: keep it out of search engines (it is also never sent as a Referer).
export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };

/**
 * A one-time device or recovery link (ADR 0006): who it signs in, and one button that
 * does it. Opening the page changes nothing; the button's POST uses the link up.
 */
export default async function LoginLinkPage({ params }: PageProps<'/signin/[token]'>) {
  const { token } = await params;
  const [link, user] = await Promise.all([
    getAuthService().then((auth) => auth.getLoginLink(token)),
    getCurrentUser(),
  ]);

  if (link.status !== 'valid') return <LinkProblem status={link.status} signedIn={user !== null} />;

  const recovery = link.purpose === 'recovery';
  return (
    <AuthPanel
      icon={recovery ? <LifeBuoy aria-hidden="true" /> : <MonitorSmartphone aria-hidden="true" />}
      title={`Sign in as ${link.displayName}`}
      description={
        recovery
          ? 'Your admin made this recovery link for you. Once you’re in, make a new bookmarklet.'
          : 'You made this link on another device, to sign in here without a bookmarklet.'
      }
    >
      <Card className="flex flex-col gap-4">
        {recovery && (
          <Alert tone="info" title="This signs out every other device">
            A recovery link signs {link.displayName} out everywhere else, and revokes all of the account’s
            bookmarklets and share links, in case a device was lost or stolen.
          </Alert>
        )}
        {user !== null && (
          <SignedInAsAlert displayName={user.displayName}>
            This browser switches to {link.displayName}’s account.
          </SignedInAsAlert>
        )}
        <LoginLinkForm token={token} />
        <p className="text-center text-xs text-muted">
          <ExpiryTime value={link.expiresAt} /> · works once
        </p>
      </Card>
    </AuthPanel>
  );
}

const PROBLEMS: Record<OneTimeLinkProblem, { title: string; description: string }> = {
  invalid: {
    title: 'This sign-in link doesn’t work',
    description: 'Check that you copied all of it. If it is a recovery link, ask your admin for a new one.',
  },
  expired: {
    title: 'This sign-in link has expired',
    description: `Device links work for ${formatDuration(DEVICE_LINK_LIFETIME_MS)}, recovery links for ${formatDuration(RECOVERY_LINK_LIFETIME_MS)}. Make a new one in Account on a signed-in device, or ask your admin.`,
  },
  used: {
    title: 'This sign-in link was already used',
    description:
      'Each link signs in once. Make a new one in Account on a signed-in device, or ask your admin.',
  },
  revoked: {
    title: 'This sign-in link was withdrawn',
    description:
      'It no longer works. Make a new one in Account on a signed-in device, or ask your admin for a new recovery link.',
  },
};

function LinkProblem({ status, signedIn }: { status: OneTimeLinkProblem; signedIn: boolean }) {
  const { title, description } = PROBLEMS[status];
  return (
    <DeadLinkPanel
      icon={LINK_PROBLEM_ICONS[status]}
      title={title}
      // Signed in already (often with this very link): no need to explain how to sign in.
      description={status === 'used' && signedIn ? 'Each link signs in once.' : description}
      signedIn={signedIn}
    />
  );
}
