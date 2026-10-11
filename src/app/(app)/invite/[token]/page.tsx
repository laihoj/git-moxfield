import { Mail } from 'lucide-react';
import type { Metadata } from 'next';

import { AuthPanel } from '@/components/auth/auth-panel';
import { DeadLinkPanel, LINK_PROBLEM_ICONS, SignedInAsAlert } from '@/components/auth/dead-link-panel';
import { InviteForm } from '@/components/auth/invite-form';
import { RoleBadge } from '@/components/account/role-badge';
import { Card } from '@/components/ui/card';
import { ExpiryTime } from '@/components/ui/relative-time';
import { formatDuration } from '@/lib/format';
import { getAuthService, INVITE_LIFETIME_MS, type OneTimeLinkProblem } from '@/server/auth';
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
            <RoleBadge role={invite.role} showMember />
            <ExpiryTime value={invite.expiresAt} className="text-xs text-muted" />
          </div>
          <p className="text-sm text-pretty text-muted">
            {invite.role === 'admin'
              ? 'You get your own private decks, and you can invite people and help them back in. Admins manage accounts, not decks: a recovery link signs in as the person it is for, so give it only to them.'
              : 'You get your own private decks and history; nobody else can browse them. If you ever lose every way in, an admin can make you a recovery link, and your Account page shows when one was used.'}
          </p>
        </div>
        {user !== null && (
          <SignedInAsAlert displayName={user.displayName}>
            This invite creates a new account, and this browser switches to it.
          </SignedInAsAlert>
        )}
        <InviteForm token={token} />
      </Card>
    </AuthPanel>
  );
}

const PROBLEMS: Record<OneTimeLinkProblem, { title: string; description: string }> = {
  invalid: {
    title: 'This invite link doesn’t work',
    description: 'Check that you copied all of it, or ask for a new one.',
  },
  expired: {
    title: 'This invite has expired',
    description: `Invites work for ${formatDuration(INVITE_LIFETIME_MS)}. Ask whoever sent it for a new one.`,
  },
  used: {
    title: 'This invite has already been used',
    description: 'Each invite makes one account. If it was yours, sign in with your bookmarklet.',
  },
  revoked: {
    title: 'This invite was withdrawn',
    description: 'Ask whoever sent it for a new one.',
  },
};

function InviteProblem({ status, signedIn }: { status: OneTimeLinkProblem; signedIn: boolean }) {
  const { title, description } = PROBLEMS[status];
  return (
    <DeadLinkPanel
      icon={LINK_PROBLEM_ICONS[status]}
      title={title}
      // Signed in already: no need to explain how to sign in.
      description={status === 'used' && signedIn ? 'Each invite makes one account.' : description}
      signedIn={signedIn}
      signInLabel="Sign in"
      signInPrimary={status === 'used'}
    />
  );
}
