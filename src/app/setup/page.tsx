import clsx from 'clsx';
import { CircleCheck, ClipboardPaste, KeyRound, Monitor, Smartphone } from 'lucide-react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { BookmarkletLink } from '@/components/capture/bookmarklet-link';
import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { ClockTime, RelativeTime } from '@/components/ui/relative-time';
import type { SetupInfoDTO } from '@/server/services/contract';
import { getServices } from '@/server/services';

import { publicAppUrl } from '../request-origin';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Connect Moxfield' };

/** Connect Moxfield: server fetch status, the bookmarklets and the paste fallback. */
export default async function SetupPage() {
  const setup = getServices().getSetupInfo();
  const appUrl = publicAppUrl(await headers());
  const bookmarklets = appUrl === null ? null : getServices().getBookmarklets(appUrl);
  const siteHost = new URL(setup.moxfieldSiteOrigin).host;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Connect Moxfield</h1>
        <p className="mt-1 text-sm text-pretty text-muted">
          Moxfield has no public API. git-moxfield reads your deck the way Moxfield&apos;s own page does: from
          the server when Moxfield allows it, otherwise from your browser with a bookmarklet. Either way it
          only reads; it never changes your decks.
        </p>
      </div>

      <ServerFetchCard setup={setup} />

      <Card as="section" aria-labelledby="bookmarklet-heading" className="flex flex-col gap-5">
        <div>
          <h2 id="bookmarklet-heading" className="text-base font-semibold text-fg">
            The “Send to git-moxfield” bookmarklet
          </h2>
          <p className="mt-1 text-sm text-muted">
            A bookmark that, clicked on a deck page on {siteHost}, reads the deck and its primer with your
            browser and hands them to git-moxfield. Decks you have not tracked yet ask for confirmation first.
          </p>
        </div>

        {bookmarklets === null ? (
          <Alert tone="warn" title="Cannot build the bookmarklet">
            The app&apos;s address could not be determined from this request. Set <code>PUBLIC_APP_URL</code>{' '}
            (for example <code>http://localhost:3000</code>) and reload.
          </Alert>
        ) : (
          <>
            <InstructionBlock
              icon={<Monitor aria-hidden="true" className="size-4" />}
              title="Desktop (Chrome, Firefox, Safari, Edge)"
              className="max-md:order-2"
            >
              <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
                <li>
                  Show the bookmarks bar (<Kbd>Ctrl</Kbd>/<Kbd>⌘</Kbd> + <Kbd>Shift</Kbd> + <Kbd>B</Kbd>).
                </li>
                <li>Drag this button onto the bar:</li>
              </ol>
              <div className="flex flex-wrap items-start gap-3 pl-5">
                <BookmarkletLink code={bookmarklets.popup} label="Send to git-moxfield" />
                <CopyButton
                  text={bookmarklets.popup}
                  label="Copy bookmarklet code"
                  subject="Bookmarklet code"
                  size="sm"
                />
              </div>
              <ol
                start={3}
                className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle"
              >
                <li>
                  Open one of your decks on {siteHost} and click the bookmark. A git-moxfield window opens
                  with the deck.
                </li>
              </ol>
            </InstructionBlock>

            <InstructionBlock
              icon={<Smartphone aria-hidden="true" className="size-4" />}
              title="Phone and tablet (Safari on iOS, Chrome on Android, in-app browsers)"
              className="max-md:order-1"
            >
              <p className="text-sm text-muted">
                Phones block popups, so this variant sends the deck in the same tab and opens it in{' '}
                <span className="whitespace-nowrap">git-moxfield</span>.
              </p>
              <div className="flex flex-wrap items-start gap-3">
                <CopyButton
                  text={bookmarklets.sameTab}
                  label="Copy same-tab bookmarklet"
                  subject="Same-tab bookmarklet code"
                  variant="primary"
                />
                <BookmarkletLink code={bookmarklets.sameTab} label="Send to git-moxfield (same tab)" />
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <h4 className="mb-1.5 text-sm font-semibold text-fg">iPhone and iPad</h4>
                  <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
                    <li>Copy the same-tab bookmarklet above.</li>
                    <li>
                      Bookmark any page (Share › Add Bookmark) and name it{' '}
                      <span className="whitespace-nowrap">“Send to git-moxfield”</span>.
                    </li>
                    <li>Open Bookmarks › Edit, select it and replace its address with the copied code.</li>
                    <li>On a deck page, open Bookmarks and tap it.</li>
                  </ol>
                </div>
                <div>
                  <h4 className="mb-1.5 text-sm font-semibold text-fg">Android (Chrome)</h4>
                  <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm text-fg marker:text-subtle">
                    <li>Copy the same-tab bookmarklet above.</li>
                    <li>Bookmark any page (⋮ › ☆), then edit it: name it “gm”, paste the code as its URL.</li>
                    <li>
                      On a deck page, type <Kbd>gm</Kbd> in the address bar and pick the bookmark from the
                      suggestions.
                    </li>
                  </ol>
                </div>
              </div>
            </InstructionBlock>

            <p className="text-xs text-muted max-md:order-3">
              The bookmarklets send decks to{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5">{appUrl}</code>. To use them from another
              device, start git-moxfield with{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5 whitespace-nowrap">pnpm start:lan</code>{' '}
              (otherwise only this computer can reach it) and protect it with Basic auth, then open it there
              with the address it should use, or set{' '}
              <code className="rounded bg-surface-2 px-1 py-0.5">PUBLIC_APP_URL</code> (for example your
              computer&apos;s LAN address).
            </p>
          </>
        )}
      </Card>

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
          : 'git-moxfield will try to fetch decks itself. Without a Moxfield-issued User-Agent, Moxfield usually blocks this; git-moxfield then pauses server fetching and you use the bookmarklet below.'}
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

function InstructionBlock({
  icon,
  title,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={clsx('flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-4', className)}
    >
      <h3 className="flex items-start gap-2 text-sm font-semibold text-fg">
        <span className="flex h-5 shrink-0 items-center text-muted">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border-strong bg-surface px-1.5 py-0.5 font-sans text-xs font-medium text-fg shadow-card">
      {children}
    </kbd>
  );
}
