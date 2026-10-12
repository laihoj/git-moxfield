/**
 * `POST /api/e2e/invite`: issues an invite from the command line that expires in
 * `expiresInSeconds`, for journeys in which an invite expires while a page shows it.
 * Test-only: it answers 404 unless `GIT_MOXFIELD_E2E=true` (see `../guard.ts`), and only
 * to the suite's own JSON requests.
 *
 * Body: `{ "note": string, "expiresInSeconds": number }` (1–600 seconds). Answers
 * `{ "expiresAt" }`. The invite is issued by an auth service whose clock is set back, so
 * it is an ordinary invite that was created a lifetime ago, less the seconds left.
 */
import { z } from 'zod';

import { createAuthService, INVITE_LIFETIME_MS, SYSTEM_ACTOR } from '@/server/auth';
import { getConfig } from '@/server/config';
import { getDb } from '@/server/db/client';
import { jsonResponse } from '@/server/http/responses';

import { e2eDisabledResponse, e2eRequestRefusal } from '../guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  note: z.string(),
  expiresInSeconds: z.number().int().min(1).max(600),
});

export async function POST(request: Request): Promise<Response> {
  const refused = e2eDisabledResponse() ?? e2eRequestRefusal(request);
  if (refused !== null) return refused;
  const input = bodySchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return jsonResponse({ error: 'Expected { note, expiresInSeconds }.' }, { status: 400 });

  const issuedAt = Date.now() - INVITE_LIFETIME_MS + input.data.expiresInSeconds * 1000;
  const auth = createAuthService({ db: await getDb(), config: getConfig(), now: () => new Date(issuedAt) });
  const invite = await auth.createInvite(SYSTEM_ACTOR, { role: 'member', note: input.data.note });
  return jsonResponse({ expiresAt: invite.expiresAt });
}
