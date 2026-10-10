/**
 * One-time links and invites: single use, expiry, and single use across connections
 * (two processes of the app share one database file).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID, openDatabase, type Db } from '@/server/db/client';
import { createRepositories, type Repositories } from '@/server/repositories';
import { countRows, createTestRepositories, expectRepositoryError } from '@tests/support/db';

const HASH = 'c'.repeat(64);
const NOW = '2026-06-01T00:00:00.000Z';
const BEFORE_EXPIRY = '2026-06-01T00:14:59.999Z';
const EXPIRY = '2026-06-01T00:15:00.000Z';

describe('login link repository', () => {
  function setup() {
    const { db, repos } = createTestRepositories();
    const user = repos.users.create({ displayName: 'Mikko', role: 'member' });
    const link = repos.loginLinks.create({
      userId: user.id,
      tokenHash: HASH,
      purpose: 'device',
      createdByUserId: user.id,
      expiresAt: EXPIRY,
    });
    return { db, repos, user, link };
  }

  it('is consumed exactly once', () => {
    const { repos, user, link } = setup();
    expect(link).toMatchObject({ purpose: 'device', usedAt: null, createdByUserId: user.id });
    const consumed = repos.loginLinks.consume(HASH, NOW);
    expect(consumed?.user.id).toBe(user.id);
    expect(consumed?.link).toMatchObject({ id: link.id, usedAt: NOW });
    expect(repos.loginLinks.consume(HASH, NOW)).toBeNull();
    expect(repos.loginLinks.getByTokenHash(HASH)?.usedAt).toBe(NOW);
  });

  it('cannot be consumed once expired, or for a disabled user (and then stays unused)', () => {
    const { repos, user } = setup();
    expect(repos.loginLinks.consume(HASH, EXPIRY)).toBeNull();
    repos.users.setDisabled(user.id, true);
    expect(repos.loginLinks.consume(HASH, BEFORE_EXPIRY)).toBeNull();
    expect(repos.loginLinks.getByTokenHash(HASH)?.usedAt).toBeNull();
    repos.users.setDisabled(user.id, false);
    expect(repos.loginLinks.consume(HASH, BEFORE_EXPIRY)).not.toBeNull();
    expect(repos.loginLinks.consume('d'.repeat(64), NOW)).toBeNull();
  });

  it('withdraws unused links by user, creator, key and purpose, never used or expired ones', () => {
    const { repos, user, link } = setup();
    const admin = repos.users.create({ displayName: 'Admin', role: 'admin' });
    const key = repos.credentials.createKey({ userId: user.id, label: 'Phone', secretHash: 'a'.repeat(64) });
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
    const fromKey = make(1, { purpose: 'device', createdByUserId: user.id, credentialId: key.id });
    const recovery = make(2, { purpose: 'recovery', createdByUserId: admin.id });
    const used = make(3, { purpose: 'device', createdByUserId: user.id });
    repos.loginLinks.consume('3'.repeat(64), NOW);

    expectRepositoryError(() => repos.loginLinks.revokeUnused({ purpose: 'device' }, NOW), 'invalid-input');
    expect(repos.loginLinks.revokeUnused({ userId: user.id, credentialId: key.id }, NOW)).toBe(1);
    expect(repos.loginLinks.getByTokenHash('1'.repeat(64))).toMatchObject({ id: fromKey.id, revokedAt: NOW });
    expect(repos.loginLinks.consume('1'.repeat(64), NOW)).toBeNull();
    expect(repos.loginLinks.revokeUnused({ createdByUserId: admin.id }, NOW)).toBe(1);
    expect(repos.loginLinks.getByTokenHash('2'.repeat(64))?.id).toBe(recovery.id);
    // Expired links are not counted, used ones never change.
    expect(repos.loginLinks.revokeUnused({ userId: user.id }, EXPIRY)).toBe(0);
    expect(repos.loginLinks.revokeUnused({ userId: user.id }, NOW)).toBe(1);
    expect(repos.loginLinks.getByTokenHash(HASH)).toMatchObject({ id: link.id, revokedAt: NOW });
    expect(repos.loginLinks.getByTokenHash('3'.repeat(64))).toMatchObject({ id: used.id, revokedAt: null });
  });

  it('lists pending links of a purpose and a user’s used ones, and withdraws one by id', () => {
    const { repos, user, link } = setup();
    const recovery = repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'a'.repeat(64),
      purpose: 'recovery',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    expect(repos.loginLinks.listPending('recovery', NOW).map((entry) => entry.id)).toEqual([recovery.id]);
    expect(repos.loginLinks.listPending('device', NOW).map((entry) => entry.id)).toEqual([link.id]);
    expect(repos.loginLinks.listPending('recovery', EXPIRY)).toEqual([]);

    expect(repos.loginLinks.revoke(link.id, NOW, { purpose: 'recovery' })).toBe(false);
    expect(repos.loginLinks.revoke(recovery.id, NOW, { purpose: 'recovery' })).toBe(true);
    expect(repos.loginLinks.revoke(recovery.id, NOW)).toBe(false);
    expect(repos.loginLinks.listPending('recovery', NOW)).toEqual([]);

    repos.loginLinks.consume(HASH, NOW);
    expect(repos.loginLinks.listUsedForUser(user.id, 'device').map((entry) => entry.id)).toEqual([link.id]);
    expect(repos.loginLinks.listUsedForUser(user.id, 'recovery')).toEqual([]);
  });

  it('refuses a recovery link whose admin is no longer an active admin, or a device link of a revoked key', () => {
    const { repos, user } = setup();
    const admin = repos.users.create({ displayName: 'Admin', role: 'admin' });
    const key = repos.credentials.createKey({ userId: user.id, label: 'Phone', secretHash: 'a'.repeat(64) });
    repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'b'.repeat(64),
      purpose: 'recovery',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    repos.loginLinks.create({
      userId: user.id,
      tokenHash: 'd'.repeat(64),
      purpose: 'device',
      createdByUserId: user.id,
      credentialId: key.id,
      expiresAt: EXPIRY,
    });
    const recovery = repos.loginLinks.getByTokenHash('b'.repeat(64));
    if (!recovery) throw new Error('missing');
    expect(repos.loginLinks.hasActiveCreator(recovery)).toBe(true);

    repos.users.setDisabled(admin.id, true);
    expect(repos.loginLinks.hasActiveCreator(recovery)).toBe(false);
    expect(repos.loginLinks.consume('b'.repeat(64), NOW)).toBeNull();
    repos.users.setDisabled(admin.id, false);
    repos.credentials.revoke(user.id, key.id, NOW);
    expect(repos.loginLinks.consume('d'.repeat(64), NOW)).toBeNull();
    expect(repos.loginLinks.consume('b'.repeat(64), NOW)?.link.purpose).toBe('recovery');
  });

  it('rejects duplicate token hashes and unknown users', () => {
    const { repos, user } = setup();
    const input = {
      userId: user.id,
      tokenHash: HASH,
      purpose: 'recovery' as const,
      createdByUserId: null,
      expiresAt: EXPIRY,
    };
    expectRepositoryError(() => repos.loginLinks.create(input), 'conflict');
    expectRepositoryError(
      () => repos.loginLinks.create({ ...input, tokenHash: 'e'.repeat(64), userId: 'nope' }),
      'not-found',
    );
  });
});

describe('invite repository', () => {
  function setup() {
    const { db, repos } = createTestRepositories();
    const admin = repos.users.create({ displayName: 'Admin', role: 'admin' });
    const invite = repos.invites.create({
      tokenHash: HASH,
      role: 'member',
      note: ' for Mikko ',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    return { db, repos, admin, invite };
  }

  it('creates the user with a workspace of its own and records who used it', () => {
    const { db, repos, admin, invite } = setup();
    expect(invite).toMatchObject({
      role: 'member',
      note: 'for Mikko',
      createdByUserId: admin.id,
      usedAt: null,
    });
    const accepted = repos.invites.accept(HASH, NOW, { displayName: 'Mikko' });
    expect(accepted?.user).toMatchObject({ displayName: 'Mikko', role: 'member' });
    expect(accepted?.invite).toMatchObject({ usedAt: NOW, usedByUserId: accepted?.user.id });
    expect(accepted?.user.workspaceId).not.toBe(admin.workspaceId);
    expect(countRows(db, 'users')).toBe(2);
    expect(repos.invites.accept(HASH, NOW, { displayName: 'Again' })).toBeNull();
    expect(countRows(db, 'users')).toBe(2);
  });

  it('can make the new user adopt an unowned workspace, never an owned one', () => {
    const { db, repos } = setup();
    const accepted = repos.invites.accept(HASH, NOW, {
      displayName: 'Op',
      adoptWorkspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(accepted?.user.workspaceId).toBe(LOCAL_WORKSPACE_ID);

    repos.invites.create({
      tokenHash: 'f'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    expectRepositoryError(
      () =>
        repos.invites.accept('f'.repeat(64), NOW, { displayName: 'X', adoptWorkspaceId: LOCAL_WORKSPACE_ID }),
      'conflict',
    );
    // The failed acceptance changed nothing: the invite is still usable.
    expect(repos.invites.getByTokenHash('f'.repeat(64))?.usedAt).toBeNull();
    expect(countRows(db, 'users')).toBe(2);
  });

  it('is refused when expired, revoked or given an empty name, without being used up', () => {
    const { repos, invite } = setup();
    expect(repos.invites.accept(HASH, EXPIRY, { displayName: 'Mikko' })).toBeNull();
    expectRepositoryError(() => repos.invites.accept(HASH, NOW, { displayName: ' ' }), 'invalid-input');
    expect(repos.invites.getById(invite.id)?.usedAt).toBeNull();

    expect(repos.invites.revoke(invite.id, NOW)).toBe(true);
    expect(repos.invites.revoke(invite.id, NOW)).toBe(false);
    expect(repos.invites.accept(HASH, NOW, { displayName: 'Mikko' })).toBeNull();
  });

  it('is refused once its admin is disabled, and is revoked with everything else they made', () => {
    const { repos, admin } = setup();
    const other = repos.invites.create({
      tokenHash: 'a'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: admin.id,
      expiresAt: EXPIRY,
    });
    const invite = repos.invites.getByTokenHash(HASH);
    if (!invite) throw new Error('missing');
    expect(repos.invites.hasActiveCreator(invite)).toBe(true);
    repos.users.setDisabled(admin.id, true);
    expect(repos.invites.hasActiveCreator(invite)).toBe(false);
    expect(repos.invites.accept(HASH, NOW, { displayName: 'Mikko' })).toBeNull();

    expect(repos.invites.revokePendingCreatedBy(admin.id, NOW)).toBe(2);
    expect(repos.invites.revokePendingCreatedBy(admin.id, NOW)).toBe(0);
    expect(repos.invites.getById(other.id)?.revokedAt).toBe(NOW);
  });

  it('cannot revoke a used invite and lists invites newest first', () => {
    const { repos, invite } = setup();
    repos.invites.accept(HASH, NOW, { displayName: 'Mikko' });
    expect(repos.invites.revoke(invite.id, NOW)).toBe(false);
    const newer = repos.invites.create({
      tokenHash: 'a'.repeat(64),
      role: 'admin',
      note: '',
      createdByUserId: null,
      expiresAt: EXPIRY,
    });
    expect(repos.invites.list().map((entry) => entry.id)).toEqual([newer.id, invite.id]);
  });
});

describe('single use across connections', () => {
  let dir: string | undefined;
  const open: Db[] = [];

  afterEach(() => {
    for (const db of open.splice(0)) db.$client.close();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /** Two connections to one database file, like two app processes. */
  function twoConnections(): [Repositories, Repositories, Db] {
    dir = mkdtempSync(join(tmpdir(), 'git-moxfield-once-'));
    const first = openDatabase(join(dir, 'app.db'));
    const second = openDatabase(join(dir, 'app.db'));
    // Fail at once instead of waiting for the lock (better-sqlite3 blocks the thread).
    second.$client.pragma('busy_timeout = 0');
    open.push(first, second);
    return [createRepositories(first), createRepositories(second), second];
  }

  it('lets exactly one connection accept an invite, even when both saw it unused', () => {
    const [a, b] = twoConnections();
    a.invites.create({ tokenHash: HASH, role: 'member', note: '', createdByUserId: null, expiresAt: EXPIRY });
    // Both "requests" checked the invite and found it usable...
    expect(a.invites.getByTokenHash(HASH)?.usedAt).toBeNull();
    expect(b.invites.getByTokenHash(HASH)?.usedAt).toBeNull();
    // ...but only the first acceptance wins; the second creates nothing.
    expect(b.invites.accept(HASH, NOW, { displayName: 'B' })).not.toBeNull();
    expect(a.invites.accept(HASH, NOW, { displayName: 'A' })).toBeNull();
    expect(a.users.list().map((user) => user.displayName)).toEqual(['B']);
  });

  it('serializes acceptances: a second connection cannot interleave with an open one', () => {
    const [a, b] = twoConnections();
    a.invites.create({ tokenHash: HASH, role: 'member', note: '', createdByUserId: null, expiresAt: EXPIRY });
    a.transaction((tx) => {
      expect(tx.invites.accept(HASH, NOW, { displayName: 'A' })).not.toBeNull();
      // While A's transaction holds the write lock, B cannot even start.
      expect(() => b.invites.accept(HASH, NOW, { displayName: 'B' })).toThrow(/database is locked/);
    });
    expect(b.invites.accept(HASH, NOW, { displayName: 'B' })).toBeNull();
    expect(b.users.list().map((user) => user.displayName)).toEqual(['A']);
  });

  it('lets exactly one connection consume a login link', () => {
    const [a, b] = twoConnections();
    const user = a.users.create({ displayName: 'Mikko', role: 'member' });
    a.loginLinks.create({
      userId: user.id,
      tokenHash: HASH,
      purpose: 'device',
      createdByUserId: user.id,
      expiresAt: EXPIRY,
    });
    expect(b.loginLinks.consume(HASH, NOW)).not.toBeNull();
    expect(a.loginLinks.consume(HASH, NOW)).toBeNull();
  });
});
