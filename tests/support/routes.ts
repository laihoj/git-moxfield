/**
 * Helpers for route handler tests: requests with cookies, and the cookies a response sets.
 */
import { NextRequest } from 'next/server';

export interface SetCookie {
  value: string;
  /** Lower-cased attribute names, e.g. `path`, `max-age`, `httponly`, `samesite`, `secure`. */
  attributes: Record<string, string | true>;
}

/** The cookies a response sets, by name. */
export function setCookies(response: Response): Map<string, SetCookie> {
  const cookies = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...rest] = header.split(';').map((part) => part.trim());
    const separator = pair.indexOf('=');
    const attributes: Record<string, string | true> = {};
    for (const attribute of rest) {
      const equals = attribute.indexOf('=');
      if (equals === -1) attributes[attribute.toLowerCase()] = true;
      else attributes[attribute.slice(0, equals).toLowerCase()] = attribute.slice(equals + 1);
    }
    cookies.set(pair.slice(0, separator), { value: pair.slice(separator + 1), attributes });
  }
  return cookies;
}

/** A request to the app at http://localhost:3000 with the given cookies. */
export function appRequest(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    body?: BodyInit;
  } = {},
): NextRequest {
  const headers = new Headers({ host: 'localhost:3000', ...init.headers });
  const cookies = Object.entries(init.cookies ?? {});
  if (cookies.length > 0)
    headers.set('cookie', cookies.map(([name, value]) => `${name}=${value}`).join('; '));
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}
