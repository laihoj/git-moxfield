/**
 * `GET /api/e2e/setup-code`: the setup code of an unclaimed installation, which a real
 * operator reads from the server log, for the end-to-end claim journey. Answers
 * `{ "setupCode": "XXXX-XXXX-XXXX" }`, or `{ "setupCode": null }` once a user exists.
 * Test-only: 404 unless `GIT_MOXFIELD_E2E=true` (see `../guard.ts`).
 */
import { getAuthService } from '@/server/auth';

import { e2eDisabledResponse } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const disabled = e2eDisabledResponse();
  if (disabled !== null) return disabled;
  const auth = await getAuthService();
  return Response.json({ setupCode: await auth.setupCode() }, { headers: { 'cache-control': 'no-store' } });
}
