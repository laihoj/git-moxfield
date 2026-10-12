import clsx from 'clsx';
import { ArrowRight, Bookmark, KeyRound, LifeBuoy, MonitorSmartphone } from 'lucide-react';
import type { Metadata, Route } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { AuthPanel } from '@/components/auth/auth-panel';
import { RefreshOnReturn } from '@/components/auth/refresh-on-return';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ExternalLink } from '@/components/ui/external-link';
import { IconTile } from '@/components/ui/item-list';
import { routes } from '@/lib/routes';
import { getSetupInfo } from '@/server/access';
import { getAuthService } from '@/server/auth';
import { getCurrentUser } from '@/server/auth/current-user';
import { safeRedirectPath } from '@/server/auth/paths';
import { TEXT_LINK } from '@/components/ui/text-link';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in' };

/**
 * Sign in (ADR 0006). There is no password form: this page explains the ways in. A
 * signed-in browser goes straight on to `next` (a local path, validated against open
 * redirects), also when the sign-in happened in another tab and the user comes back here.
 */
export default async function SignInPage({ searchParams }: PageProps<'/signin'>) {
  const { next: rawNext } = await searchParams;
  const next = safeRedirectPath(rawNext, '/');
  if ((await getCurrentUser()) !== null) redirect(next as Route);

  const auth = await getAuthService();
  const claimable = await auth.isClaimable();
  const { moxfieldSiteOrigin } = getSetupInfo();
  const moxfieldHost = new URL(moxfieldSiteOrigin).host;

  return (
    <AuthPanel
      icon={<KeyRound aria-hidden="true" />}
      title="Sign in to git-moxfield"
      description="No passwords here: your bookmarklet is your key."
      footer={
        <>
          New here? git-moxfield is invite-only.{' '}
          <span className="whitespace-nowrap">Ask its admin for an invite link.</span>
        </>
      }
    >
      <RefreshOnReturn />

      {claimable && (
        <Card as="section" aria-labelledby="claim-heading" className="flex flex-col gap-3 border-accent/40">
          <div>
            <h2 id="claim-heading" className="text-base font-semibold text-fg">
              This git-moxfield has no admin yet
            </h2>
            <p className="mt-1 text-sm text-pretty text-muted">
              If you run it, set it up with the setup code from the server log. You become its admin.
            </p>
          </div>
          <div>
            <ButtonLink href={routes.claim()} variant="primary">
              Set up git-moxfield
              <ArrowRight aria-hidden="true" className="size-4" />
            </ButtonLink>
          </div>
        </Card>
      )}

      <Card as="section" flush aria-labelledby="ways-heading">
        <h2 id="ways-heading" className="sr-only">
          Ways to sign in
        </h2>
        <ul className="divide-y divide-border">
          <Way icon={<Bookmark aria-hidden="true" />} title="Run your bookmarklet">
            <p>
              Open any deck on {moxfieldHost} in this browser and click your{' '}
              <span className="font-medium whitespace-nowrap text-fg">Send to git-moxfield</span> bookmark. It
              signs this browser in and brings the deck along.
            </p>
            <ExternalLink
              href={moxfieldSiteOrigin}
              className={clsx(TEXT_LINK, 'mt-0.5 inline-flex min-h-11 items-center gap-1 md:mt-2 md:min-h-0')}
            >
              Open Moxfield
            </ExternalLink>
          </Way>
          <Way icon={<MonitorSmartphone aria-hidden="true" />} title="Use a device that’s signed in">
            <p>
              On your other phone or computer, open{' '}
              <span className="font-medium whitespace-nowrap text-fg">
                Account › Sign in on another device
              </span>
              . Scan the QR code, or open the link it gives you here.
            </p>
          </Way>
          <Way icon={<LifeBuoy aria-hidden="true" />} title="Lost every bookmarklet and device?">
            <p>
              Ask the admin of this git-moxfield for a recovery link. Your decks and their history are safe.
            </p>
          </Way>
        </ul>
      </Card>
    </AuthPanel>
  );
}

function Way({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3.5 p-4 md:p-5">
      <IconTile tone="accent">{icon}</IconTile>
      <div className="min-w-0 text-sm text-pretty text-muted">
        <h3 className="mb-0.5 text-sm font-semibold text-fg">{title}</h3>
        {children}
      </div>
    </li>
  );
}
