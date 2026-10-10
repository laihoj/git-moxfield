import { describe, expect, it } from 'vitest';

import { createTestRepositories, expectRepositoryError } from '@tests/support/db';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-06-01T00:00:00.000Z';
const LATER = '2027-06-01T00:00:00.000Z';

function setup() {
  const { db, repos } = createTestRepositories();
  const mikko = repos.users.create({ displayName: 'Mikko', role: 'member' });
  const anna = repos.users.create({ displayName: 'Anna', role: 'member' });
  return { db, repos, mikko, anna };
}

describe('credential repository', () => {
  it('stores keys by hash only and finds the active ones with their user', () => {
    const { db, repos, mikko } = setup();
    const key = repos.credentials.createKey({ userId: mikko.id, label: ' Laptop ', secretHash: HASH_A });
    expect(key).toEqual({
      id: key.id,
      userId: mikko.id,
      kind: 'bookmarklet-key',
      label: 'Laptop',
      createdByCredentialId: null,
      createdAt: key.createdAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(key)).not.toContain(HASH_A);
    const stored = db.$client.prepare('SELECT secret_hash AS hash FROM credentials').all();
    expect(stored).toEqual([{ hash: HASH_A }]);

    expect(repos.credentials.findActiveBySecretHash(HASH_A)).toEqual({
      credential: key,
      user: mikko,
    });
    expect(repos.credentials.findActiveBySecretHash(HASH_B)).toBeNull();
  });

  it('rejects duplicate hashes, unknown users and empty labels', () => {
    const { repos, mikko } = setup();
    repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    expectRepositoryError(
      () => repos.credentials.createKey({ userId: mikko.id, label: 'Again', secretHash: HASH_A }),
      'conflict',
    );
    expectRepositoryError(
      () => repos.credentials.createKey({ userId: 'nope', label: 'Laptop', secretHash: HASH_B }),
      'not-found',
    );
    expectRepositoryError(
      () => repos.credentials.createKey({ userId: mikko.id, label: ' ', secretHash: HASH_B }),
      'invalid-input',
    );
  });

  it('stops finding revoked keys and keys of disabled users', () => {
    const { repos, mikko, anna } = setup();
    const mine = repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    const hers = repos.credentials.createKey({ userId: anna.id, label: 'Phone', secretHash: HASH_B });

    // Only the owner can revoke.
    expect(repos.credentials.revoke(anna.id, mine.id, NOW)).toBe(false);
    expect(repos.credentials.revoke(mikko.id, mine.id, NOW)).toBe(true);
    expect(repos.credentials.revoke(mikko.id, mine.id, NOW)).toBe(false);
    expect(repos.credentials.findActiveBySecretHash(HASH_A)).toBeNull();

    repos.users.setDisabled(anna.id, true);
    expect(repos.credentials.findActiveBySecretHash(HASH_B)).toBeNull();
    repos.users.setDisabled(anna.id, false);
    expect(repos.credentials.findActiveBySecretHash(HASH_B)?.credential.id).toBe(hers.id);
  });

  it('records which key a key was made through, and revokes all of a user’s keys at once', () => {
    const { repos, mikko, anna } = setup();
    const first = repos.credentials.createKey({ userId: mikko.id, label: 'First', secretHash: HASH_A });
    const second = repos.credentials.createKey({
      userId: mikko.id,
      label: 'Second',
      secretHash: HASH_B,
      createdByCredentialId: first.id,
    });
    const hers = repos.credentials.createKey({ userId: anna.id, label: 'Hers', secretHash: 'c'.repeat(64) });
    expect(second.createdByCredentialId).toBe(first.id);

    repos.credentials.revoke(mikko.id, first.id, NOW);
    expect(repos.credentials.revokeAllForUser(mikko.id, LATER)).toBe(1);
    expect(repos.credentials.revokeAllForUser(mikko.id, LATER)).toBe(0);
    expect(repos.credentials.listForUser(mikko.id)).toEqual([]);
    expect(repos.credentials.listForUser(anna.id).map((key) => key.id)).toEqual([hers.id]);
  });

  it('lists a user’s keys newest first, revoked ones on request, and records use', () => {
    const { repos, mikko } = setup();
    const first = repos.credentials.createKey({ userId: mikko.id, label: 'First', secretHash: HASH_A });
    const second = repos.credentials.createKey({ userId: mikko.id, label: 'Second', secretHash: HASH_B });
    repos.credentials.revoke(mikko.id, first.id, NOW);
    repos.credentials.touchLastUsed(second.id, NOW);

    expect(repos.credentials.listForUser(mikko.id).map((key) => [key.id, key.lastUsedAt])).toEqual([
      [second.id, NOW],
    ]);
    expect(repos.credentials.listForUser(mikko.id, { includeRevoked: true }).map((key) => key.id)).toEqual([
      second.id,
      first.id,
    ]);
  });
});

describe('session repository', () => {
  it('finds active sessions by token hash, never revoked or expired ones or disabled users’', () => {
    const { repos, mikko } = setup();
    const session = repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_A,
      createdVia: 'invite',
      userAgent: 'Firefox',
      expiresAt: LATER,
    });
    expect(JSON.stringify(session)).not.toContain(HASH_A);
    expect(repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toEqual({ session, user: mikko });
    // Expired exactly at expiresAt.
    expect(repos.sessions.findActiveByTokenHash(HASH_A, LATER)).toBeNull();

    repos.users.setDisabled(mikko.id, true);
    expect(repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toBeNull();
    repos.users.setDisabled(mikko.id, false);

    expect(repos.sessions.revokeByTokenHash(HASH_A, NOW)).toBe(true);
    expect(repos.sessions.revokeByTokenHash(HASH_A, NOW)).toBe(false);
    expect(repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toBeNull();
  });

  it('touches only sessions that are not revoked', () => {
    const { repos, mikko } = setup();
    const session = repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_A,
      createdVia: 'claim',
      expiresAt: NOW,
    });
    repos.sessions.touch(session.id, { lastSeenAt: NOW, expiresAt: LATER });
    expect(repos.sessions.findActiveByTokenHash(HASH_A, NOW)?.session).toMatchObject({
      lastSeenAt: NOW,
      expiresAt: LATER,
    });
    repos.sessions.revoke(mikko.id, session.id, NOW);
    repos.sessions.touch(session.id, { lastSeenAt: LATER });
    expect(repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
  });

  it('revokes one, all, or a credential’s sessions of one user only', () => {
    const { repos, mikko, anna } = setup();
    const key = repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    const make = (userId: string, n: number, credentialId: string | null = null) =>
      repos.sessions.create({
        userId,
        tokenHash: String(n).repeat(64).slice(0, 64),
        createdVia: credentialId === null ? 'invite' : 'bookmarklet',
        credentialId,
        expiresAt: LATER,
      });
    const viaKey1 = make(mikko.id, 1, key.id);
    const viaKey2 = make(mikko.id, 2, key.id);
    const viaInvite = make(mikko.id, 3);
    const hers = make(anna.id, 4);

    expect(repos.sessions.revoke(anna.id, viaInvite.id, NOW)).toBe(false);
    expect(
      repos.sessions.revokeAllForUser(mikko.id, NOW, { credentialId: key.id, exceptSessionId: viaKey2.id }),
    ).toBe(1);
    expect(
      repos.sessions
        .listActiveForUser(mikko.id, NOW)
        .map((s) => s.id)
        .sort(),
    ).toEqual([viaKey2.id, viaInvite.id].sort());
    expect(repos.sessions.revokeAllForUser(mikko.id, NOW)).toBe(2);
    expect(repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
    expect(repos.sessions.listActiveForUser(anna.id, NOW).map((s) => s.id)).toEqual([hers.id]);
    expect(viaKey1.credentialId).toBe(key.id);
  });

  it('keeps pending hand-offs apart from sessions until they are promoted, once', () => {
    const { repos, mikko } = setup();
    const key = repos.credentials.createKey({ userId: mikko.id, label: 'Phone', secretHash: HASH_A });
    const handoff = repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_B,
      createdVia: 'bookmarklet',
      credentialId: key.id,
      expiresAt: LATER,
      pendingHandoff: true,
    });
    expect(repos.sessions.findActiveByTokenHash(HASH_B, NOW)).toBeNull();
    expect(repos.sessions.getActive(mikko.id, handoff.id, NOW)).toBeNull();
    expect(repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
    expect(repos.sessions.findPendingHandoffByTokenHash(HASH_B, NOW)).toEqual({
      session: handoff,
      user: mikko,
      credential: key,
    });
    expect(repos.sessions.findPendingHandoffByTokenHash(HASH_B, LATER)).toBeNull();

    const renewed = '2028-01-01T00:00:00.000Z';
    expect(repos.sessions.promoteHandoff(handoff.id, NOW, renewed)).toBe(true);
    expect(repos.sessions.promoteHandoff(handoff.id, NOW, renewed)).toBe(false);
    expect(repos.sessions.findPendingHandoffByTokenHash(HASH_B, NOW)).toBeNull();
    expect(repos.sessions.findActiveByTokenHash(HASH_B, NOW)?.session).toMatchObject({
      id: handoff.id,
      expiresAt: renewed,
      lastSeenAt: NOW,
    });
    expect(repos.sessions.getActive(mikko.id, handoff.id, NOW)?.id).toBe(handoff.id);
    // An ordinary session is never revoked as a "pending hand-off".
    expect(repos.sessions.revokePendingHandoff(HASH_B, NOW)).toBe(false);
  });

  it('never finds a pending hand-off whose key is revoked, nor promotes a revoked or expired one', () => {
    const { repos, mikko } = setup();
    const key = repos.credentials.createKey({ userId: mikko.id, label: 'Phone', secretHash: HASH_A });
    const pending = (n: number, expiresAt = LATER) =>
      repos.sessions.create({
        userId: mikko.id,
        tokenHash: String(n).repeat(64),
        createdVia: 'bookmarklet',
        credentialId: key.id,
        expiresAt,
        pendingHandoff: true,
      });
    const cancelled = pending(1);
    const expired = pending(2, NOW);
    const ofRevokedKey = pending(3);

    expect(repos.sessions.revokePendingHandoff('1'.repeat(64), NOW)).toBe(true);
    expect(repos.sessions.promoteHandoff(cancelled.id, NOW, LATER)).toBe(false);
    expect(repos.sessions.promoteHandoff(expired.id, NOW, LATER)).toBe(false);
    repos.credentials.revoke(mikko.id, key.id, NOW);
    expect(repos.sessions.findPendingHandoffByTokenHash('3'.repeat(64), NOW)).toBeNull();
    expect(ofRevokedKey.credentialId).toBe(key.id);
  });

  it('rejects duplicate token hashes and unknown users', () => {
    const { repos, mikko } = setup();
    repos.sessions.create({ userId: mikko.id, tokenHash: HASH_A, createdVia: 'claim', expiresAt: LATER });
    expectRepositoryError(
      () =>
        repos.sessions.create({ userId: mikko.id, tokenHash: HASH_A, createdVia: 'claim', expiresAt: LATER }),
      'conflict',
    );
    expectRepositoryError(
      () =>
        repos.sessions.create({ userId: 'nope', tokenHash: HASH_B, createdVia: 'claim', expiresAt: LATER }),
      'not-found',
    );
  });
});
