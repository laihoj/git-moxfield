/**
 * `POST /api/capture`: receives a deck captured by the user's browser (bookmarklet
 * popup flow) or pasted manually on `/capture`, as same-origin JSON
 * (`CaptureRequestBody` in `capture-protocol.ts`):
 *
 *     { "payload": <envelope JSON string | object>, "method": "browser-capture" | "manual-paste",
 *       "track": boolean, "key"?: "gmk_…" }
 *
 * Who is capturing: the bookmarklet `key` when one is sent (popup mode hands it over with
 * the deck), otherwise the session cookie. A key signs the browser in as its owner (the
 * response sets the session cookie; a session of the same user is kept, not duplicated).
 * Unlike the same-tab form post, this needs no confirmation: the request is same-origin
 * (checked below), and the capture page only takes a key from its opener on a Moxfield
 * origin with a one-time nonce, so a third-party site cannot get another member's key
 * posted here. A wrong or revoked key is an error even when the browser has a session,
 * so a broken bookmarklet is noticed. The deck goes into the authenticated user's
 * workspace.
 *
 * A string `payload` is a capture payload (`capture-codec-protocol.ts`): compressed by the
 * bookmarklet or the capture page, or plain JSON. It is decoded, within hard size limits,
 * only once the request is authenticated; an object payload is used as it is.
 *
 * Answers with the `CaptureOutcome` as JSON; `401 { error, code }` without a valid key
 * or session, `400 { error }` for unusable data (including a payload that cannot be
 * decoded), `403` for cross-origin requests, `413` for oversized bodies and payloads and
 * `415` for other content types. The payload is untrusted; the service validates and
 * normalizes it. Keys and tokens are never logged.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import type { CaptureErrorBody } from '@/integrations/moxfield/capture-protocol';
import { servicesFor } from '@/server/access';
import { getAuthService } from '@/server/auth';
import { establishSessionOnResponse, readRequestSessionToken } from '@/server/auth/cookies';
import type { SessionUser, SignIn } from '@/server/auth/types';
import { createLogger } from '@/server/logger';
import { isServiceError } from '@/server/services';

import { isSameOriginRequest } from '../../request-origin';

import { classifyRejectedCapture } from './errors';
import { describeRejectedKey } from './form-guard';
import { CAPTURE_JSON_BODY_LIMIT, declaredTooLarge, readBodyLimited } from './read-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api/capture');

const bodySchema = z.object({
  payload: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  method: z.enum(['browser-capture', 'manual-paste']),
  track: z.boolean(),
  /** Bounded so that junk is rejected by shape; the auth service checks the exact format. */
  key: z.string().max(256).optional(),
});

function errorResponse(status: number, error: string, code?: CaptureErrorBody['code']): Response {
  const body: CaptureErrorBody = code === undefined ? { error } : { error, code };
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(request))
    return errorResponse(403, 'Captures must be sent from git-moxfield itself.');

  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return errorResponse(415, 'Send the capture as application/json.');
  }
  if (declaredTooLarge(request.headers, CAPTURE_JSON_BODY_LIMIT)) {
    return errorResponse(413, 'The deck data is too large.');
  }
  const body = await readBodyLimited(request, CAPTURE_JSON_BODY_LIMIT);
  if (!body.ok) {
    return body.reason === 'too-large'
      ? errorResponse(413, 'The deck data is too large.')
      : errorResponse(400, 'The request could not be read.');
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body.bytes));
  } catch {
    return errorResponse(400, 'The request is not valid JSON.');
  }
  const input = bodySchema.safeParse(json);
  if (!input.success) return errorResponse(400, 'The request is missing the deck data.');

  const auth = await getAuthService();
  const sessionToken = readRequestSessionToken(request);
  let user: SessionUser;
  let signIn: SignIn | null = null;
  if (input.data.key !== undefined) {
    signIn = await auth.signInWithKey(input.data.key, request.headers.get('user-agent'), {
      currentSessionToken: sessionToken,
    });
    if (signIn === null) {
      log.warn('Rejected a capture with an invalid bookmarklet key', {
        key: describeRejectedKey(input.data.key),
      });
      return errorResponse(
        401,
        'This bookmarklet is no longer valid (it was revoked or belongs to another git-moxfield). Create a new one on the Connect Moxfield page.',
        'invalid-key',
      );
    }
    user = signIn.user;
  } else {
    const resolved = await auth.resolveSession(sessionToken);
    if (resolved === null) {
      return errorResponse(
        401,
        'Sign in to git-moxfield first, then send the deck again.',
        'unauthenticated',
      );
    }
    user = resolved;
  }

  const response = await ingest(user, input.data);
  // The key signed the browser in, whatever became of the deck.
  return signIn === null ? response : establishSessionOnResponse(request, response, signIn.session);
}

/** Decodes the payload (after authentication: inflating costs CPU) and ingests it. */
async function ingest(user: SessionUser, input: z.infer<typeof bodySchema>): Promise<Response> {
  try {
    const data =
      typeof input.payload === 'string' ? await decodeCapturePayload(input.payload) : input.payload;
    const services = await servicesFor(user);
    const outcome = await services.ingestCapture({ data, method: input.method, track: input.track });
    return Response.json(outcome, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const rejected = classifyRejectedCapture(error);
    if (rejected !== null) return errorResponse(rejected.status, rejected.message);
    if (isServiceError(error)) return errorResponse(error.code === 'not-found' ? 404 : 400, error.message);
    log.error('Capture failed', { error, userId: user.id });
    return errorResponse(500, 'Something went wrong while importing the deck. Please try again.');
  }
}
