/**
 * `next.config.ts` as Next.js's dev server reads it: every request whose URL carries a
 * link token (share links, device and recovery links, invites) is left out of the
 * request log, which prints URLs in full (ADR 0006, ADR 0007: tokens are never logged).
 * Checked with Next's own filter, so a change of either side cannot drift silently.
 */
import { ignoreLoggingIncomingRequests } from 'next/dist/server/dev/log-requests';
import { describe, expect, it } from 'vitest';

import { invitePath, loginLinkPath, sharedDeckPath } from '@/server/auth/paths';
import { generateToken } from '@/server/auth/tokens';

import nextConfig from '../../next.config';

/** Whether the dev server leaves a request for `url` out of its log. */
function ignored(url: string): boolean {
  return ignoreLoggingIncomingRequests(
    { url } as Parameters<typeof ignoreLoggingIncomingRequests>[0],
    nextConfig.logging === false ? undefined : nextConfig.logging,
  );
}

describe('the dev server’s request log', () => {
  it('never shows a link token', () => {
    const share = sharedDeckPath(generateToken('share'));
    for (const url of [
      share,
      `${share}/history?_rsc=1x2y3`,
      `${share}/versions/1/restore.txt`,
      loginLinkPath(generateToken('login')),
      invitePath(generateToken('invite')),
    ]) {
      expect(ignored(url), url).toBe(true);
    }
  });

  it('still shows every other request', () => {
    for (const url of ['/', '/decks/abc/history', '/signin', '/signin/bookmarklet', '/account']) {
      expect(ignored(url), url).toBe(false);
    }
  });
});
