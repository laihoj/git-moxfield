/**
 * `POST /api/e2e/session`: signs a test browser in as a brand-new user. Test-only: it
 * answers 404 unless `GIT_MOXFIELD_E2E=true` (see `../guard.ts`).
 *
 * Only `application/json` requests that no browser marks as cross-origin are accepted
 * (415 / 403 otherwise).
 *
 * Body (JSON, every field optional):
 *
 *     { "displayName"?: string, "role"?: "admin" | "member", "bookmarkletLabel"?: string }
 *
 * The user is created through the real invite flow (an invite from the command-line
 * actor, accepted at once), so the session is an ordinary one. The response sets the
 * session cookie and answers
 *
 *     { "user": { id, displayName, role, workspaceId },
 *       "sessionCookie": { name, value, expiresAt, secure },
 *       "bookmarklets"?: { popup, sameTab } }
 *
 * `sessionCookie` lets Playwright add the cookie to a browser context explicitly
 * (`tests/e2e/support/accounts.ts`); with `bookmarkletLabel`, a bookmarklet key is
 * created for the user and both bookmarklets are returned. Handing out secrets in a
 * response body is acceptable only because this route does not exist outside the suite.
 */
import { randomBytes } from 'node:crypto';

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { getAuthService, SYSTEM_ACTOR } from '@/server/auth';
import { cookieNames } from '@/server/auth/cookie-spec';
import { establishSessionOnResponse, requestCookieSecurity } from '@/server/auth/cookies';
import { parseToken } from '@/server/auth/tokens';
import type { BookmarkletsDTO } from '@/server/auth/types';

import { isCrossOriginBrowserRequest, publicAppUrl } from '../../../request-origin';
import { e2eDisabledResponse } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  displayName: z.string().optional(),
  role: z.enum(['admin', 'member']).optional(),
  bookmarkletLabel: z.string().optional(),
});

/** The media type of a `Content-Type` value, lower-cased, without parameters. */
function mediaType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: NextRequest): Promise<Response> {
  const disabled = e2eDisabledResponse();
  if (disabled !== null) return disabled;
  // Defence in depth: only the suite's own JSON requests (Node's fetch, which sends no
  // Origin), never a form or a "simple" request a web page could make.
  if (mediaType(request.headers.get('content-type')) !== 'application/json') {
    return Response.json({ error: 'Send application/json.' }, { status: 415 });
  }
  if (isCrossOriginBrowserRequest(request)) {
    return Response.json({ error: 'Cross-origin requests are refused.' }, { status: 403 });
  }

  const text = await request.text();
  let json: unknown = {};
  if (text.trim() !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      return badRequest('The body is not valid JSON.');
    }
  }
  const input = bodySchema.safeParse(json);
  if (!input.success) return badRequest('Expected { displayName?, role?, bookmarkletLabel? }.');

  const auth = await getAuthService();
  const invite = await auth.createInvite(SYSTEM_ACTOR, { role: input.data.role ?? 'member', note: 'e2e' });
  const token = parseToken('invite', invite.path.split('/').at(-1));
  const displayName = input.data.displayName ?? `Tester ${randomBytes(3).toString('hex')}`;
  const accepted = await auth.acceptInvite(token, displayName, request.headers.get('user-agent'));
  if (!accepted.ok) return badRequest(accepted.message);
  const { user, session } = accepted.signIn;

  let bookmarklets: BookmarkletsDTO | undefined;
  if (input.data.bookmarkletLabel !== undefined) {
    const appUrl = publicAppUrl(request.headers);
    if (appUrl === null) return badRequest('Set PUBLIC_APP_URL to build bookmarklets.');
    bookmarklets = (await auth.createBookmarkletKey(user, input.data.bookmarkletLabel, appUrl)).bookmarklets;
  }

  const secure = requestCookieSecurity(request);
  const response = Response.json(
    {
      user: { id: user.id, displayName: user.displayName, role: user.role, workspaceId: user.workspaceId },
      sessionCookie: {
        name: cookieNames(secure).session,
        value: session.token,
        expiresAt: session.expiresAt,
        secure,
      },
      ...(bookmarklets === undefined ? {} : { bookmarklets }),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
  return establishSessionOnResponse(request, response, session);
}
