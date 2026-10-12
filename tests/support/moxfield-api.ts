/**
 * What Moxfield's API answers, in every failure mode the tests simulate, independent of
 * the HTTP stack that serves it: the fake `fetch` of in-process tests
 * (`FakeMoxfieldApi`) and the mock Moxfield server of the e2e suite both answer through
 * {@link answerMoxfieldApi}. Pure and free of test-runner imports.
 */

/**
 * Failure modes of the mock API (the deck page and the control API always work):
 *
 * - `ok`: every request is answered normally.
 * - `blocked`: like Cloudflare's bot protection, requests that do not come from a browser
 *   get `403 text/html` with a `cf-ray` header. Browser requests (a `Mozilla/…` User-Agent
 *   plus the `Sec-Fetch-Site` header) still succeed, as on the real site, so the
 *   bookmarklet keeps working while server fetches are blocked.
 * - `rate-limited`: `429` with `Retry-After: 30` for everyone.
 * - `down`: `502` for everyone.
 * - `primer-down`: only the primer endpoint fails, with `503`.
 */
export const MOCK_MODES = ['ok', 'blocked', 'rate-limited', 'down', 'primer-down'] as const;
export type MockMode = (typeof MOCK_MODES)[number];

/** Who asks: a browser (a page of the user's) or a server-side client such as git-moxfield. */
export type MockClientKind = 'browser' | 'server';

/** A complete HTTP answer. */
export interface ApiAnswer {
  status: number;
  body: string;
  contentType: string;
  headers?: Record<string, string>;
}

export interface ApiContext {
  mode: MockMode;
  client: MockClientKind;
  /** The `cf-ray` header of a block page. */
  rayId: string;
  /** The deck API's payload for the deck with this public id, `undefined` when there is none. */
  deck(publicId: string): unknown;
  /** The primer API's payload for the deck with this internal id, `undefined` when there is none. */
  primer(internalId: string): unknown;
}

/** The URL a `fetch` input (a string, a `URL` or a `Request`) asks for. */
export function requestUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function json(status: number, body: unknown, headers?: Record<string, string>): ApiAnswer {
  return { status, body: JSON.stringify(body), contentType: 'application/json; charset=utf-8', headers };
}

function text(status: number, body: string): ApiAnswer {
  return { status, body, contentType: 'text/plain; charset=utf-8' };
}

const NOT_FOUND = json(404, { type: 'about:blank', title: 'Not Found', status: 404 });

/** The failure the mode produces for a request to `endpoint`, or `null` to serve it normally. */
function modeFailure(ctx: ApiContext, endpoint: 'deck' | 'primer'): ApiAnswer | null {
  switch (ctx.mode) {
    case 'ok':
      return null;
    case 'blocked':
      if (ctx.client === 'browser') return null;
      return {
        status: 403,
        contentType: 'text/html; charset=UTF-8',
        headers: { 'cf-ray': ctx.rayId, server: 'cloudflare' },
        body:
          '<!DOCTYPE html><html lang="en"><head><title>Attention Required! | Cloudflare</title></head>' +
          '<body><h1>Sorry, you have been blocked</h1><p>You are unable to access moxfield.com (mock).</p></body></html>',
      };
    case 'rate-limited':
      return json(429, { title: 'Too Many Requests', status: 429 }, { 'retry-after': '30' });
    case 'down':
      return text(502, 'Bad Gateway');
    case 'primer-down':
      // Plain text without cf-ray, so the adapter sees an outage rather than a block.
      return endpoint === 'primer' ? text(503, 'Service Unavailable') : null;
  }
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The answer to a request for `path` (a URL path, `/v3/decks/all/<publicId>` or
 * `/v1/decks/<internalId>/primer`), or `null` when the path is not one of the API's.
 */
export function answerMoxfieldApi(path: string, ctx: ApiContext): ApiAnswer | null {
  const deckMatch = /^\/v3\/decks\/all\/([^/]+)$/.exec(path);
  if (deckMatch?.[1] !== undefined) {
    const payload = ctx.deck(decode(deckMatch[1]));
    return modeFailure(ctx, 'deck') ?? (payload === undefined ? NOT_FOUND : json(200, payload));
  }
  const primerMatch = /^\/v1\/decks\/([^/]+)\/primer$/.exec(path);
  if (primerMatch?.[1] !== undefined) {
    const payload = ctx.primer(decode(primerMatch[1]));
    return modeFailure(ctx, 'primer') ?? (payload === undefined ? NOT_FOUND : json(200, payload));
  }
  return null;
}
