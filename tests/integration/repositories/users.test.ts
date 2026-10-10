import { describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { countRows, createTestDeck, createTestRepositories, expectRepositoryError } from '@tests/support/db';
import { createRepositories } from '@/server/repositories';

describe('user repository', () => {
  it('creates a user together with a workspace of its own', () => {
    const { db, repos } = createTestRepositories();
    const user = repos.users.create({ displayName: '  Mikko ', role: 'member' });

    expect(user).toMatchObject({
      displayName: 'Mikko',
      role: 'member',
      lastSeenAt: null,
      disabledAt: null,
    });
    expect(user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(repos.workspaces.getById(user.workspaceId)).toMatchObject({ name: 'Mikko' });
    expect(repos.users.getById(user.id)).toEqual(user);
    expect(repos.users.getByWorkspaceId(user.workspaceId)).toEqual(user);
    expect(countRows(db, 'workspaces')).toBe(2);
  });

  it('rejects an empty display name without creating a workspace', () => {
    const { db, repos } = createTestRepositories();
    expectRepositoryError(() => repos.users.create({ displayName: '  ', role: 'member' }), 'invalid-input');
    expect(countRows(db, 'workspaces')).toBe(1);
    expect(countRows(db, 'users')).toBe(0);
  });

  it('adopts an existing workspace that has no owner, once', () => {
    const { repos } = createTestRepositories();
    const admin = repos.users.createForWorkspace({
      displayName: 'Owner',
      role: 'admin',
      workspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(admin.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    expectRepositoryError(
      () =>
        repos.users.createForWorkspace({
          displayName: 'Other',
          role: 'admin',
          workspaceId: LOCAL_WORKSPACE_ID,
        }),
      'conflict',
    );
    expectRepositoryError(
      () => repos.users.createForWorkspace({ displayName: 'Other', role: 'admin', workspaceId: 'nope' }),
      'not-found',
    );
    expect(repos.users.count()).toBe(1);
  });

  it('tells whether a workspace holds any deck', () => {
    const { db, repos } = createTestRepositories();
    const user = repos.users.create({ displayName: 'Mikko', role: 'member' });
    expect(repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID)).toBe(false);
    expect(repos.workspaces.hasDecks(user.workspaceId)).toBe(false);
    expect(repos.workspaces.hasDecks('nope')).toBe(false);

    createTestDeck(createRepositories(db, { workspaceId: user.workspaceId }));
    expect(repos.workspaces.hasDecks(user.workspaceId)).toBe(true);
    expect(repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID)).toBe(false);
  });

  it('lists users oldest first with deck and active key counts', () => {
    const { repos, db } = createTestRepositories();
    const first = repos.users.create({ displayName: 'First', role: 'admin' });
    const second = repos.users.create({ displayName: 'Second', role: 'member' });
    const firstDecks = createRepositories(db, { workspaceId: first.workspaceId });
    createTestDeck(firstDecks);
    createTestDeck(firstDecks);
    repos.credentials.createKey({ userId: first.id, label: 'Laptop', secretHash: 'a'.repeat(64) });
    const revoked = repos.credentials.createKey({
      userId: first.id,
      label: 'Old',
      secretHash: 'b'.repeat(64),
    });
    repos.credentials.revoke(first.id, revoked.id, '2026-02-01T00:00:00.000Z');

    expect(
      repos.users.list().map(({ id, deckCount, activeKeyCount }) => ({ id, deckCount, activeKeyCount })),
    ).toEqual([
      { id: first.id, deckCount: 2, activeKeyCount: 1 },
      { id: second.id, deckCount: 0, activeKeyCount: 0 },
    ]);
  });

  it('finds users by display name ignoring case', () => {
    const { repos } = createTestRepositories();
    const a = repos.users.create({ displayName: 'Mikko', role: 'member' });
    const b = repos.users.create({ displayName: 'mikko', role: 'member' });
    repos.users.create({ displayName: 'Anna', role: 'member' });
    expect(repos.users.findByDisplayName(' MIKKO ').map((user) => user.id)).toEqual([a.id, b.id]);
    expect(repos.users.findByDisplayName('')).toEqual([]);
  });

  it('renames, disables, enables and records activity', () => {
    const { repos } = createTestRepositories();
    const user = repos.users.create({ displayName: 'Mikko', role: 'admin' });
    expect(repos.users.countActiveAdmins()).toBe(1);

    expect(repos.users.rename(user.id, ' Mikko V ').displayName).toBe('Mikko V');
    const disabled = repos.users.setDisabled(user.id, true);
    expect(disabled.disabledAt).not.toBeNull();
    // Disabling again keeps the original time.
    expect(repos.users.setDisabled(user.id, true).disabledAt).toBe(disabled.disabledAt);
    expect(repos.users.countActiveAdmins()).toBe(0);
    expect(repos.users.setDisabled(user.id, false).disabledAt).toBeNull();

    repos.users.touchLastSeen(user.id, '2026-03-01T00:00:00.000Z');
    expect(repos.users.getById(user.id)?.lastSeenAt).toBe('2026-03-01T00:00:00.000Z');
    expectRepositoryError(() => repos.users.rename('nope', 'X'), 'not-found');
    expectRepositoryError(() => repos.users.setDisabled('nope', true), 'not-found');
  });
});
