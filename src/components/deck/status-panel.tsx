import clsx from 'clsx';
import { ArrowUpRight, Bookmark, ClipboardPaste } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import type { ServerFetchStatus } from '@/integrations/deck-source';
import type { DeckOverviewDTO, FetchErrorDTO, ObservationDTO } from '@/server/services/types';
import { Alert } from '@/components/ui/alert';
import { ButtonLink, ExternalButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { ClockTime, RelativeTime } from '@/components/ui/relative-time';
import { versionLabel } from '@/lib/format';
import { describeFetchError, describeStatus } from '@/lib/presentation';
import { routes } from '@/lib/routes';

import { AutoRefresh } from './auto-refresh';
import { RefreshButton } from './refresh-button';
import { StatusIndicator } from './status-indicator';

export type StatusPanelDeck = Pick<
  DeckOverviewDTO,
  'id' | 'url' | 'status' | 'head' | 'working' | 'lastFetchError' | 'serverFetch' | 'autoRefreshSuggested'
>;

export interface StatusPanelProps {
  deck: StatusPanelDeck;
  /** Extra content at the bottom of the panel (summary chips). */
  children?: ReactNode;
}

/** How the latest observation arrived, as a verb phrase: `checked`, `sent from your browser`, `pasted`. */
function observedVerb(method: ObservationDTO['method']): string {
  switch (method) {
    case 'server':
      return 'checked';
    case 'browser-capture':
      return 'sent from your browser';
    case 'manual-paste':
      return 'pasted';
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A fetch error is current when it happened after the latest successful observation. */
function currentFetchError(deck: StatusPanelDeck): FetchErrorDTO | null {
  const error = deck.lastFetchError;
  if (error === null) return null;
  if (deck.working === null) return error;
  return Date.parse(error.at) > Date.parse(deck.working.fetchedAt) ? error : null;
}

/**
 * The deck's Moxfield status (docs/ux.md, "States of the status panel"): status label,
 * when Moxfield last changed and when git-moxfield last looked, the Moxfield revision
 * versus the latest version, fetch errors with the next step, and the refresh control
 * ("Update from Moxfield" via the bookmarklet when server fetching is unavailable).
 */
export function StatusPanel({ deck, children }: StatusPanelProps) {
  const { label, tone } = describeStatus(deck.status, deck.head);
  const { serverFetch } = deck;
  const serverAvailable = serverFetch.state === 'available';
  const error = currentFetchError(deck);
  const working = deck.working;
  /** The first-snapshot steps already lead to Moxfield, the bookmarklet setup and paste. */
  const stepsShown = deck.status === 'never-fetched' && !serverAvailable;

  return (
    <Card as="section" aria-labelledby="status-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 sm:flex-nowrap">
        <div className={clsx('min-w-0 flex-1', !serverAvailable && 'basis-64')}>
          <h2 id="status-heading" className="flex items-start gap-2 text-base font-semibold text-fg">
            <StatusIndicator tone={tone} className="mt-1" />
            {label}
          </h2>
          <div className="mt-1.5 flex flex-col gap-0.5 pl-6 text-sm text-muted">
            {working !== null && (
              <MetaList aria-label="Moxfield activity">
                {working.sourceUpdatedAt !== null && (
                  <MetaItem>
                    Moxfield edited <RelativeTime value={working.sourceUpdatedAt} />
                  </MetaItem>
                )}
                <MetaItem>
                  {working.sourceUpdatedAt === null
                    ? capitalize(observedVerb(working.method))
                    : observedVerb(working.method)}{' '}
                  <RelativeTime value={working.fetchedAt} />
                </MetaItem>
              </MetaList>
            )}
            <VersionLine deck={deck} />
            {deck.status === 'no-versions' && <p>Review the deck below, then commit it as v1.</p>}
            <AutoRefresh deckId={deck.id} enabled={deck.autoRefreshSuggested} />
          </div>
        </div>
        <RefreshControl deck={deck} serverAvailable={serverAvailable} />
      </div>

      {deck.status === 'never-fetched' && <FirstSnapshotHelp serverAvailable={serverAvailable} />}
      {error !== null && (
        <FetchErrorBanner
          error={error}
          deckUrl={deck.url}
          serverFetch={serverFetch}
          showActions={!stepsShown}
        />
      )}
      {error === null && deck.status !== 'never-fetched' && serverFetch.state !== 'available' && (
        <ServerFetchNote serverFetch={serverFetch} />
      )}
      {children}
    </Card>
  );
}

/** `Moxfield version 143 · v47 committed at 137`. */
function VersionLine({ deck }: { deck: StatusPanelDeck }) {
  const current = deck.working?.sourceVersion ?? null;
  const head = deck.head;
  if (current === null && head === null) return null;
  return (
    <MetaList aria-label="Versions" className="tabular">
      {current !== null && <MetaItem>Moxfield version {current}</MetaItem>}
      {head !== null && (
        <MetaItem>
          {versionLabel(head.sequence)} committed
          {head.sourceVersion !== null && <> at {head.sourceVersion}</>}
        </MetaItem>
      )}
    </MetaList>
  );
}

function RefreshControl({ deck, serverAvailable }: { deck: StatusPanelDeck; serverAvailable: boolean }) {
  if (serverAvailable) return <RefreshButton deckId={deck.id} />;
  return (
    <ExternalButtonLink
      href={deck.url}
      size="sm"
      variant={deck.status === 'never-fetched' ? 'primary' : 'secondary'}
      trailingIcon={<ArrowUpRight aria-hidden="true" className="size-4" />}
      title="Opens the deck on Moxfield. Click the git-moxfield bookmarklet there to send the current deck."
    >
      Update from Moxfield
    </ExternalButtonLink>
  );
}

function FirstSnapshotHelp({ serverAvailable }: { serverAvailable: boolean }) {
  if (serverAvailable) {
    return (
      <p className="text-sm text-muted sm:pl-6">
        Refresh to fetch the deck from Moxfield, or send it with the{' '}
        <Link href={routes.setup()} className="font-medium text-accent hover:underline">
          bookmarklet
        </Link>
        .
      </p>
    );
  }
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm sm:pl-11 text-muted marker:text-subtle">
      <li>
        Open the deck on Moxfield with <span className="font-medium text-fg">Update from Moxfield</span>.
      </li>
      <li>
        Click the <span className="font-medium text-fg">Send to git-moxfield</span> bookmarklet there.{' '}
        <Link href={routes.setup()} className="font-medium text-accent hover:underline">
          Set it up
        </Link>
      </li>
      <li>
        Or paste the deck JSON:{' '}
        <Link href={routes.capturePaste()} className="font-medium text-accent hover:underline">
          paste instead
        </Link>
      </li>
    </ol>
  );
}

function FetchErrorBanner({
  error,
  deckUrl,
  serverFetch,
  showActions,
}: {
  error: FetchErrorDTO;
  deckUrl: string;
  serverFetch: ServerFetchStatus;
  /** False when the panel already offers the bookmarklet and paste actions elsewhere. */
  showActions: boolean;
}) {
  const tone = error.code === 'rate-limited' || error.code === 'blocked' ? 'warn' : 'error';
  const bookmarkletActions = (
    <>
      <ExternalButtonLink
        href={deckUrl}
        size="sm"
        trailingIcon={<ArrowUpRight aria-hidden="true" className="size-4" />}
      >
        Open deck in Moxfield
      </ExternalButtonLink>
      <ButtonLink
        href={routes.setup()}
        size="sm"
        variant="ghost"
        icon={<Bookmark aria-hidden="true" className="size-4" />}
      >
        Bookmarklet setup
      </ButtonLink>
      <ButtonLink
        href={routes.capturePaste()}
        size="sm"
        variant="ghost"
        icon={<ClipboardPaste aria-hidden="true" className="size-4" />}
      >
        Paste JSON
      </ButtonLink>
    </>
  );
  return (
    <Alert
      tone={tone}
      title={describeFetchError(error.code)}
      actions={
        showActions && (error.code === 'blocked' || serverFetch.state !== 'available')
          ? bookmarkletActions
          : undefined
      }
    >
      <p>
        {error.message}
        {error.code === 'rate-limited' && error.retryAfterSeconds !== null && (
          <> Try again in about {Math.max(1, Math.ceil(error.retryAfterSeconds / 60))} min.</>
        )}
        {(error.code === 'not-found' || error.code === 'forbidden') && (
          <> Check that the deck still exists and is public or unlisted on Moxfield.</>
        )}
      </p>
      <p className="mt-1 text-xs text-muted">
        <RelativeTime value={error.at} />
      </p>
    </Alert>
  );
}

/** Quiet note when server fetching is paused or off but browser captures keep the deck current. */
function ServerFetchNote({
  serverFetch,
}: {
  serverFetch: Exclude<ServerFetchStatus, { state: 'available' }>;
}) {
  return (
    <p className="text-xs text-muted sm:pl-6">
      {serverFetch.state === 'blocked' ? (
        <>
          Moxfield blocked server-side fetching, so it is paused until{' '}
          <ClockTime value={serverFetch.retryAt} /> (
          <RelativeTime value={serverFetch.retryAt} future />
          ).
        </>
      ) : (
        <>Server fetching is off.</>
      )}{' '}
      Use the bookmarklet on Moxfield to send changes.{' '}
      <Link href={routes.setup()} className="font-medium text-accent hover:underline">
        Setup
      </Link>
    </p>
  );
}
