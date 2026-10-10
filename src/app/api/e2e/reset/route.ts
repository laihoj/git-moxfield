/**
 * `POST /api/e2e/reset`: reset hook of the end-to-end suite, answered only when
 * `GIT_MOXFIELD_E2E=true` (set by `playwright.config.ts`); otherwise 404, as if the route
 * did not exist.
 *
 * It resets in-process state that tests cannot reset through the UI, the database or
 * the mock Moxfield: the pause of server-side fetching after Moxfield blocked a request.
 * The pause lasts `MOXFIELD_BLOCK_BACKOFF_SECONDS` (an hour by default) for the whole
 * process, so without this hook the journey that provokes a block would leave server
 * fetching paused for every test after it. Tests call it before each test, together
 * with resetting the mock (`tests/e2e/support/fixtures.ts`).
 */
import { getConfig } from '@/server/config';
import { getDeckSourceRegistry } from '@/server/sources';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(): Response {
  if (getConfig().GIT_MOXFIELD_E2E !== true) {
    return new Response('Not found.\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  for (const source of getDeckSourceRegistry().all()) source.resumeServerFetch?.();
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
