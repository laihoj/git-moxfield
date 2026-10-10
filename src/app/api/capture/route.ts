/**
 * `POST /api/capture`: receives a deck captured by the user's browser (bookmarklet
 * popup flow) or pasted manually on `/capture`, as same-origin JSON:
 *
 *     { "payload": <envelope JSON string | object>, "method": "browser-capture" | "manual-paste", "track": boolean }
 *
 * Answers with the `CaptureOutcome` as JSON, `400 { error }` for unusable data, `403`
 * for cross-origin requests, `413` for oversized bodies and `415` for other content
 * types. The payload is untrusted; the service validates and normalizes it.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { createLogger } from '@/server/logger';
import { getServices, isServiceError } from '@/server/services';

import { ownOrigins } from '../../request-origin';

import { isUnusableCaptureError } from './errors';
import { CAPTURE_JSON_BODY_LIMIT, declaredTooLarge, readBodyLimited } from './read-body';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api/capture');

const bodySchema = z.object({
  payload: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  method: z.enum(['browser-capture', 'manual-paste']),
  track: z.boolean(),
});

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
}

/** Same-origin check: `Origin` must be one of the app's own origins; without it, `Sec-Fetch-Site` must say so. */
function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return ownOrigins(request.headers, request.url).has(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!isSameOrigin(request)) return errorResponse(403, 'Captures must be sent from git-moxfield itself.');

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

  try {
    const outcome = await getServices().ingestCapture({
      data: input.data.payload,
      method: input.data.method,
      track: input.data.track,
    });
    return Response.json(outcome, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (isUnusableCaptureError(error)) return errorResponse(400, error.message);
    if (isServiceError(error)) return errorResponse(error.code === 'not-found' ? 404 : 400, error.message);
    log.error('Capture failed', { error });
    return errorResponse(500, 'Something went wrong while importing the deck. Please try again.');
  }
}
