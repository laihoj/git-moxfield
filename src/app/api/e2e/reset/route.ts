/**
 * `POST /api/e2e/reset`: reset hook of the end-to-end suite, answered only when
 * `GIT_MOXFIELD_E2E=true` (set by `playwright.config.ts`); otherwise 404, as if the route
 * did not exist.
 *
 * It resets state that tests cannot reset through the UI or the mock Moxfield: the
 * installation-wide Moxfield request limiter (ADR 0009), whose pause after a refusal lasts
 * until an admin resumes it and whose 429 backoff lasts minutes. Without this hook the
 * journey that provokes a block would leave server fetching paused for every test after
 * it. Tests call it before each test, together with resetting the mock
 * (`tests/e2e/support/fixtures.ts`). Accounts are not reset: every test signs in a user of
 * its own (`POST /api/e2e/session`).
 */
import { getMoxfieldLimiter } from '@/server/sources';

import { e2eDisabledResponse } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(): Promise<Response> {
  const disabled = e2eDisabledResponse();
  if (disabled !== null) return disabled;
  await getMoxfieldLimiter().reset();
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}
