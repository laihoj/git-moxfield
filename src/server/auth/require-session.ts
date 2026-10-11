/**
 * The rule behind everything a user makes from a session (keys, device links, share
 * links): it inherits the session's lineage, so the session must still be active.
 */
import 'server-only';

import type { SessionUser } from '@/server/auth/types';
import type { Repositories, SessionRecord } from '@/server/repositories';
import { ServiceError } from '@/server/services/errors';

/**
 * The asking session of `user`, which must still be active at `at`: nothing is made for a
 * session that ended meanwhile (signed out everywhere, revoked key). Call it inside the
 * transaction that stores what is made.
 *
 * @throws {ServiceError} `forbidden` when the session is no longer active.
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
