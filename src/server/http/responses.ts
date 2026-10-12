/**
 * Responses that route handlers and the proxy build alike. Pure (they only construct
 * `Response` objects), so the edge proxy can import them. Everything that is answered
 * to a request is `no-store` unless the caller says otherwise.
 */

/** 303 to a same-origin path; a relative `Location` keeps working behind reverse proxies. */
export function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

/**
 * A plain-text response: `text` and a trailing newline. `headers` are added to the
 * defaults (`content-type`, `cache-control: no-store`) and may replace them.
 */
export function plainText(status: number, text: string, headers?: HeadersInit): Response {
  return new Response(`${text}\n`, {
    status,
    headers: withDefaults(headers, { 'content-type': 'text/plain; charset=utf-8' }),
  });
}

/** A JSON response (`Response.json`), `no-store` unless `init.headers` say otherwise. */
export function jsonResponse(body: unknown, init: { status?: number; headers?: HeadersInit } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: withDefaults(init.headers, {}) });
}

function withDefaults(headers: HeadersInit | undefined, defaults: Record<string, string>): Headers {
  const result = new Headers({ ...defaults, 'cache-control': 'no-store' });
  new Headers(headers).forEach((value, name) => {
    result.set(name, value);
  });
  return result;
}
