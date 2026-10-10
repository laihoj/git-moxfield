/**
 * One-time links and invites: single use, expiry, and single use across connections
 * (two processes of the app share one database file).
 */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import type { LibsqlDatabase } from '@/server/db/libsql';
import { createRepositories, type Repositories } from '@/server/repositories';
import {
  countRows,
  createTestRepositories,
  expectRepositoryError,
  openTestDatabaseHandle,
} from '@tests/support/db';
import { tempDir } from '@tests/support/libsql';

const HASH = 'c'.repeat(64);
const NOW = '2026-06-01T00:00:00.000Z';
const BEFORE_EXPIRY = '2026-06-01T00:14:59.999Z';
const EXPIRY = '2026-06-01T00:15:00.000Z';

describe('login link repository', () => {
  async function setup() {
    const { db, repos } = await createTestRepositories();
    const user = await repos.users.create({ displayName: 'Mikko', role: 'member' });
    const link = await repos.loginLinks.create({
      userId: user.id,
      tokenHash: HASH,
      purpose: 'device',
      createdByUserId: user.id,
      expiresAt: EXPIRY,
    });
    return { db, repos, user, link };
  }

  it('is consumed exactly once', async () => {
    const { repos, user, link } = await setup();
    expect(link).toMatchObject({ purpose: 'device', usedAt: null, createdByUserId: user.id });
    const consumed = await repos.loginLinks.consume(HASH, NOW);
    expect(consumed?.user.id).toBe(user.id);
    expect(consumed?.link).toMatchObject({ id: link.id, usedAt: NOW });
    expect(await repos.loginLinks.consume(HASH, NOW)).toBeNull();
    expect((await repos.loginLinks.getByTokenHash(HASH))?.usedAt).toBe(NOW);
  });

  it('cannot be consumed once expired, or for a disabled user (and then stays unused)', async () => {
    const { repos, user } = await setup();
    expect(await repos.loginLinks.consume(HASH, EXPIRY)).toBeNull();
    await repos.users.setDisabled(user.id, true);
    expect(await repos.loginLinks.consume(HASH, BEFORE_EXPIRY)).toBeNull();
    expect((await repos.loginLinks.getByTokenHash(HASH))?.usedAt).toBeNull();
    await repos.users.setDisabled(user.id, false);
    expect(await repos.loginLinks.consume(HASH, BEFORE_EXPIRY)).not.toBeNull();
    expect(await repos.loginLinks.consume('d'.repeat(64), NOW)).toBeNull();
  });

  it('withdraws unused links by user, creator, key and purpose, never used or expired ones', async () => {
    const { repos, user, link } = await setup();
    const admin = await repos.users.create({ displayName: 'Admin', role: 'admin' });
    const key = await repos.credentials.createKey({
      userId: user.id,
      label: 'Phone',
      secretHash: 'a'.repeat(64),
    });
    const make = (
      n: number,
      input: { purpose: 'device' | 'recovery'; createdByUserId: string; credentialId?: string },
    ) =>
      repos.loginLinks.create({
        userId: user.id,
        tokenHash: String(n).repeat(64),
        expiresAt: EXPIRY,
        ...input,
      });
    const fromKey = await make(1, { purpose: 'device', createdByUserId: user.id, credentialId: key.id });
    const recovery = await make(2, { purpose: 'recovery', createdByUserId: admin.id });
    const used = await make(3, { purpose: 'device', createdByUserId: user.id });
    await repos.loginLinks.consume('3'.repeat(64), NOW);

    await expectRepositoryError(
      () => repos.loginLinks.revokeUnused({ purpose: 'device' }, NOW),
      'invalid-input',
    );
    expect(await repos.loginLinks.revokeUnused({ userId: user.id, credentialId: key.id }, NOW)).toBe(1);
    expect(await repos.loginLinks.getByTokenHash('1'.repeat(64))).toMatchObject({
      id: fromKey.id,
      revokedAt: NOW,
    });
    expect(await repos.loginLinks.consume('1'.repeat(64), NOW)).toBeNull();
    expect(await repos.loginLinks.revokeUnused({ createdByUserId: admin.id }, NOW)).toBe(1);
    expect((await repos.loginLinks.getByTokenHash('2'.repeat(64)))?.id).toBe(recovery.id);
    // Expired links are not counted, used ones never change.
    expect(await repos.loginLinks.revokeUnused({ userId: user.id }, EXPIRY)).toBe(0);
    expect(await repos.loginLinks.revokeUnused({ userId: user.id }, NOW)).toBe(1);
    expect(await repos.loginLinks.getByTokenHash(HASH)).toMatchObject({ id: link.id, revokedAt: NOW });
    expect(await repos.loginLinks.getByTokenHash('3'.repeat(64))).toMatchObject({
      id: used.id,
      revokedAt: null,
    });
  });

  it('lists pending links of a purpose and a user’s used ones, and withdraws one by id', async () => {
    const { repos, user, link } = await setup();
    const recovery = await repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      purpose: 'recovery',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    expect((await repos.loginLinks.listPending('recovery', NOW)).map((entry) => entry.id)).toEqual([
      recovery.id,
    ]);
    expect((await repos.loginLinks.listPending('device', NOW)).map((entry) => entry.id)).toEqual([link.id]);
    expect(await repos.loginLinks.listPending('recovery', EXPIRY)).toEqual([]);

    expect(await repos.loginLinks.revoke(link.id, NOW, { purpose: 'recovery' })).toBe(false);
    expect(await repos.loginLinks.revoke(recovery.id, NOW, { purpose: 'recovery' })).toBe(true);
    expect(await repos.loginLinks.revoke(recovery.id, NOW)).toBe(false);
    expect(await repos.loginLinks.listPending('recovery', NOW)).toEqual([]);

    await repos.loginLinks.consume(HASH, NOW);
    expect((await repos.loginLinks.listUsedForUser(user.id, 'device')).map((entry) => entry.id)).toEqual([
      link.id,
    ]);
    expect(await repos.loginLinks.listUsedForUser(user.id, 'recovery')).toEqual([]);
  });

  it('refuses a recovery link whose admin is no longer an active admin, or a device link of a revoked key', async () => {
    const { repos, user } = await setup();
    const admin = await repos.users.create({ displayName: 'Admin', role: 'admin' });
    const key = await repos.credentials.createKey({
      userId: user.id,
      label: 'Phone',
      secretHash: 'a'.repeat(64),
    });
    await repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'b'.repeat(64),
      purpose: 'recovery',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    await repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'd'.repeat(64),
      purpose: 'device',
      createdByUserId: user.id,
      credentialId: key.id,
      expiresAt: EXPIRY,
    });
    const recovery = await repos.loginLinks.getByTokenHash('b'.repeat(64));
    if (!recovery) throw new Error('missing');
    expect(await repos.loginLinks.hasActiveCreator(recovery)).toBe(true);

    await repos.users.setDisabled(admin.id, true);
    expect(await repos.loginLinks.hasActiveCreator(recovery)).toBe(false);
    expect(await repos.loginLinks.consume('b'.repeat(64), NOW)).toBeNull();
    await repos.users.setDisabled(admin.id, false);
    await repos.credentials.revoke(user.id, key.id, NOW);
    expect(await repos.loginLinks.consume('d'.repeat(64), NOW)).toBeNull();
    expect((await repos.loginLinks.consume('b'.repeat(64), NOW))?.link.purpose).toBe('recovery');
  });

  it('rejects duplicate token hashes and unknown users', async () => {
    const { repos, user } = await setup();
    const input = {
      userId: user.id,
      tokenHash: HASH,
      purpose: 'recovery' as const,
      createdByUserId: null,
      expiresAt: EXPIRY,
    };
    await expectRepositoryError(() => repos.loginLinks.create(input), 'conflict');
    await expectRepositoryError(
      () => repos.loginLinks.create({ ...input, tokenHash: 'e'.repeat(64), userId: 'nope' }),
      'not-found',
    );
  });
});

describe('invite repository', () => {
  async function setup() {
    const { db, repos } = await createTestRepositories();
    const admin = await repos.users.create({ displayName: 'Admin', role: 'admin' });
    const invite = await repos.invites.create({
      tokenHash: HASH,
      role: 'member',
      note: ' for Mikko ',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    return { db, repos, admin, invite };
  }

  it('creates the user with a workspace of its own and records who used it', async () => {
    const { db, repos, admin, invite } = await setup();
    expect(invite).toMatchObject({
      role: 'member',
      note: 'for Mikko',
      createdByUserId: admin.id,
      usedAt: null,
    });
    const accepted = await repos.invites.accept(HASH, NOW, { displayName: 'Mikko' });
    expect(accepted?.user).toMatchObject({ displayName: 'Mikko', role: 'member' });
    expect(accepted?.invite).toMatchObject({ usedAt: NOW, usedByUserId: accepted?.user.id });
    expect(accepted?.user.workspaceId).not.toBe(admin.workspaceId);
    expect(await countRows(db, 'users')).toBe(2);
    expect(await repos.invites.accept(HASH, NOW, { displayName: 'Again' })).toBeNull();
    expect(await countRows(db, 'users')).toBe(2);
  });

  it('can make the new user adopt an unowned workspace, never an owned one', async () => {
    const { db, repos } = await setup();
    const accepted = await repos.invites.accept(HASH, NOW, {
      displayName: 'Op',
      adoptWorkspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(accepted?.user.workspaceId).toBe(LOCAL_WORKSPACE_ID);

    await repos.invites.create({
      tokenHash: 'f'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    await expectRepositoryError(
      () =>
        repos.invites.accept('f'.repeat(64), NOW, { displayName: 'X', adoptWorkspaceId: LOCAL_WORKSPACE_ID }),
      'conflict',
    );
    // The failed acceptance changed nothing: the invite is still usable.
    expect((await repos.invites.getByTokenHash('f'.repeat(64)))?.usedAt).toBeNull();
    expect(await countRows(db, 'users')).toBe(2);
  });

  it('is refused when expired, revoked or given an empty name, without being used up', async () => {
    const { repos, invite } = await setup();
    expect(await repos.invites.accept(HASH, EXPIRY, { displayName: 'Mikko' })).toBeNull();
    await expectRepositoryError(() => repos.invites.accept(HASH, NOW, { displayName: ' ' }), 'invalid-input');
    expect((await repos.invites.getById(invite.id))?.usedAt).toBeNull();

    expect(await repos.invites.revoke(invite.id, NOW)).toBe(true);
    expect(await repos.invites.revoke(invite.id, NOW)).toBe(false);
    expect(await repos.invites.accept(HASH, NOW, { displayName: 'Mikko' })).toBeNull();
  });

  it('is refused once its admin is disabled, and is revoked with everything else they made', async () => {
    const { repos, admin } = await setup();
    const other = await repos.invites.create({
      tokenHash: 'a'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    const invite = await repos.invites.getByTokenHash(HASH);
    if (!invite) throw new Error('missing');
    expect(await repos.invites.hasActiveCreator(invite)).toBe(true);
    await repos.users.setDisabled(admin.id, true);
    expect(await repos.invites.hasActiveCreator(invite)).toBe(false);
    expect(await repos.invites.accept(HASH, NOW, { displayName: 'Mikko' })).toBeNull();

    expect(await repos.invites.revokePendingCreatedBy(admin.id, NOW)).toBe(2);
    expect(await repos.invites.revokePendingCreatedBy(admin.id, NOW)).toBe(0);
    expect((await repos.invites.getById(other.id))?.revokedAt).toBe(NOW);
  });

  it('cannot revoke a used invite and lists invites newest first', async () => {
    const { repos, invite } = await setup();
    await repos.invites.accept(HASH, NOW, { displayName: 'Mikko' });
    expect(await repos.invites.revoke(invite.id, NOW)).toBe(false);
    const newer = await repos.invites.create({
      tokenHash: 'a'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    expect((await repos.invites.list()).map((entry) => entry.id)).toEqual([newer.id, invite.id]);
  });
});

describe('single use across connections', () => {
  let dir: string | undefined;
  const open: LibsqlDatabase[] = [];

  afterEach(() => {
    for (const handle of open.splice(0)) handle.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * Two handles on one database file, like two requests (or, through SQLite's file lock,
   * two processes) of the app.
   */
  async function twoConnections(): Promise<[Repositories, Repositories]> {
    dir = tempDir('git-moxfield-once-');
    const url = `file:${join(dir, 'app.db')}`;
    const first = await openTestDatabaseHandle({ url });
    const second = await openTestDatabaseHandle({ url });
    open.push(first, second);
    return [createRepositories(first.db), createRepositories(second.db)];
  }

  it('lets exactly one connection accept an invite, even when both saw it unused', async () => {
    const [a, b] = await twoConnections();
    await a.invites.create({
      tokenHash: HASH,
      role: 'member',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    // Both "requests" checked the invite and found it usable...
    expect((await a.invites.getByTokenHash(HASH))?.usedAt).toBeNull();
    expect((await b.invites.getByTokenHash(HASH))?.usedAt).toBeNull();
    // ...but only the first acceptance wins; the second creates nothing.
    expect(await b.invites.accept(HASH, NOW, { displayName: 'B' })).not.toBeNull();
    expect(await a.invites.accept(HASH, NOW, { displayName: 'A' })).toBeNull();
    expect((await a.users.list()).map((user) => user.displayName)).toEqual(['B']);
  });

  it('serializes acceptances: a second connection waits for an open one, then finds the invite used', async () => {
    const [a, b] = await twoConnections();
    await a.invites.create({
      tokenHash: HASH,
      role: 'member',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    let claimed!: () => void;
    const insideTransaction = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });

    const first = a.transaction(async (tx) => {
      const accepted = await tx.invites.accept(HASH, NOW, { displayName: 'A' });
      claimed();
      await gate;
      return accepted;
    });
    await insideTransaction;
    // Started while A's transaction holds the write lock with the invite claimed.
    let settled = false;
    const second = b.invites.accept(HASH, NOW, { displayName: 'B' }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    commit();
    expect(await first).not.toBeNull();
    expect(await second).toBeNull();
    expect((await b.users.list()).map((user) => user.displayName)).toEqual(['A']);
  });

  it('lets exactly one of concurrent consumers use a login link', async () => {
    const [a, b] = await twoConnections();
    const user = await a.users.create({ displayName: 'Mikko', role: 'member' });
    await a.loginLinks.create({
      userId: user.id,
      tokenHash: HASH,
      purpose: 'device',
      createdByUserId: user.id,
      expiresAt: EXPIRY,
    });
    const results = await Promise.all([
      b.loginLinks.consume(HASH, NOW),
      a.loginLinks.consume(HASH, NOW),
      b.loginLinks.consume(HASH, NOW),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await a.loginLinks.consume(HASH, NOW)).toBeNull();
  });
});
