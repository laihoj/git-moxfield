import { Ban, CircleCheck, Hourglass, LifeBuoy, MonitorSmartphone, Unlink } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AuthPanel } from '@/components/auth/auth-panel';
import { LoginLinkForm } from '@/components/auth/login-link-form';
import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ExpiryTime } from '@/components/ui/relative-time';
import { routes } from '@/lib/routes';
import { getAuthService, type LoginLinkStatusDTO } from '@/server/auth';
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
  const [link, user] = await Promise.all([getAuthService().getLoginLink(token), getCurrentUser()]);

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
          <Alert tone="warn" title={`You’re signed in as ${user.displayName}`}>
            This browser switches to {link.displayName}’s account.
          </Alert>
        )}
        <LoginLinkForm token={token} />
        <p className="text-center text-xs text-muted">
          <ExpiryTime value={link.expiresAt} /> · works once
        </p>
      </Card>
    </AuthPanel>
  );
}

type Problem = Exclude<LoginLinkStatusDTO['status'], 'valid'>;

const PROBLEMS: Record<Problem, { icon: ReactNode; title: string; description: string }> = {
  invalid: {
    icon: <Unlink aria-hidden="true" />,
    title: 'This sign-in link doesn’t work',
    description: 'Check that you copied all of it. If it is a recovery link, ask your admin for a new one.',
  },
  expired: {
    icon: <Hourglass aria-hidden="true" />,
    title: 'This sign-in link has expired',
    description:
      'Device links work for 15 minutes, recovery links for a day. Make a new one in Account on a signed-in device, or ask your admin.',
  },
  used: {
    icon: <CircleCheck aria-hidden="true" />,
    title: 'This sign-in link was already used',
    description:
      'Each link signs in once. Make a new one in Account on a signed-in device, or ask your admin.',
  },
  revoked: {
    icon: <Ban aria-hidden="true" />,
    title: 'This sign-in link was withdrawn',
    description:
      'It no longer works. Make a new one in Account on a signed-in device, or ask your admin for a new recovery link.',
  },
};

function LinkProblem({ status, signedIn }: { status: Problem; signedIn: boolean }) {
  const { icon, title, description } = PROBLEMS[status];
  return (
    <AuthPanel
      icon={icon}
      tone="muted"
      title={title}
      // Signed in already (often with this very link): no need to explain how to sign in.
      description={status === 'used' && signedIn ? 'Each link signs in once.' : description}
    >
      <div className="flex justify-center">
        {signedIn ? (
          <ButtonLink href={routes.home()} variant="secondary">
            Back to your decks
          </ButtonLink>
        ) : (
          <ButtonLink href={routes.signIn()} variant="secondary">
            Other ways to sign in
          </ButtonLink>
        )}
      </div>
    </AuthPanel>
  );
}
