import { Alert } from '@/components/ui/alert';
import { Card, CardHeader } from '@/components/ui/card';
import { InlineCode } from '@/components/ui/inline-code';
import { MetaItem, MetaList } from '@/components/ui/meta-list';
import { ClockTime, RelativeTime } from '@/components/ui/relative-time';
import { pluralize } from '@/lib/format';
import type { ServerFetchAdminDTO } from '@/server/access';

import { ResumeServerFetch } from './resume-server-fetch';

/** `2 s`, `1.5 s`. */
function seconds(ms: number): string {
  return `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} s`;
}

/**
 * Server fetching from Moxfield on the Admin page (ADR 0009): whether it runs, the request
 * spacing every instance keeps together, Moxfield's 429s, and Resume after a pause.
 */
export function ServerFetchCard({ info }: { info: ServerFetchAdminDTO }) {
  const { limiter } = info;
  const { status } = limiter;
  return (
    <Card as="section" aria-labelledby="server-fetch-heading" className="flex flex-col gap-4">
      <CardHeader
        id="server-fetch-heading"
        title="Server fetching from Moxfield"
        description={
          info.mode === 'off'
            ? 'Off (MOXFIELD_SERVER_FETCH=off): decks arrive through the bookmarklet only.'
            : `Refresh and commits fetch from Moxfield${limiter.currentIntervalMs > 0 ? `, all servers together at most one request every ${seconds(limiter.currentIntervalMs)}` : ''}. Nothing fetches in the background.`
        }
      />
      {status.state === 'paused' && (
        <Alert tone="warn" title="Paused until you resume it" actions={<ResumeServerFetch />}>
          <p>{status.reason}</p>
          <p className="mt-1 text-muted">
            Since <ClockTime value={status.pausedAt} /> (<RelativeTime value={status.pausedAt} />
            ). Moxfield answers 429 before it refuses, so a refusal may mean the deck is private, or that
            Moxfield is refusing this app.
          </p>
        </Alert>
      )}
      {status.state === 'rate-limited' && (
        <Alert tone="warn" title="Moxfield asked to slow down">
          <p>
            Every server fetch waits until <ClockTime value={status.retryAt} /> (
            <RelativeTime value={status.retryAt} future />
            ), then runs at half speed for a while. This ends on its own.
          </p>
        </Alert>
      )}
      {info.userAgentWarning !== null && (
        <Alert tone="error" title="The Moxfield User-Agent should not be configured here">
          {info.userAgentWarning}
        </Alert>
      )}
      <MetaList aria-label="Server fetching" className="text-sm text-muted">
        <MetaItem>
          {info.userAgentConfigured ? (
            'Moxfield-issued User-Agent configured'
          ) : (
            <>
              No <InlineCode>MOXFIELD_USER_AGENT</InlineCode>
            </>
          )}
        </MetaItem>
        <MetaItem>
          {limiter.slowedUntil === null ? (
            <>
              {limiter.intervalMs > 0
                ? `Interval ${seconds(limiter.intervalMs)}`
                : 'No interval (not Moxfield’s API)'}
            </>
          ) : (
            <>
              Interval doubled to {seconds(limiter.currentIntervalMs)} until{' '}
              <ClockTime value={limiter.slowedUntil} />
            </>
          )}
        </MetaItem>
        <MetaItem>
          {limiter.lastRateLimitedAt === null ? (
            'Never rate limited'
          ) : (
            <>
              {pluralize(limiter.rateLimitCount, '429 answer')}, the last{' '}
              <RelativeTime value={limiter.lastRateLimitedAt} />
            </>
          )}
        </MetaItem>
      </MetaList>
    </Card>
  );
}
