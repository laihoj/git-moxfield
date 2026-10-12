/** What a user makes from a session (keys, device links, share links) needs that session to be active. */
import 'server-only';

import type { SessionUser } from '@/server/auth/types';
import type { Repositories, SessionRecord } from '@/server/repositories';
import { ServiceError } from '@/server/services/errors';

/**
 * The asking session of `user`, still active at `at`. Call it inside the transaction that
 * stores what is made. @throws {ServiceError} `forbidden` when the session has ended.
 */
export async function requireActiveSession(
  repos: Repositories,
  user: SessionUser,
  at: string,
): Promise<SessionRecord> {
  const session = await repos.sessions.getActive(user.id, user.sessionId, at);
  if (session === null) throw new ServiceError('forbidden', 'You were signed out. Sign in again.');
  return session;
}
