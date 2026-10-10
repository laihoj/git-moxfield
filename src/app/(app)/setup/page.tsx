import { CircleCheck, ClipboardPaste, KeyRound, PartyPopper } from 'lucide-react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';

import { CreateBookmarklet } from '@/components/setup/create-bookmarklet';
import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Link } from '@/components/ui/navigation';
import { ClockTime, RelativeTime } from '@/components/ui/relative-time';
import { describeDevice } from '@/lib/devices';
import { joinList, pluralize } from '@/lib/format';
import { routes, WELCOME_REASONS, type WelcomeReason } from '@/lib/routes';
import { getSetupInfo } from '@/server/access';
import {
  getAuthService,
  MAX_KEY_LABEL_LENGTH,
  type BookmarkletKeyDTO,
  type SessionUser,
} from '@/server/auth';
import { requireUser } from '@/server/auth/current-user';
import type { SetupInfoDTO } from '@/server/services/contract';
import { publicAppUrl } from '@/app/request-origin';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connect Moxfield' };

/**
 * Connect Moxfield: server fetch status, the user's personal bookmarklets (ADR 0006) and
 * the paste fallback. Right after signing up, claiming or recovering (`?welcome=…`) it
 * greets the user and leads with creating a bookmarklet.
 */
export default async function SetupPage({ searchParams }: PageProps<'/setup'>) {
  const user = await requireUser({ next: routes.setup() });
  const { welcome: rawWelcome } = await searchParams;
  const welcome = WELCOME_REASONS.find((reason) => reason === rawWelcome) ?? null;
  const requestHeaders = await headers();
  const setup = getSetupInfo();
  const appUrl = publicAppUrl(requestHeaders);
  const auth = await getAuthService();
  const keys = await auth.listKeys(user);
  const siteHost = new URL(setup.moxfieldSiteOrigin).host;

  const bookmarkletCard = (
    <Card as="section" aria-labelledby="bookmarklet-heading" className="flex flex-col gap-5">
      <div>
        <h2 id="bookmarklet-heading" className="text-base font-semibold text-fg">
          The “Send to git-moxfield” bookmarklet
        </h2>
        <p className="mt-1 text-sm text-pretty text-muted">
          A bookmark that, clicked on a deck page on {siteHost}, reads the deck and its primer with your
          browser and hands them to git-moxfield. Decks you have not tracked yet ask for confirmation first.
        </p>
        <p className="mt-2 text-sm text-pretty text-muted">
          Each bookmarklet is a personal key: it also signs its browser in to your account. Make one for every
          browser you use.
        </p>
      </div>

      {appUrl === null ? (
        <Alert tone="warn" title="Can’t make a bookmarklet here">
          git-moxfield could not tell its own address from this request. Set <code>PUBLIC_APP_URL</code> (for
          example <code>http://localhost:3000</code>) and reload.
        </Alert>
      ) : (
        <CreateBookmarklet
          defaultLabel={describeDevice(requestHeaders.get('user-agent')).label}
          maxLabelLength={MAX_KEY_LABEL_LENGTH}
          siteHost={siteHost}
          appUrl={appUrl}
          autoFocus={welcome !== null}
        />
      )}

      <KeySummary keys={keys} />
    </Card>
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {welcome !== null && <Welcome reason={welcome} user={user} />}

      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Connect Moxfield</h1>
        <p className="mt-1 text-sm text-pretty text-muted">
          Moxfield has no public API. git-moxfield reads your deck the way Moxfield&apos;s own page does: from
          the server when Moxfield allows it, otherwise from your browser with a bookmarklet. Either way it
          only reads; it never changes your decks.
        </p>
      </div>

      {welcome !== null && bookmarkletCard}
      <ServerFetchCard setup={setup} />
      {welcome === null && bookmarkletCard}

      <Card as="section" aria-labelledby="paste-heading" className="flex flex-col gap-3">
        <h2 id="paste-heading" className="flex items-center gap-2 text-base font-semibold text-fg">
          <ClipboardPaste aria-hidden="true" className="size-4 text-muted" />
          No bookmarklet? Paste the deck
        </h2>
        <p className="text-sm text-muted">
          Open the deck&apos;s data URL in your browser, copy everything and paste it into git-moxfield. Works
          anywhere, takes a minute.
        </p>
        <div>
          <ButtonLink href="/capture?mode=paste" variant="secondary">
            Paste deck JSON
          </ButtonLink>
        </div>
      </Card>

      <Card as="section" aria-labelledby="ua-heading" className="flex flex-col gap-3">
        <h2 id="ua-heading" className="flex items-center gap-2 text-base font-semibold text-fg">
          <KeyRound aria-hidden="true" className="size-4 text-muted" />
          Automatic refresh with a Moxfield User-Agent
        </h2>
        <p className="text-sm text-muted">
          Moxfield&apos;s bot protection (Cloudflare) blocks requests from servers unless they carry a
          User-Agent that Moxfield issued. Moxfield grants these to personal, non-commercial projects that ask
          at{' '}
          <a href="mailto:support@moxfield.com" className="font-medium text-accent hover:underline">
            support@moxfield.com
          </a>
          . git-moxfield never disguises itself as a browser.
        </p>
        <p className="text-sm text-muted">
          If you get one, add it to <code className="rounded bg-surface-2 px-1 py-0.5">.env.local</code> as{' '}
          <code className="rounded bg-surface-2 px-1 py-0.5">MOXFIELD_USER_AGENT=…</code> and restart. Decks
          then refresh on their own when you open them and before every commit.
        </p>
        <p className="text-sm">
          {setup.userAgentConfigured ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-add">
              <CircleCheck aria-hidden="true" className="size-4" />A Moxfield User-Agent is configured.
            </span>
          ) : (
            <span className="text-muted">No Moxfield User-Agent is configured.</span>
          )}
        </p>
      </Card>

      <p className="text-center text-sm text-muted">
        All set?{' '}
        <Link href="/" className="font-medium text-accent hover:underline">
          Back to your decks
        </Link>
      </p>
    </div>
  );
}

function ServerFetchCard({ setup }: { setup: SetupInfoDTO }) {
  const status = setup.serverFetch;
  if (status.state === 'available') {
    return (
      <Alert tone={setup.userAgentConfigured ? 'success' : 'info'} title="Server fetch: on">
        {setup.userAgentConfigured
          ? 'git-moxfield fetches decks from Moxfield itself, using your Moxfield-issued User-Agent.'
          : 'git-moxfield will try to fetch decks itself. Without a Moxfield-issued User-Agent, Moxfield usually blocks this; git-moxfield then pauses server fetching and you use the bookmarklet instead.'}
      </Alert>
    );
  }
  if (status.state === 'blocked') {
    return (
      <Alert tone="warn" title="Server fetch: blocked by Moxfield">
        <p>{status.reason}</p>
        <p className="mt-1 text-muted">
          Paused until <ClockTime value={status.retryAt} /> (<RelativeTime value={status.retryAt} future />
          ).
        </p>
      </Alert>
    );
  }
  return (
    <Alert tone="info" title="Server fetch: off">
      <p>{status.reason}</p>
      <p className="mt-1 text-muted">
        Set <code className="rounded bg-surface/70 px-1 py-0.5">MOXFIELD_SERVER_FETCH=auto</code> to turn it
        on.
      </p>
    </Alert>
  );
}

const WELCOME: Record<WelcomeReason, (name: string) => { title: string; body: string }> = {
  invite: (name) => ({
    title: `Welcome to git-moxfield, ${name}`,
    body: 'Your account is ready. One more step: make your bookmarklet. It sends decks from Moxfield and signs you in, so you never need a password.',
  }),
  claimed: () => ({
    title: 'You’re the admin of this git-moxfield',
    body: 'Make your bookmarklet first. Then invite friends from Admin, in the menu at the top.',
  }),
  'claimed-local': () => ({
    title: 'You’re the admin of this git-moxfield',
    body: 'The decks and history already here are now yours. Make your bookmarklet, then invite friends from Admin, in the menu at the top.',
  }),
  recovery: (name) => ({
    title: `Welcome back, ${name}`,
    body: 'You’re signed in again. Every other device was signed out, and your old bookmarklets and share links were revoked, in case a device was lost or stolen. Make a new bookmarklet for this browser, and new links to share your decks again.',
  }),
};

/** Greeting after signing up, claiming or recovering. */
function Welcome({ reason, user }: { reason: WelcomeReason; user: SessionUser }) {
  const { title, body } = WELCOME[reason](user.displayName);
  return (
    <section
      aria-labelledby="welcome-heading"
      className="flex gap-3.5 rounded-xl border border-accent/30 bg-accent-soft/50 p-4 md:p-5"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg">
        <PartyPopper aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <h2 id="welcome-heading" className="text-base font-semibold break-words text-fg">
          {title}
        </h2>
        <p className="mt-0.5 text-sm text-pretty text-fg/80">{body}</p>
      </div>
    </section>
  );
}

/** Bookmarklet names listed before the rest is summed up (`and 2 more`). */
const LISTED_KEYS = 3;

/** The user's existing bookmarklets, by name, with a link to manage them. */
function KeySummary({ keys }: { keys: readonly BookmarkletKeyDTO[] }) {
  if (keys.length === 0) return null;
  const names = keys.slice(0, LISTED_KEYS).map((key) => `“${key.label}”`);
  if (keys.length > LISTED_KEYS) names.push(`${keys.length - LISTED_KEYS} more`);
  return (
    <p className="border-t border-border pt-4 text-sm text-pretty text-muted">
      You have {pluralize(keys.length, 'bookmarklet')}: <span className="text-fg">{joinList(names)}</span>.{' '}
      <Link href={routes.account()} className="font-medium whitespace-nowrap text-accent hover:underline">
        Manage them in Account
      </Link>
    </p>
  );
}
