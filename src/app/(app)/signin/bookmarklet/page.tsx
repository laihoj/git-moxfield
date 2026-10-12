import { Bookmark, LogIn, X } from 'lucide-react';
import type { Metadata } from 'next';

import { AuthPanel } from '@/components/auth/auth-panel';
import { DeadLinkPanel, LINK_PROBLEM_ICONS } from '@/components/auth/dead-link-panel';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AbsoluteTime, ExpiryTime } from '@/components/ui/relative-time';
import { formatDuration } from '@/lib/format';
import { getAuthService, HANDOFF_LIFETIME_MS } from '@/server/auth';
import { readHandoffToken, readSessionToken } from '@/server/auth/cookies';
import { getCurrentUser } from '@/server/auth/current-user';
import { HANDOFF_PATH, safeRedirectPath } from '@/server/auth/paths';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  robots: { index: false, follow: false },
  // The app's `no-referrer` policy makes browsers send `Origin: null` with this page's
  // form post; the hand-off route checks the origin, so this page sends its own (to
  // itself only: other sites still get no referrer).
  referrer: 'same-origin',
};

/**
 * Asks before a same-tab bookmarklet signs this browser in (ADR 0006). The bookmarklet's
 * cross-site post cannot prove that this browser's user ran it (any member can post
 * their own key from any page), so a browser that is signed out, or signed in as
 * someone else, gets here instead of being signed in silently. The page names the
 * account and the bookmarklet (display names are not unique, so the bookmarklet's label
 * and date too) and says whom it signs out. Its buttons post to the hand-off route,
 * which accepts only same-origin requests; opening the page changes nothing.
 */
export default async function BookmarkletSignInPage({ searchParams }: PageProps<'/signin/bookmarklet'>) {
  const { next: rawNext } = await searchParams;
  const next = safeRedirectPath(rawNext, '/');
  const [handoffToken, sessionToken] = await Promise.all([readHandoffToken(), readSessionToken()]);
  const auth = await getAuthService();
  const confirmation = await auth.describeHandoff(handoffToken, sessionToken);
  if (confirmation === null) return <HandoffExpired signedIn={(await getCurrentUser()) !== null} />;

  const { displayName, keyLabel, keyCreatedAt, replaces, expiresAt } = confirmation;
  return (
    <AuthPanel
      icon={<Bookmark aria-hidden="true" />}
      title={`Sign in as ${displayName}?`}
      description="A git-moxfield bookmarklet sent you here. Signing in lets this browser open that account’s decks."
    >
      <Card className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">Account</dt>
          <dd className="font-medium break-words text-fg">{displayName}</dd>
          <dt className="text-muted">Bookmarklet</dt>
          <dd className="break-words text-fg">
            “{keyLabel}”, made <AbsoluteTime value={keyCreatedAt} />
          </dd>
        </dl>
        {replaces !== null && (
          <Alert tone="warn" title={`You’re signed in as ${replaces.displayName}`}>
            Signing in as {displayName} signs {replaces.displayName} out of this browser.
          </Alert>
        )}
        <form method="post" action={HANDOFF_PATH} className="flex flex-col gap-2.5">
          <input type="hidden" name="next" value={next} />
          <Button
            type="submit"
            name="intent"
            value="confirm"
            variant="primary"
            size="lg"
            block
            icon={<LogIn aria-hidden="true" className="size-5" />}
          >
            Sign in as {displayName}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="cancel"
            variant="secondary"
            size="lg"
            block
            icon={<X aria-hidden="true" className="size-5" />}
          >
            Cancel
          </Button>
        </form>
        <p className="text-center text-xs text-pretty text-muted">
          Only sign in if you just ran your own bookmarklet.{' '}
          <span className="whitespace-nowrap">
            <ExpiryTime value={expiresAt} />.
          </span>
        </p>
      </Card>
    </AuthPanel>
  );
}

function HandoffExpired({ signedIn }: { signedIn: boolean }) {
  return (
    <DeadLinkPanel
      icon={LINK_PROBLEM_ICONS.expired}
      title="This sign-in has expired"
      description={`A bookmarklet sign-in waits ${formatDuration(HANDOFF_LIFETIME_MS)} to be confirmed. Run your bookmarklet again.`}
      signedIn={signedIn}
    />
  );
}
