import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createTestRepositories, expectRepositoryError } from '@tests/support/db';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = '2026-06-01T00:00:00.000Z';
const LATER = '2027-06-01T00:00:00.000Z';

async function setup() {
  const { db, repos } = await createTestRepositories();
  const mikko = await repos.users.create({ displayName: 'Mikko', role: 'member' });
  const anna = await repos.users.create({ displayName: 'Anna', role: 'member' });
  return { db, repos, mikko, anna };
}

describe('credential repository', () => {
  it('stores keys by hash only and finds the active ones with their user', async () => {
    const { db, repos, mikko } = await setup();
    const key = await repos.credentials.createKey({
      userId: mikko.id,
      label: ' Laptop ',
      secretHash: HASH_A,
    });
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
    const stored = await db.all(sql`SELECT secret_hash AS hash FROM credentials`);
    expect(stored).toEqual([{ hash: HASH_A }]);

    expect(await repos.credentials.findActiveBySecretHash(HASH_A)).toEqual({
      credential: key,
      user: mikko,
    });
    expect(await repos.credentials.findActiveBySecretHash(HASH_B)).toBeNull();
  });

  it('reports a concurrently stored duplicate hash as a conflict', async () => {
    const { repos, mikko } = await setup();
    const results = await Promise.allSettled([
      repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A }),
      repos.credentials.createKey({ userId: mikko.id, label: 'Phone', secretHash: HASH_A }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find((result) => result.status === 'rejected')?.reason).toMatchObject({
      name: 'RepositoryError',
      code: 'conflict',
    });
    expect(await repos.credentials.listForUser(mikko.id)).toHaveLength(1);
  });

  it('rejects duplicate hashes, unknown users and empty labels', async () => {
    const { repos, mikko } = await setup();
    await repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    await expectRepositoryError(
      () => repos.credentials.createKey({ userId: mikko.id, label: 'Again', secretHash: HASH_A }),
      'conflict',
    );
    await expectRepositoryError(
      () => repos.credentials.createKey({ userId: 'nope', label: 'Laptop', secretHash: HASH_B }),
      'not-found',
    );
    // A rejected promise, never a synchronous throw.
    await expectRepositoryError(
      repos.credentials.createKey({ userId: mikko.id, label: ' ', secretHash: HASH_B }),
      'invalid-input',
    );
    await expectRepositoryError(
      repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: '' }),
      'invalid-input',
    );
  });

  it('stops finding revoked keys and keys of disabled users', async () => {
    const { repos, mikko, anna } = await setup();
    const mine = await repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    const hers = await repos.credentials.createKey({ userId: anna.id, label: 'Phone', secretHash: HASH_B });

    // Only the owner can revoke.
    expect(await repos.credentials.revoke(anna.id, mine.id, NOW)).toBe(false);
    expect(await repos.credentials.revoke(mikko.id, mine.id, NOW)).toBe(true);
    expect(await repos.credentials.revoke(mikko.id, mine.id, NOW)).toBe(false);
    expect(await repos.credentials.findActiveBySecretHash(HASH_A)).toBeNull();

    await repos.users.setDisabled(anna.id, true);
    expect(await repos.credentials.findActiveBySecretHash(HASH_B)).toBeNull();
    await repos.users.setDisabled(anna.id, false);
    expect((await repos.credentials.findActiveBySecretHash(HASH_B))?.credential.id).toBe(hers.id);
  });

  it('records which key a key was made through, and revokes all of a user’s keys at once', async () => {
    const { repos, mikko, anna } = await setup();
    const first = await repos.credentials.createKey({ userId: mikko.id, label: 'First', secretHash: HASH_A });
    const second = await repos.credentials.createKey({
      userId: mikko.id,
      label: 'Second',
      secretHash: HASH_B,
      createdByCredentialId: first.id,
    });
    const hers = await repos.credentials.createKey({
      userId: anna.id,
      label: 'Hers',
      secretHash: 'c'.repeat(64),
    });
    expect(second.createdByCredentialId).toBe(first.id);

    await repos.credentials.revoke(mikko.id, first.id, NOW);
    expect(await repos.credentials.revokeAllForUser(mikko.id, LATER)).toBe(1);
    expect(await repos.credentials.revokeAllForUser(mikko.id, LATER)).toBe(0);
    expect(await repos.credentials.listForUser(mikko.id)).toEqual([]);
    expect((await repos.credentials.listForUser(anna.id)).map((key) => key.id)).toEqual([hers.id]);
  });

  it('lists a user’s keys newest first, revoked ones on request, and records use', async () => {
    const { repos, mikko } = await setup();
    const first = await repos.credentials.createKey({ userId: mikko.id, label: 'First', secretHash: HASH_A });
    const second = await repos.credentials.createKey({
      userId: mikko.id,
      label: 'Second',
      secretHash: HASH_B,
    });
    await repos.credentials.revoke(mikko.id, first.id, NOW);
    await repos.credentials.touchLastUsed(second.id, NOW);

    expect((await repos.credentials.listForUser(mikko.id)).map((key) => [key.id, key.lastUsedAt])).toEqual([
      [second.id, NOW],
    ]);
    expect(
      (await repos.credentials.listForUser(mikko.id, { includeRevoked: true })).map((key) => key.id),
    ).toEqual([second.id, first.id]);
  });
});

describe('session repository', () => {
  it('finds active sessions by token hash, never revoked or expired ones or disabled users’', async () => {
    const { repos, mikko } = await setup();
    const session = await repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_A,
      createdVia: 'invite',
      userAgent: 'Firefox',
      expiresAt: LATER,
    });
    expect(JSON.stringify(session)).not.toContain(HASH_A);
    expect(await repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toEqual({ session, user: mikko });
    // Expired exactly at expiresAt.
    expect(await repos.sessions.findActiveByTokenHash(HASH_A, LATER)).toBeNull();

    await repos.users.setDisabled(mikko.id, true);
    expect(await repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toBeNull();
    await repos.users.setDisabled(mikko.id, false);

    expect(await repos.sessions.revokeByTokenHash(HASH_A, NOW)).toBe(true);
    expect(await repos.sessions.revokeByTokenHash(HASH_A, NOW)).toBe(false);
    expect(await repos.sessions.findActiveByTokenHash(HASH_A, NOW)).toBeNull();
  });

  it('touches only sessions that are not revoked', async () => {
    const { repos, mikko } = await setup();
    const session = await repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_A,
      createdVia: 'claim',
      expiresAt: NOW,
    });
    await repos.sessions.touch(session.id, { lastSeenAt: NOW, expiresAt: LATER });
    expect((await repos.sessions.findActiveByTokenHash(HASH_A, NOW))?.session).toMatchObject({
      lastSeenAt: NOW,
      expiresAt: LATER,
    });
    await repos.sessions.revoke(mikko.id, session.id, NOW);
    await repos.sessions.touch(session.id, { lastSeenAt: LATER });
    expect(await repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
  });

  it('revokes one, all, or a credential’s sessions of one user only', async () => {
    const { repos, mikko, anna } = await setup();
    const key = await repos.credentials.createKey({ userId: mikko.id, label: 'Laptop', secretHash: HASH_A });
    const make = (userId: string, n: number, credentialId: string | null = null) =>
      repos.sessions.create({
        userId,
        tokenHash: String(n).repeat(64).slice(0, 64),
        createdVia: credentialId === null ? 'invite' : 'bookmarklet',
        credentialId,
        expiresAt: LATER,
      });
    const viaKey1 = await make(mikko.id, 1, key.id);
    const viaKey2 = await make(mikko.id, 2, key.id);
    const viaInvite = await make(mikko.id, 3);
    const hers = await make(anna.id, 4);

    expect(await repos.sessions.revoke(anna.id, viaInvite.id, NOW)).toBe(false);
    expect(
      await repos.sessions.revokeAllForUser(mikko.id, NOW, {
        credentialId: key.id,
        exceptSessionId: viaKey2.id,
      }),
    ).toBe(1);
    expect((await repos.sessions.listActiveForUser(mikko.id, NOW)).map((s) => s.id).sort()).toEqual(
      [viaKey2.id, viaInvite.id].sort(),
    );
    expect(await repos.sessions.revokeAllForUser(mikko.id, NOW)).toBe(2);
    expect(await repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
    expect((await repos.sessions.listActiveForUser(anna.id, NOW)).map((s) => s.id)).toEqual([hers.id]);
    expect(viaKey1.credentialId).toBe(key.id);
  });

  it('keeps pending hand-offs apart from sessions until they are promoted, once', async () => {
    const { repos, mikko } = await setup();
    const key = await repos.credentials.createKey({ userId: mikko.id, label: 'Phone', secretHash: HASH_A });
    const handoff = await repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_B,
      createdVia: 'bookmarklet',
      credentialId: key.id,
      expiresAt: LATER,
      pendingHandoff: true,
    });
    expect(await repos.sessions.findActiveByTokenHash(HASH_B, NOW)).toBeNull();
    expect(await repos.sessions.getActive(mikko.id, handoff.id, NOW)).toBeNull();
    expect(await repos.sessions.listActiveForUser(mikko.id, NOW)).toEqual([]);
    expect(await repos.sessions.findPendingHandoffByTokenHash(HASH_B, NOW)).toEqual({
      session: handoff,
      user: mikko,
      credential: key,
    });
    expect(await repos.sessions.findPendingHandoffByTokenHash(HASH_B, LATER)).toBeNull();

    const renewed = '2028-01-01T00:00:00.000Z';
    expect(await repos.sessions.promoteHandoff(handoff.id, NOW, renewed)).toBe(true);
    expect(await repos.sessions.promoteHandoff(handoff.id, NOW, renewed)).toBe(false);
    expect(await repos.sessions.findPendingHandoffByTokenHash(HASH_B, NOW)).toBeNull();
    expect((await repos.sessions.findActiveByTokenHash(HASH_B, NOW))?.session).toMatchObject({
      id: handoff.id,
      expiresAt: renewed,
      lastSeenAt: NOW,
    });
    expect((await repos.sessions.getActive(mikko.id, handoff.id, NOW))?.id).toBe(handoff.id);
    // An ordinary session is never revoked as a "pending hand-off".
    expect(await repos.sessions.revokePendingHandoff(HASH_B, NOW)).toBe(false);
  });

  it('never finds a pending hand-off whose key is revoked, nor promotes a revoked or expired one', async () => {
    const { repos, mikko } = await setup();
    const key = await repos.credentials.createKey({ userId: mikko.id, label: 'Phone', secretHash: HASH_A });
    const pending = (n: number, expiresAt = LATER) =>
      repos.sessions.create({
        userId: mikko.id,
        tokenHash: String(n).repeat(64),
        createdVia: 'bookmarklet',
        credentialId: key.id,
        expiresAt,
        pendingHandoff: true,
      });
    const cancelled = await pending(1);
    const expired = await pending(2, NOW);
    const ofRevokedKey = await pending(3);

    expect(await repos.sessions.revokePendingHandoff('1'.repeat(64), NOW)).toBe(true);
    expect(await repos.sessions.promoteHandoff(cancelled.id, NOW, LATER)).toBe(false);
    expect(await repos.sessions.promoteHandoff(expired.id, NOW, LATER)).toBe(false);
    await repos.credentials.revoke(mikko.id, key.id, NOW);
    expect(await repos.sessions.findPendingHandoffByTokenHash('3'.repeat(64), NOW)).toBeNull();
    expect(ofRevokedKey.credentialId).toBe(key.id);
  });

  it('rejects duplicate token hashes and unknown users', async () => {
    const { repos, mikko } = await setup();
    await repos.sessions.create({
      userId: mikko.id,
      tokenHash: HASH_A,
      createdVia: 'claim',
      expiresAt: LATER,
    });
    await expectRepositoryError(
      () =>
        repos.sessions.create({ userId: mikko.id, tokenHash: HASH_A, createdVia: 'claim', expiresAt: LATER }),
      'conflict',
    );
    await expectRepositoryError(
      () =>
        repos.sessions.create({ userId: 'nope', tokenHash: HASH_B, createdVia: 'claim', expiresAt: LATER }),
      'not-found',
    );
    await expectRepositoryError(
      repos.sessions.create({ userId: mikko.id, tokenHash: '', createdVia: 'claim', expiresAt: LATER }),
      'invalid-input',
    );
  });
});
