/**
 * Share link repository (ADR 0007): links are stored by token hash only; a link works
 * while it is not revoked, its deck is tracked and the deck's owner is not disabled; the
 * owner's operations are scoped to the bound workspace; links can be found and revoked
 * by the key their creating session descends from, for their creator only, and all of a
 * workspace's links can be revoked at once (account recovery).
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createRepositories, type Repositories, type UserRecord } from '@/server/repositories';
import { countRows, createTestDeck, createTestRepositories, expectRepositoryError } from '@tests/support/db';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const AT = '2026-06-01T12:00:00.000Z';

async function setup() {
  const { db, repos: installation } = await createTestRepositories();
  const owner = await installation.users.create({ displayName: 'Mikko', role: 'member' });
  const repos = createRepositories(db, { workspaceId: owner.workspaceId });
  const deck = await createTestDeck(repos);
  const link = await repos.shareLinks.create({
    deckId: deck.id,
    tokenHash: HASH,
    label: 'For Pekka',
    includeNotes: true,
    createdByUserId: owner.id,
    credentialId: null,
  });
  return { db, installation, repos, owner, deck, link };
}

/** Another user with a deck of their own. */
async function secondUser(installation: Repositories, db: Parameters<typeof createRepositories>[0]) {
  const user = await installation.users.create({ displayName: 'Pekka', role: 'member' });
  const repos = createRepositories(db, { workspaceId: user.workspaceId });
  return { user, repos, deck: await createTestDeck(repos) };
}

describe('share link repository', () => {
  it('stores a link by its token hash only and returns a record without it', async () => {
    const { db, link, deck, owner } = await setup();
    expect(link).toEqual({
      id: link.id,
      deckId: deck.id,
      label: 'For Pekka',
      includeNotes: true,
      createdByUserId: owner.id,
      credentialId: null,
      createdAt: link.createdAt,
      lastViewedAt: null,
      revokedAt: null,
    });
    expect(await db.all(sql`SELECT token_hash AS hash FROM share_links`)).toEqual([{ hash: HASH }]);
  });

  it('creates links only for decks of the bound workspace, and refuses a taken hash', async () => {
    const { db, installation, repos, owner, deck } = await setup();
    const other = await secondUser(installation, db);
    const input = {
      tokenHash: OTHER_HASH,
      label: 'x',
      includeNotes: false,
      createdByUserId: owner.id,
      credentialId: null,
    };
    await expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: other.deck.id }),
      'not-found',
    );
    await expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: 'no-such-deck' }),
      'not-found',
    );
    await expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: deck.id, tokenHash: HASH }),
      'conflict',
    );
    await expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: deck.id, tokenHash: '' }),
      'invalid-input',
    );
    expect(await countRows(db, 'share_links')).toBe(1);
  });

  it('resolves an active link installation-wide, with its workspace and owner', async () => {
    const { db, link, owner } = await setup();
    // Any binding resolves tokens: the token is its own authorization.
    const elsewhere = createRepositories(db);
    expect(await elsewhere.shareLinks.findActive(HASH)).toEqual({
      link,
      workspaceId: owner.workspaceId,
      ownerDisplayName: 'Mikko',
    });
    expect(await elsewhere.shareLinks.isActive(link.id)).toBe(true);
    expect(await elsewhere.shareLinks.findActive(OTHER_HASH)).toBeNull();
    expect(await elsewhere.shareLinks.isActive('no-such-link')).toBe(false);
  });

  it('stops resolving a revoked link, for good', async () => {
    const { repos, deck, link } = await setup();
    expect(await repos.shareLinks.revoke(deck.id, link.id, AT)).toBe(true);
    expect(await repos.shareLinks.findActive(HASH)).toBeNull();
    expect(await repos.shareLinks.isActive(link.id)).toBe(false);
    // Idempotent: a second revocation changes nothing, and keeps the first time.
    expect(await repos.shareLinks.revoke(deck.id, link.id, '2027-01-01T00:00:00.000Z')).toBe(false);
    expect(await repos.shareLinks.listForDeck(deck.id)).toEqual([]);
  });

  it('stops resolving the links of an untracked deck: they are deleted with it', async () => {
    const { db, repos, deck, link } = await setup();
    expect(await repos.decks.delete(deck.id)).toBe(true);
    expect(await repos.shareLinks.findActive(HASH)).toBeNull();
    expect(await repos.shareLinks.isActive(link.id)).toBe(false);
    expect(await countRows(db, 'share_links')).toBe(0);
  });

  it('suspends the links of a disabled owner while they are disabled', async () => {
    const { repos, owner, link } = await setup();
    await repos.users.setDisabled(owner.id, true);
    expect(await repos.shareLinks.findActive(HASH)).toBeNull();
    expect(await repos.shareLinks.isActive(link.id)).toBe(false);
    await repos.users.setDisabled(owner.id, false);
    expect((await repos.shareLinks.findActive(HASH))?.link.id).toBe(link.id);
  });

  it('resolves no link to a deck of a workspace without an owner', async () => {
    const { db } = await createTestRepositories();
    // The `local` workspace of a pre-account installation, not adopted yet.
    const local = createRepositories(db);
    const user: UserRecord = await local.users.create({ displayName: 'Stranger', role: 'member' });
    const deck = await createTestDeck(local);
    await local.shareLinks.create({
      deckId: deck.id,
      tokenHash: HASH,
      label: 'x',
      includeNotes: false,
      createdByUserId: user.id,
      credentialId: null,
    });
    expect(await local.shareLinks.findActive(HASH)).toBeNull();
  });

  it('lists and revokes links of the bound workspace’s decks only', async () => {
    const { db, installation, repos, deck, link } = await setup();
    const other = await secondUser(installation, db);
    const later = await repos.shareLinks.create({
      deckId: deck.id,
      tokenHash: OTHER_HASH,
      label: 'Discord',
      includeNotes: false,
      createdByUserId: link.createdByUserId ?? '',
      credentialId: null,
    });
    expect((await repos.shareLinks.listForDeck(deck.id)).map((entry) => entry.id)).toEqual([
      later.id,
      link.id,
    ]);

    // Another workspace sees nothing of them and cannot revoke them, even naming the deck.
    expect(await other.repos.shareLinks.listForDeck(deck.id)).toEqual([]);
    expect(await other.repos.shareLinks.revoke(deck.id, link.id, AT)).toBe(false);
    expect(await other.repos.shareLinks.revoke(other.deck.id, link.id, AT)).toBe(false);
    // Nor through another deck of the owner's own workspace.
    const second = await createTestDeck(repos);
    expect(await repos.shareLinks.revoke(second.id, link.id, AT)).toBe(false);
    expect((await repos.shareLinks.findActive(HASH))?.link.id).toBe(link.id);
  });

  it('revokes every link of a workspace’s decks at once, and no other workspace’s (recovery)', async () => {
    const { db, installation, repos, owner, deck, link } = await setup();
    const other = await secondUser(installation, db);
    const second = await createTestDeck(repos);
    const viaKeyless = await repos.shareLinks.create({
      deckId: second.id,
      tokenHash: OTHER_HASH,
      label: 'Made by someone else',
      includeNotes: false,
      createdByUserId: other.user.id,
      credentialId: null,
    });
    const othersLink = await other.repos.shareLinks.create({
      deckId: other.deck.id,
      tokenHash: 'c'.repeat(64),
      label: 'Pekka’s',
      includeNotes: false,
      createdByUserId: other.user.id,
      credentialId: null,
    });
    await repos.shareLinks.revoke(deck.id, link.id, '2026-05-01T00:00:00.000Z');

    // Installation-wide: the workspace is named, whatever the context is bound to.
    expect(await installation.shareLinks.revokeAllForWorkspace(owner.workspaceId, AT)).toBe(1);
    expect(await repos.shareLinks.findActive(OTHER_HASH)).toBeNull();
    expect(await repos.shareLinks.listForDeck(second.id)).toEqual([]);
    // An earlier revocation keeps its time; another workspace's links keep working.
    expect(
      await db.all(sql`SELECT id, revoked_at AS revokedAt FROM share_links ORDER BY revoked_at`),
    ).toEqual([
      { id: othersLink.id, revokedAt: null },
      { id: link.id, revokedAt: '2026-05-01T00:00:00.000Z' },
      { id: viaKeyless.id, revokedAt: AT },
    ]);
    expect(await installation.shareLinks.revokeAllForWorkspace(owner.workspaceId, AT)).toBe(0);
  });

  it('records a view at most once per interval', async () => {
    const { repos, link } = await setup();
    const view = (at: string, since: string) => repos.shareLinks.touchViewed(link.id, at, since);
    expect(await view('2026-06-01T12:00:00.000Z', '2026-06-01T11:00:00.000Z')).toBe(true);
    expect(await view('2026-06-01T12:59:59.000Z', '2026-06-01T11:59:59.000Z')).toBe(false);
    expect((await repos.shareLinks.findActive(HASH))?.link.lastViewedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(await view('2026-06-01T13:00:00.001Z', '2026-06-01T12:00:00.001Z')).toBe(true);
    expect((await repos.shareLinks.findActive(HASH))?.link.lastViewedAt).toBe('2026-06-01T13:00:00.001Z');
  });

  it('finds and revokes links by the keys their sessions descend from, for their creator only', async () => {
    const { db, installation, repos, owner, deck } = await setup();
    const laptop = await installation.credentials.createKey({
      userId: owner.id,
      label: 'Laptop',
      secretHash: 'c'.repeat(64),
    });
    const phone = await installation.credentials.createKey({
      userId: owner.id,
      label: 'Phone',
      secretHash: 'd'.repeat(64),
    });
    const make = (n: number, credentialId: string | null) =>
      repos.shareLinks.create({
        deckId: deck.id,
        tokenHash: String(n).repeat(64),
        label: `Link ${n}`,
        includeNotes: false,
        createdByUserId: owner.id,
        credentialId,
      });
    const viaLaptop = await make(1, laptop.id);
    const viaPhone = await make(2, phone.id);
    const revokedViaLaptop = await make(3, laptop.id);
    await repos.shareLinks.revoke(deck.id, revokedViaLaptop.id, AT);
    const other = await secondUser(installation, db);

    expect(
      (await installation.shareLinks.listByCredential(owner.id, [laptop.id])).map((link) => link.id),
    ).toEqual([viaLaptop.id]);
    expect(
      (await installation.shareLinks.listByCredential(owner.id, [laptop.id, phone.id]))
        .map((link) => link.id)
        .sort(),
    ).toEqual([viaLaptop.id, viaPhone.id].sort());
    expect(await installation.shareLinks.listByCredential(other.user.id, [laptop.id, phone.id])).toEqual([]);
    expect(await installation.shareLinks.listByCredential(owner.id, [])).toEqual([]);

    expect(await installation.shareLinks.revokeByCredential(other.user.id, [laptop.id], AT)).toBe(0);
    expect(await installation.shareLinks.revokeByCredential(owner.id, [laptop.id], AT)).toBe(1);
    expect(await installation.shareLinks.isActive(viaLaptop.id)).toBe(false);
    expect(await installation.shareLinks.isActive(viaPhone.id)).toBe(true);
    expect(await installation.shareLinks.revokeByCredential(owner.id, [laptop.id], AT)).toBe(0);
  });

  it('keeps a link when the key it descends from is deleted, forgetting the key', async () => {
    const { db, installation, repos, owner, deck } = await setup();
    const key = await installation.credentials.createKey({
      userId: owner.id,
      label: 'Laptop',
      secretHash: 'c'.repeat(64),
    });
    const link = await repos.shareLinks.create({
      deckId: deck.id,
      tokenHash: OTHER_HASH,
      label: 'Via laptop',
      includeNotes: false,
      createdByUserId: owner.id,
      credentialId: key.id,
    });
    await db.run(sql`DELETE FROM credentials WHERE id = ${key.id}`);
    expect((await repos.shareLinks.findActive(OTHER_HASH))?.link).toEqual({ ...link, credentialId: null });
  });
});
