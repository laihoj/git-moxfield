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
  if (configured !== undefined) return configured.replace(/\/+$/, '');
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
