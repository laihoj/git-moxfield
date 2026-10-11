/**
 * The app's own public origin, as seen by the browser. Used to bake the app URL into
 * bookmarklets and to verify same-origin requests to the capture endpoint.
 */
import 'server-only';

import { getConfig } from '@/server/config';

interface HeaderSource {
  get(name: string): string | null;
}

/** First value of a possibly comma-separated forwarding header. */
function firstValue(value: string | null): string | null {
  const first = value?.split(',')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

/**
 * The origin the request was addressed to, from `X-Forwarded-Host`/`Host` and
 * `X-Forwarded-Proto` (reverse proxies), or `null` when the headers are missing or
 * malformed. Only http(s) origins are returned.
 */
export function requestOrigin(
  headers: HeaderSource,
  fallbackProtocol: 'http' | 'https' = 'http',
): string | null {
  const host = firstValue(headers.get('x-forwarded-host')) ?? firstValue(headers.get('host'));
  if (host === null) return null;
  const forwardedProto = firstValue(headers.get('x-forwarded-proto'));
  const protocol =
    forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : fallbackProtocol;
  try {
    const url = new URL(`${protocol}://${host}`);
    // Reject anything beyond scheme://host[:port] (userinfo, paths smuggled into Host).
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.host !== host.toLowerCase()
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Public base URL of the app: `PUBLIC_APP_URL` when configured (e.g. a LAN address for
 * phones), otherwise the request's origin.
 */
export function publicAppUrl(headers: HeaderSource): string | null {
  const configured = getConfig().PUBLIC_APP_URL;
  if (configured !== undefined) return configured;
  return requestOrigin(headers);
}

/**
 * Every origin under which the app may legitimately be reached for this request: the
 * request origin and, when set, `PUBLIC_APP_URL`'s origin.
 */
export function ownOrigins(headers: HeaderSource, requestUrl: string): Set<string> {
  const origins = new Set<string>();
  try {
    origins.add(new URL(requestUrl).origin);
  } catch {
    // Ignore: Next.js always provides an absolute request URL.
  }
  const fromHeaders = requestOrigin(headers, requestUrl.startsWith('https:') ? 'https' : 'http');
  if (fromHeaders !== null) origins.add(fromHeaders);
  const configured = getConfig().PUBLIC_APP_URL;
  if (configured !== undefined) origins.add(new URL(configured).origin);
  return origins;
}

interface RequestLike {
  headers: HeaderSource;
  url: string;
}

/**
 * Whether a browser sent `request` from a page of this app (the CSRF check of endpoints
 * that act on the browser's cookies): `Origin` must be one of the app's own origins
 * ({@link ownOrigins}). When the browser hides the origin (no `Origin` header, or the
 * opaque `null`, which a same-origin form post sends under a `no-referrer` policy),
 * `Sec-Fetch-Site` must say `same-origin`: browsers set it themselves, so no other site
 * can claim it. A request with neither is refused.
 */
export function isSameOriginRequest(request: RequestLike): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== 'null') return ownOrigins(request.headers, request.url).has(origin);
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Whether a browser says `request` came from another site or origin: an `Origin` header
 * that is not one of the app's own origins, or a `Sec-Fetch-Site` other than
 * `same-origin` or `none` (typed into the address bar). Requests from programs, which
 * send neither header, are not cross-origin by this test.
 */
export function isCrossOriginBrowserRequest(request: RequestLike): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null && !ownOrigins(request.headers, request.url).has(origin)) return true;
  const site = request.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
}
