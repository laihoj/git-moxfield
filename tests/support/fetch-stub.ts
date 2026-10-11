/**
 * A stand-in for the global `fetch` in tests of the components that post JSON to the app.
 * Undo it with `vi.unstubAllGlobals()` after the test.
 */
import { vi } from 'vitest';

type FetchMock = ReturnType<typeof vi.fn>;

/** Replaces the global `fetch` with a mock that answers every request with `status` and `body` as JSON. */
export function stubJsonFetch(status: number, body: unknown): FetchMock {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The JSON body of the first request that `fetchMock` received. */
export function sentJsonBody(fetchMock: FetchMock): unknown {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof init?.body !== 'string') throw new Error('No JSON body was sent');
  return JSON.parse(init.body) as unknown;
}
