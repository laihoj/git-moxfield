/**
 * The state of a one-time link (an invite or a device or recovery link) from its
 * timestamps. Pure: the services call it with the clock; the repositories enforce the
 * same rules in SQL when a link is used (`accept`, `consume`), which stays separate on purpose.
 */

/**
 * `used` before `revoked` (which includes a link whose creator is no longer an active
 * admin) before `expired`; otherwise the link can still be used. A link revoked once it
 * had expired (invites could be, before revoking refused that) is `expired`.
 *
 * @param creatorActive whether the creator is an active admin, or the command line.
 */
export function oneTimeLinkState(
  link: { usedAt: string | null; revokedAt: string | null; expiresAt: string },
  creatorActive: boolean,
  nowIso: string,
): 'used' | 'revoked' | 'expired' | 'pending' {
  if (link.usedAt !== null) return 'used';
  if ((link.revokedAt !== null && link.revokedAt < link.expiresAt) || !creatorActive) return 'revoked';
  if (link.expiresAt <= nowIso) return 'expired';
  return 'pending';
}
