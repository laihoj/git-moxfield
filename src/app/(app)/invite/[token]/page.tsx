import { Ban, CircleCheck, Hourglass, Mail, Unlink } from 'lucide-react';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AuthPanel } from '@/components/auth/auth-panel';
import { InviteForm } from '@/components/auth/invite-form';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ExpiryTime } from '@/components/ui/relative-time';
import { roleLabel } from '@/lib/accounts';
import { routes } from '@/lib/routes';
import { getAuthService, MAX_DISPLAY_NAME_LENGTH, type InviteLinkStatusDTO } from '@/server/auth';
import { getCurrentUser } from '@/server/auth/current-user';

export const dynamic = 'force-dynamic';

// The URL holds a secret: keep it out of search engines (it is also never sent as a Referer).
export const metadata: Metadata = { title: 'Invitation', robots: { index: false, follow: false } };

/**
 * An invite link (ADR 0006). Shows what the invite is and asks for a display name; the
 * account is only created by the form's POST, never by opening the link, so a chat app
 * previewing the link cannot use it up.
 */
export default async function InvitePage({ params }: PageProps<'/invite/[token]'>) {
  const { token } = await params;
  const [invite, user] = await Promise.all([
    getAuthService().then((auth) => auth.getInvite(token)),
    getCurrentUser(),
  ]);

  if (invite.status !== 'valid') return <InviteProblem status={invite.status} signedIn={user !== null} />;

  return (
    <AuthPanel
      icon={<Mail aria-hidden="true" />}
      title="You’re invited to git-moxfield"
      description="Keep every version of your Moxfield decks: what changed, when, and how to go back."
      footer="No password needed: next you make a bookmarklet, and it signs you in."
    >
      <Card className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge tone={invite.role === 'admin' ? 'accent' : 'neutral'}>{roleLabel(invite.role)}</Badge>
            <ExpiryTime value={invite.expiresAt} className="text-xs text-muted" />
          </div>
          <p className="text-sm text-pretty text-muted">
            {invite.role === 'admin'
              ? 'You get your own private decks, and you can invite people and help them back in. Admins manage accounts, not decks: a recovery link signs in as the person it is for, so give it only to them.'
              : 'You get your own private decks and history; nobody else can browse them. If you ever lose every way in, an admin can make you a recovery link, and your Account page shows when one was used.'}
          </p>
        </div>
        {user !== null && (
          <Alert tone="warn" title={`You’re signed in as ${user.displayName}`}>
            This invite creates a new account, and this browser switches to it.
          </Alert>
        )}
        <InviteForm token={token} maxNameLength={MAX_DISPLAY_NAME_LENGTH} />
      </Card>
    </AuthPanel>
  );
}

type Problem = Exclude<InviteLinkStatusDTO['status'], 'valid'>;

const PROBLEMS: Record<Problem, { icon: ReactNode; title: string; description: string }> = {
  invalid: {
    icon: <Unlink aria-hidden="true" />,
    title: 'This invite link doesn’t work',
    description: 'Check that you copied all of it, or ask for a new one.',
  },
  expired: {
    icon: <Hourglass aria-hidden="true" />,
    title: 'This invite has expired',
    description: 'Invites work for 7 days. Ask whoever sent it for a new one.',
  },
  used: {
    icon: <CircleCheck aria-hidden="true" />,
    title: 'This invite has already been used',
    description: 'Each invite makes one account. If it was yours, sign in with your bookmarklet.',
  },
  revoked: {
    icon: <Ban aria-hidden="true" />,
    title: 'This invite was withdrawn',
    description: 'Ask whoever sent it for a new one.',
  },
};

function InviteProblem({ status, signedIn }: { status: Problem; signedIn: boolean }) {
  const { icon, title, description } = PROBLEMS[status];
  return (
    <AuthPanel
      icon={icon}
      tone="muted"
      title={title}
      // Signed in already: no need to explain how to sign in.
      description={status === 'used' && signedIn ? 'Each invite makes one account.' : description}
    >
      <div className="flex justify-center">
        {signedIn ? (
          <ButtonLink href={routes.home()} variant="secondary">
            Back to your decks
          </ButtonLink>
        ) : (
          <ButtonLink href={routes.signIn()} variant={status === 'used' ? 'primary' : 'secondary'}>
            Sign in
          </ButtonLink>
        )}
      </div>
    </AuthPanel>
  );
}
