/**
 * `POST /api/capture/form`: target of the same-tab bookmarklet (phones and in-app
 * browsers, where popups are blocked). The bookmarklet submits a hidden form from the
 * Moxfield deck page with two fields: `token`, this installation's capture token, and
 * `payload`, the capture envelope JSON. On success the browser is redirected (303) to
 * the deck page.
 *
 * Authentication (CSRF protection) is the **capture token**: a per-installation secret
 * (see `DeckServices.getCaptureToken`) that git-moxfield bakes into the same-tab
 * bookmarklet on its setup page. Requests without the right token get 403, with a page
 * that asks the user to reinstall the bookmarklet.
 *
 * The `Origin` header cannot do this job. A real end-to-end test against
 * https://moxfield.com showed the post arriving with `Origin: null` and
 * `Sec-Fetch-Site: cross-site`: under the default referrer policy, browsers hide the
 * origin of a non-CORS request that goes from https to http (git-moxfield on
 * http://localhost or a LAN address). Any third-party site can produce `Origin: null`
 * too, so the origin check that remains (`null`, absent, or a configured capture origin;
 * any other explicit origin is rejected) is defence in depth only.
 *
 * Decision: same-tab captures **track untracked decks automatically**. The popup flow
 * asks for confirmation before tracking, but here the request is a top-level form
 * navigation: confirming would require keeping the untrusted payload somewhere
 * (server state or the URL) between two requests. Auto-tracking is acceptable because
 * the user explicitly ran the bookmarklet on that very deck, and the capture token
 * proves the request came from the user's own bookmarklet, not from a third-party site.
 * Tracking only stores the observed deck; no version is committed without the user.
 */
import type { NextRequest } from 'next/server';

import { CAPTURE_FORM_FIELD, CAPTURE_FORM_TOKEN_FIELD } from '@/integrations/moxfield/capture-protocol';
import { routes } from '@/lib/routes';
import { createLogger } from '@/server/logger';
import { getServices } from '@/server/services';

import { isUnusableCaptureError } from '../errors';
import { isAcceptableCaptureOrigin, isValidCaptureToken } from '../form-guard';
import { CAPTURE_FORM_BODY_LIMIT, declaredTooLarge, readBodyLimited } from '../read-body';

import { captureRejectedResponse } from './forbidden-page';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api/capture/form');

const FORM_CONTENT_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)(\s*;|$)/i;

/** Error codes understood by the `/capture` page (`?error=`); never the payload itself. */
type FormError = 'invalid' | 'too-large' | 'failed';

/** 303 to a same-origin path; a relative `Location` keeps working behind reverse proxies. */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

function failed(error: FormError): Response {
  return seeOther(`/capture?mode=paste&error=${error}`);
}

export async function POST(request: NextRequest): Promise<Response> {
  const services = getServices();
  const origin = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  const { captureAllowedOrigins } = services.getSetupInfo();
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
  if (declaredTooLarge(request.headers, CAPTURE_FORM_BODY_LIMIT)) return failed('too-large');
  const body = await readBodyLimited(request, CAPTURE_FORM_BODY_LIMIT);
  if (!body.ok) return failed(body.reason === 'too-large' ? 'too-large' : 'invalid');

  let form: FormData;
  try {
    // Parse the already size-checked bytes with the platform's form parser.
    form = await new Response(body.bytes, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return failed('invalid');
  }

  const token = form.get(CAPTURE_FORM_TOKEN_FIELD);
  if (!isValidCaptureToken(token, services.getCaptureToken())) {
    // Never log the token itself, only whether one was sent.
    log.warn('Rejected same-tab capture without a valid capture token', {
      origin,
      secFetchSite,
      token: token === null ? 'missing' : 'wrong',
    });
    return captureRejectedResponse('token');
  }

  const payload = form.get(CAPTURE_FORM_FIELD);
  if (typeof payload !== 'string' || payload.trim() === '') return failed('invalid');

  try {
    const outcome = await services.ingestCapture({
      data: payload,
      method: 'browser-capture',
      track: true,
    });
    if (outcome.status === 'ingested') return seeOther(routes.deck(outcome.deckId, { captured: true }));
    return failed('failed');
  } catch (error) {
    if (isUnusableCaptureError(error)) return failed('invalid');
    log.error('Same-tab capture failed', { error });
    return failed('failed');
  }
}
