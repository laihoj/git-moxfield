import { describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { countRows, createTestDeck, createTestRepositories, expectRepositoryError } from '@tests/support/db';
import { createRepositories } from '@/server/repositories';

describe('user repository', () => {
  it('creates a user together with a workspace of its own', async () => {
    const { db, repos } = await createTestRepositories();
    const user = await repos.users.create({ displayName: '  Mikko ', role: 'member' });

    expect(user).toMatchObject({
      displayName: 'Mikko',
      role: 'member',
      lastSeenAt: null,
      disabledAt: null,
    });
    expect(user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(await repos.workspaces.getById(user.workspaceId)).toMatchObject({ name: 'Mikko' });
    expect(await repos.users.getById(user.id)).toEqual(user);
    expect(await repos.users.getByWorkspaceId(user.workspaceId)).toEqual(user);
    expect(await countRows(db, 'workspaces')).toBe(2);
  });

  it('rejects an empty display name without creating a workspace', async () => {
    const { db, repos } = await createTestRepositories();
    await expectRepositoryError(
      () => repos.users.create({ displayName: '  ', role: 'member' }),
      'invalid-input',
    );
    expect(await countRows(db, 'workspaces')).toBe(1);
    expect(await countRows(db, 'users')).toBe(0);
  });

  it('adopts an existing workspace that has no owner, once', async () => {
    const { repos } = await createTestRepositories();
    const admin = await repos.users.createForWorkspace({
      displayName: 'Owner',
      role: 'admin',
      workspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(admin.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    await expectRepositoryError(
      () =>
        repos.users.createForWorkspace({
          displayName: 'Other',
          role: 'admin',
          workspaceId: LOCAL_WORKSPACE_ID,
        }),
      'conflict',
    );
    await expectRepositoryError(
      () => repos.users.createForWorkspace({ displayName: 'Other', role: 'admin', workspaceId: 'nope' }),
      'not-found',
    );
    expect(await repos.users.count()).toBe(1);
  });

  it('tells whether a workspace holds any deck', async () => {
    const { db, repos } = await createTestRepositories();
    const user = await repos.users.create({ displayName: 'Mikko', role: 'member' });
    expect(await repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID)).toBe(false);
    expect(await repos.workspaces.hasDecks(user.workspaceId)).toBe(false);
    expect(await repos.workspaces.hasDecks('nope')).toBe(false);

    await createTestDeck(createRepositories(db, { workspaceId: user.workspaceId }));
    expect(await repos.workspaces.hasDecks(user.workspaceId)).toBe(true);
    expect(await repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID)).toBe(false);
  });

  it('lists users oldest first with deck and active key counts', async () => {
    const { repos, db } = await createTestRepositories();
    const first = await repos.users.create({ displayName: 'First', role: 'admin' });
    const second = await repos.users.create({ displayName: 'Second', role: 'member' });
    const firstDecks = createRepositories(db, { workspaceId: first.workspaceId });
    await createTestDeck(firstDecks);
    await createTestDeck(firstDecks);
    await repos.credentials.createKey({ userId: first.id, label: 'Laptop', secretHash: 'a'.repeat(64) });
    const revoked = await repos.credentials.createKey({
      userId: first.id,
      label: 'Old',
      secretHash: 'b'.repeat(64),
    });
    await repos.credentials.revoke(first.id, revoked.id, '2026-02-01T00:00:00.000Z');

    expect(
      (await repos.users.list()).map(({ id, deckCount, activeKeyCount }) => ({
        id,
        deckCount,
        activeKeyCount,
      })),
    ).toEqual([
      { id: first.id, deckCount: 2, activeKeyCount: 1 },
      { id: second.id, deckCount: 0, activeKeyCount: 0 },
    ]);
  });

  it('finds users by display name ignoring case', async () => {
    const { repos } = await createTestRepositories();
    const a = await repos.users.create({ displayName: 'Mikko', role: 'member' });
    const b = await repos.users.create({ displayName: 'mikko', role: 'member' });
    await repos.users.create({ displayName: 'Anna', role: 'member' });
    expect((await repos.users.findByDisplayName(' MIKKO ')).map((user) => user.id)).toEqual([a.id, b.id]);
    expect(await repos.users.findByDisplayName('')).toEqual([]);
  });

  it('renames, disables, enables and records activity', async () => {
    const { repos } = await createTestRepositories();
    const user = await repos.users.create({ displayName: 'Mikko', role: 'admin' });
    expect(await repos.users.countActiveAdmins()).toBe(1);

    expect((await repos.users.rename(user.id, ' Mikko V ')).displayName).toBe('Mikko V');
    const disabled = await repos.users.setDisabled(user.id, true);
    expect(disabled.disabledAt).not.toBeNull();
    // Disabling again keeps the original time.
    expect((await repos.users.setDisabled(user.id, true)).disabledAt).toBe(disabled.disabledAt);
    expect(await repos.users.countActiveAdmins()).toBe(0);
    expect((await repos.users.setDisabled(user.id, false)).disabledAt).toBeNull();

    await repos.users.touchLastSeen(user.id, '2026-03-01T00:00:00.000Z');
    expect((await repos.users.getById(user.id))?.lastSeenAt).toBe('2026-03-01T00:00:00.000Z');
    await expectRepositoryError(() => repos.users.rename('nope', 'X'), 'not-found');
    await expectRepositoryError(() => repos.users.setDisabled('nope', true), 'not-found');
  });
});
