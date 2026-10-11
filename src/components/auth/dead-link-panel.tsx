import { Ban, CircleCheck, Hourglass, Unlink } from 'lucide-react';
import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { routes } from '@/lib/routes';
import type { OneTimeLinkProblem } from '@/server/auth/types';

import { AuthPanel } from './auth-panel';

/** The icon of each way a one-time link can fail, the same on every page that explains it. */
export const LINK_PROBLEM_ICONS: Record<OneTimeLinkProblem, ReactNode> = {
  invalid: <Unlink aria-hidden="true" />,
  expired: <Hourglass aria-hidden="true" />,
  used: <CircleCheck aria-hidden="true" />,
  revoked: <Ban aria-hidden="true" />,
};

export interface DeadLinkPanelProps {
  icon: ReactNode;
  title: string;
  description: string;
  /** Whether this browser is signed in: it is sent back to its decks instead of to sign in. */
  signedIn: boolean;
  /** The button for a browser that is signed out (default: `Other ways to sign in`). */
  signInLabel?: string;
  /** Whether that button leads the page (default: it is secondary). */
  signInPrimary?: boolean;
}

/** A one-time link that cannot be used (an invite, a sign-in link, a bookmarklet sign-in), and the way on. */
export function DeadLinkPanel({
  icon,
  title,
  description,
  signedIn,
  signInLabel = 'Other ways to sign in',
  signInPrimary = false,
}: DeadLinkPanelProps) {
  return (
    <AuthPanel icon={icon} tone="muted" title={title} description={description}>
      <div className="flex justify-center">
        {signedIn ? (
          <ButtonLink href={routes.home()} variant="secondary">
            Back to your decks
          </ButtonLink>
        ) : (
          <ButtonLink href={routes.signIn()} variant={signInPrimary ? 'primary' : 'secondary'}>
            {signInLabel}
          </ButtonLink>
        )}
      </div>
    </AuthPanel>
  );
}

/** The warning that using a one-time link changes who this browser is signed in as. */
export function SignedInAsAlert({ displayName, children }: { displayName: string; children: ReactNode }) {
  return (
    <Alert tone="warn" title={`You’re signed in as ${displayName}`}>
      {children}
    </Alert>
  );
}
