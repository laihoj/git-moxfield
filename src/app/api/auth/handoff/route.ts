/**
 * `/api/auth/handoff`: finishes signing a browser in after the same-tab bookmarklet's
 * cross-site form post (`POST /api/capture/form`).
 *
 * That post cannot see the browser's `SameSite=Lax` session cookie, so it started a
 * pending hand-off (hand-off cookie, five minutes; it signs nobody in by itself) and
 * redirected here.
 *
 * **Security.** Any member can make that post, with their own valid key, from any web
 * page (`Origin: null` is easy to produce), and the browser follows the redirect with
 * its own cookies. So a valid key proves which workspace received the capture, never
 * that this browser's user ran the bookmarklet. The principle: a hand-off may complete
 * on its own only when it changes nothing about who the browser is. Signing a browser
 * in, or switching it to another account (which signs the other account out of it), needs
 * the user's click on a page of this app, sent back as a same-origin POST.
 *
 * `GET ?next=<local path>` (the redirect from the capture endpoint; a top-level
 * navigation, so both cookies arrive):
 *
 * - the browser is signed in as the key's owner: that session is kept (and its cookie
 *   renewed), the hand-off ends, and it redirects (303) to `next`;
 * - otherwise (signed out, or signed in as someone else): nothing changes, the hand-off
 *   cookie is kept, and it redirects to `/signin/bookmarklet?next=…`, which names the
 *   account and the bookmarklet and asks;
 * - without a usable hand-off: it only redirects to `next`.
 *
 * `POST` (the confirmation page's form; same-origin only, 403 otherwise), field `intent`:
 *
 * - `confirm`: the hand-off becomes the browser's session, ending the session of another
 *   user the browser held, and it redirects to `next` (an expired hand-off goes back to
 *   the confirmation page, which says so);
 * - `cancel`: the hand-off ends; the browser's session, if any, is untouched; it
 *   redirects to `/`.
 *
 * `next` must be a path on this site (anything else goes to `/`, so this is no open
 * redirect). The hand-off cookie is cleared whenever the hand-off is settled.
 */
import type { NextRequest } from 'next/server';

import { getAuthService } from '@/server/auth';
import { expiredHandoffCookie } from '@/server/auth/cookie-spec';
import {
  appendCookie,
  establishSessionOnResponse,
  readRequestHandoffToken,
  readRequestSessionToken,
  requestCookieSecurity,
} from '@/server/auth/cookies';
import { handoffConfirmPath, safeRedirectPath } from '@/server/auth/paths';
import { plainText, seeOther } from '@/server/http/responses';

import { isSameOriginRequest } from '../../../request-origin';
import { readFormBody } from '../../request-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The confirmation form is two short fields; anything bigger is not it. */
const FORM_BODY_LIMIT = 8 * 1024;

/** `response`, clearing the hand-off cookie. */
function settled(request: NextRequest, response: Response): Response {
  return appendCookie(response, expiredHandoffCookie(requestCookieSecurity(request)));
}

export async function GET(request: NextRequest): Promise<Response> {
  const next = safeRedirectPath(request.nextUrl.searchParams.get('next'), '/');
  const handoffToken = readRequestHandoffToken(request);
  if (handoffToken === null) return settled(request, seeOther(next));

  const auth = await getAuthService();
  const outcome = await auth.completeHandoff(handoffToken, readRequestSessionToken(request));
  if (outcome === null) return settled(request, seeOther(next));
  if (outcome.kind === 'confirm') return seeOther(handoffConfirmPath(next));
  return establishSessionOnResponse(request, settled(request, seeOther(next)), outcome.signIn.session);
}

export async function POST(request: NextRequest): Promise<Response> {
  // The one CSRF defence that matters here: only this app's own page may confirm.
  if (!isSameOriginRequest(request)) {
    return plainText(403, 'Confirm signing in on git-moxfield’s own page.');
  }
  const body = await readFormBody(request, FORM_BODY_LIMIT);
  if (!body.ok) {
    switch (body.reason) {
      case 'unsupported-type':
        return plainText(415, 'Unsupported content type.');
      case 'too-large':
        return plainText(413, 'Request too large.');
      case 'unreadable':
      case 'malformed':
        return plainText(400, 'The request could not be read.');
    }
  }
  const { form } = body;

  const intent = form.get('intent');
  const rawNext = form.get('next');
  const next = safeRedirectPath(typeof rawNext === 'string' ? rawNext : null, '/');
  const auth = await getAuthService();
  const handoffToken = readRequestHandoffToken(request);

  if (intent === 'cancel') {
    await auth.cancelHandoff(handoffToken);
    return settled(request, seeOther('/'));
  }
  if (intent !== 'confirm') return plainText(400, 'Unknown request.');

  const signIn = await auth.confirmHandoff(handoffToken, readRequestSessionToken(request));
  // Expired or unknown: the confirmation page explains (it finds no hand-off any more).
  if (signIn === null) return settled(request, seeOther(handoffConfirmPath(next)));
  return establishSessionOnResponse(request, settled(request, seeOther(next)), signIn.session);
}
