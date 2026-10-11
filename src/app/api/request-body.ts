/**
 * Bounded reading of request bodies for the route handlers that take forms or JSON.
 * Bodies are untrusted and may be large, so they are read incrementally and abandoned as
 * soon as they exceed the limit, instead of being buffered whole by `request.text()`.
 * Each route maps {@link BodyFailure} to its own kind of answer and picks its limit.
 */
import 'server-only';

import { readStreamLimited } from '@/core/streams';

export type BodyReadResult =
  { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: 'too-large' | 'unreadable' };

/** Why a body could not be used: the wrong media type, over the limit, failing mid-read, or not parsing. */
export type BodyFailure = 'unsupported-type' | 'too-large' | 'unreadable' | 'malformed';

const FORM_CONTENT_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)(\s*;|$)/i;
const JSON_CONTENT_TYPE = /^application\/json(\s*;|$)/i;

/** Rejects early when `Content-Length` already announces a body over the limit. */
export function declaredTooLarge(headers: Headers, limit: number): boolean {
  const declared = headers.get('content-length');
  if (declared === null) return false;
  const length = Number(declared);
  return Number.isFinite(length) && length > limit;
}

/** Reads the whole body as bytes, counting while reading; gives up past `limit` bytes. */
export async function readBodyLimited(request: Request, limit: number): Promise<BodyReadResult> {
  if (request.body === null) return { ok: true, bytes: new Uint8Array() };
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readStreamLimited(request.body, limit);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return bytes === null ? { ok: false, reason: 'too-large' } : { ok: true, bytes };
}

/** The bytes of a body of the given media type, within `limit` bytes. */
async function readTypedBody(
  request: Request,
  limit: number,
  mediaType: RegExp,
): Promise<{ ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: BodyFailure }> {
  if (!mediaType.test(request.headers.get('content-type') ?? '')) {
    return { ok: false, reason: 'unsupported-type' };
  }
  if (declaredTooLarge(request.headers, limit)) return { ok: false, reason: 'too-large' };
  return readBodyLimited(request, limit);
}

/** A submitted form (urlencoded or multipart) of at most `limit` bytes. */
export async function readFormBody(
  request: Request,
  limit: number,
): Promise<{ ok: true; form: FormData } | { ok: false; reason: BodyFailure }> {
  const body = await readTypedBody(request, limit, FORM_CONTENT_TYPES);
  if (!body.ok) return body;
  try {
    // Parse the already size-checked bytes with the platform's form parser.
    const headers = { 'content-type': request.headers.get('content-type') ?? '' };
    return { ok: true, form: await new Response(body.bytes, { headers }).formData() };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

/** A JSON document of at most `limit` bytes. */
export async function readJsonBody(
  request: Request,
  limit: number,
): Promise<{ ok: true; json: unknown } | { ok: false; reason: BodyFailure }> {
  const body = await readTypedBody(request, limit, JSON_CONTENT_TYPE);
  if (!body.ok) return body;
  try {
    return { ok: true, json: JSON.parse(new TextDecoder().decode(body.bytes)) as unknown };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
