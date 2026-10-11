/**
 * `POST /api/capture/form`: target of the same-tab bookmarklet (phones and in-app
 * browsers, where popups are blocked). The bookmarklet submits a hidden form from the
 * Moxfield deck page with two fields: `token`, the user's bookmarklet key, and `payload`,
 * the capture payload (the envelope JSON, compressed as described in
 * `capture-codec-protocol.ts`, or plain). The payload is decoded, within hard size limits,
 * only once the key is accepted. The deck goes into the key owner's workspace, and the
 * browser goes on to the deck page through the sign-in hand-off (below); a capture that
 * cannot be used leads to the paste form instead, with `error=too-large` (over the size
 * limits) or `error=invalid` (damaged, or not a Moxfield deck).
 *
 * Authentication is the **bookmarklet key**, a per-user secret: it decides which
 * workspace receives the capture, and requests without a valid key get 403, with a page
 * that asks the user to create a new bookmarklet. What the key does not prove is that
 * the browser's user ran it: any member can post their own valid key from any web page.
 * Such a post can only ever add a deck to the key owner's own workspace, so it is
 * harmless here; and it never changes who the browser is signed in as without asking
 * (see the hand-off below).
 *
 * The `Origin` header cannot authenticate either. A real end-to-end test against
 * https://moxfield.com showed the post arriving with `Origin: null` and
 * `Sec-Fetch-Site: cross-site`: under the default referrer policy, browsers hide the
 * origin of a non-CORS request that goes from https to http (git-moxfield on
 * http://localhost or a LAN address). Any third-party site can produce `Origin: null`
 * too, so the origin check that remains (`null`, absent, or a configured capture origin;
 * any other explicit origin is rejected) is defence in depth only.
 *
 * Signing in: the session cookie is `SameSite=Lax`, so the browser does not send it with
 * this cross-site POST, and the endpoint cannot tell whether the browser is already
 * signed in. It starts a pending hand-off instead, sets it as the hand-off cookie and
 * redirects (303) through `/api/auth/handoff`. That top-level GET carries the browser's
 * own session cookie again: a browser signed in as the key's owner goes straight on to
 * the deck page; any other browser (signed out, or signed in as someone else) is asked
 * first, on a page of this app, whether to sign in as the key's owner.
 *
 * Decision: same-tab captures **track untracked decks automatically**. The popup flow
 * asks for confirmation before tracking, but here the request is a top-level form
 * navigation: confirming would require keeping the untrusted payload somewhere
 * (server state or the URL) between two requests. Auto-tracking is acceptable because
 * the deck only ever lands in the key owner's own workspace (a forged post can only add
 * a deck to the forger's own account), and tracking only stores the observed deck; no
 * version is committed without the user.
 */
import type { NextRequest } from 'next/server';

import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import { CAPTURE_FORM_FIELD, CAPTURE_FORM_TOKEN_FIELD } from '@/integrations/moxfield/capture-protocol';
import { routes } from '@/lib/routes';
import { servicesFor } from '@/server/access';
import { getAuthService } from '@/server/auth';
import { handoffCookie } from '@/server/auth/cookie-spec';
import { appendCookie, requestCookieSecurity } from '@/server/auth/cookies';
import { HANDOFF_PATH } from '@/server/auth/paths';
import type { StartedHandoff } from '@/server/auth/types';
import { getConfig } from '@/server/config';
import { createLogger } from '@/server/logger';

import { classifyRejectedCapture } from '../errors';
import { describeRejectedKey, isAcceptableCaptureOrigin } from '../form-guard';
import { CAPTURE_FORM_BODY_LIMIT, declaredTooLarge, readBodyLimited } from '../read-body';

import { captureRejectedResponse } from './forbidden-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api/capture/form');

const FORM_CONTENT_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)(\s*;|$)/i;

/** 303 to a same-origin path; a relative `Location` keeps working behind reverse proxies. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * Redirects through the hand-off route to `target`, carrying the pending hand-off in its
 * cookie: once the key is accepted, every answer goes through the hand-off.
 */
function handOff(request: NextRequest, started: StartedHandoff, target: string): Response {
  const response = seeOther(`${HANDOFF_PATH}?next=${encodeURIComponent(target)}`);
  return appendCookie(response, handoffCookie(started.handoff, new Date(), requestCookieSecurity(request)));
}

export async function POST(request: NextRequest): Promise<Response> {
  const origin = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  const { captureAllowedOrigins } = getConfig();
  if (!isAcceptableCaptureOrigin(origin, captureAllowedOrigins)) {
    log.warn('Rejected same-tab capture from an unexpected origin', {
      origin,
      secFetchSite,
      allowed: captureAllowedOrigins,
    });
    return captureRejectedResponse('origin');
  }

  const contentType = request.headers.get('content-type') ?? '';
  if (!FORM_CONTENT_TYPES.test(contentType)) {
    return new Response('Unsupported content type.\n', {
      status: 415,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  if (declaredTooLarge(request.headers, CAPTURE_FORM_BODY_LIMIT))
    return seeOther(routes.capturePaste({ error: 'too-large' }));
  const body = await readBodyLimited(request, CAPTURE_FORM_BODY_LIMIT);
  if (!body.ok)
    return seeOther(routes.capturePaste({ error: body.reason === 'too-large' ? 'too-large' : 'invalid' }));

  let form: FormData;
  try {
    // Parse the already size-checked bytes with the platform's form parser.
    form = await new Response(body.bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return seeOther(routes.capturePaste({ error: 'invalid' }));
  }

  const key = form.get(CAPTURE_FORM_TOKEN_FIELD);
  const auth = await getAuthService();
  const started = await auth.startKeyHandoff(key, request.headers.get('user-agent'));
  if (started === null) {
    // Never log the key itself, only why it was not accepted.
    log.warn('Rejected same-tab capture without a valid bookmarklet key', {
      origin,
      secFetchSite,
      key: describeRejectedKey(key),
    });
    return captureRejectedResponse('key');
  }

  const payload = form.get(CAPTURE_FORM_FIELD);
  if (typeof payload !== 'string' || payload.trim() === '') {
    return handOff(request, started, routes.capturePaste({ error: 'invalid' }));
  }

  try {
    const services = await servicesFor(started.user);
    const outcome = await services.ingestCapture({
      data: await decodeCapturePayload(payload),
      method: 'browser-capture',
      track: true,
    });
    if (outcome.status === 'ingested') {
      return handOff(request, started, routes.deck(outcome.deckId, { captured: true }));
    }
    return handOff(request, started, routes.capturePaste({ error: 'failed' }));
  } catch (error) {
    const rejected = classifyRejectedCapture(error);
    if (rejected !== null)
      return handOff(request, started, routes.capturePaste({ error: rejected.formError }));
    log.error('Same-tab capture failed', { error, userId: started.user.id });
    return handOff(request, started, routes.capturePaste({ error: 'failed' }));
  }
}
