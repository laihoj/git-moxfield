/**
 * Share link repository (ADR 0007): links are stored by token hash only; a link works
 * while it is not revoked, its deck is tracked and the deck's owner is not disabled; the
 * owner's operations are scoped to the bound workspace; links can be found and revoked
 * by the key their creating session descends from, for their creator only, and all of a
 * workspace's links can be revoked at once (account recovery).
 */
import { describe, expect, it } from 'vitest';

import { createRepositories, type Repositories, type UserRecord } from '@/server/repositories';
import { countRows, createTestDeck, createTestRepositories, expectRepositoryError } from '@tests/support/db';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const AT = '2026-06-01T12:00:00.000Z';

function setup() {
  const { db, repos: installation } = createTestRepositories();
  const owner = installation.users.create({ displayName: 'Mikko', role: 'member' });
  const repos = createRepositories(db, { workspaceId: owner.workspaceId });
  const deck = createTestDeck(repos);
  const link = repos.shareLinks.create({
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
function secondUser(installation: Repositories, db: Parameters<typeof createRepositories>[0]) {
  const user = installation.users.create({ displayName: 'Pekka', role: 'member' });
  const repos = createRepositories(db, { workspaceId: user.workspaceId });
  return { user, repos, deck: createTestDeck(repos) };
}

describe('share link repository', () => {
  it('stores a link by its token hash only and returns a record without it', () => {
    const { db, link, deck, owner } = setup();
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
    expect(db.$client.prepare('SELECT token_hash AS hash FROM share_links').all()).toEqual([{ hash: HASH }]);
  });

  it('creates links only for decks of the bound workspace, and refuses a taken hash', () => {
    const { db, installation, repos, owner, deck } = setup();
    const other = secondUser(installation, db);
    const input = {
      tokenHash: OTHER_HASH,
      label: 'x',
      includeNotes: false,
      createdByUserId: owner.id,
      credentialId: null,
    };
    expectRepositoryError(() => repos.shareLinks.create({ ...input, deckId: other.deck.id }), 'not-found');
    expectRepositoryError(() => repos.shareLinks.create({ ...input, deckId: 'no-such-deck' }), 'not-found');
    expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: deck.id, tokenHash: HASH }),
      'conflict',
    );
    expectRepositoryError(
      () => repos.shareLinks.create({ ...input, deckId: deck.id, tokenHash: '' }),
      'invalid-input',
    );
    expect(countRows(db, 'share_links')).toBe(1);
  });

  it('resolves an active link installation-wide, with its workspace and owner', () => {
    const { db, link, owner } = setup();
    // Any binding resolves tokens: the token is its own authorization.
    const elsewhere = createRepositories(db);
    expect(elsewhere.shareLinks.findActive(HASH)).toEqual({
      link,
      workspaceId: owner.workspaceId,
      ownerDisplayName: 'Mikko',
    });
    expect(elsewhere.shareLinks.isActive(link.id)).toBe(true);
    expect(elsewhere.shareLinks.findActive(OTHER_HASH)).toBeNull();
    expect(elsewhere.shareLinks.isActive('no-such-link')).toBe(false);
  });

  it('stops resolving a revoked link, for good', () => {
    const { repos, deck, link } = setup();
    expect(repos.shareLinks.revoke(deck.id, link.id, AT)).toBe(true);
    expect(repos.shareLinks.findActive(HASH)).toBeNull();
    expect(repos.shareLinks.isActive(link.id)).toBe(false);
    // Idempotent: a second revocation changes nothing, and keeps the first time.
    expect(repos.shareLinks.revoke(deck.id, link.id, '2027-01-01T00:00:00.000Z')).toBe(false);
    expect(repos.shareLinks.listForDeck(deck.id)).toEqual([]);
  });

  it('stops resolving the links of an untracked deck: they are deleted with it', () => {
    const { db, repos, deck, link } = setup();
    expect(repos.decks.delete(deck.id)).toBe(true);
    expect(repos.shareLinks.findActive(HASH)).toBeNull();
    expect(repos.shareLinks.isActive(link.id)).toBe(false);
    expect(countRows(db, 'share_links')).toBe(0);
  });

  it('suspends the links of a disabled owner while they are disabled', () => {
    const { repos, owner, link } = setup();
    repos.users.setDisabled(owner.id, true);
    expect(repos.shareLinks.findActive(HASH)).toBeNull();
    expect(repos.shareLinks.isActive(link.id)).toBe(false);
    repos.users.setDisabled(owner.id, false);
    expect(repos.shareLinks.findActive(HASH)?.link.id).toBe(link.id);
  });

  it('resolves no link to a deck of a workspace without an owner', () => {
    const { db } = createTestRepositories();
    // The `local` workspace of a pre-account installation, not adopted yet.
    const local = createRepositories(db);
    const user: UserRecord = local.users.create({ displayName: 'Stranger', role: 'member' });
    const deck = createTestDeck(local);
    local.shareLinks.create({
      deckId: deck.id,
      tokenHash: HASH,
      label: 'x',
      includeNotes: false,
      createdByUserId: user.id,
      credentialId: null,
    });
    expect(local.shareLinks.findActive(HASH)).toBeNull();
  });

  it('lists and revokes links of the bound workspace’s decks only', () => {
    const { db, installation, repos, deck, link } = setup();
    const other = secondUser(installation, db);
    const later = repos.shareLinks.create({
      deckId: deck.id,
      tokenHash: OTHER_HASH,
      label: 'Discord',
      includeNotes: false,
      createdByUserId: link.createdByUserId ?? '',
      credentialId: null,
    });
    expect(repos.shareLinks.listForDeck(deck.id).map((entry) => entry.id)).toEqual([later.id, link.id]);

    // Another workspace sees nothing of them and cannot revoke them, even naming the deck.
    expect(other.repos.shareLinks.listForDeck(deck.id)).toEqual([]);
    expect(other.repos.shareLinks.revoke(deck.id, link.id, AT)).toBe(false);
    expect(other.repos.shareLinks.revoke(other.deck.id, link.id, AT)).toBe(false);
    // Nor through another deck of the owner's own workspace.
    const second = createTestDeck(repos);
    expect(repos.shareLinks.revoke(second.id, link.id, AT)).toBe(false);
    expect(repos.shareLinks.findActive(HASH)?.link.id).toBe(link.id);
  });

  it('revokes every link of a workspace’s decks at once, and no other workspace’s (recovery)', () => {
    const { db, installation, repos, owner, deck, link } = setup();
    const other = secondUser(installation, db);
    const second = createTestDeck(repos);
    const viaKeyless = repos.shareLinks.create({
      deckId: second.id,
      tokenHash: OTHER_HASH,
      label: 'Made by someone else',
      includeNotes: false,
      createdByUserId: other.user.id,
      credentialId: null,
    });
    const othersLink = other.repos.shareLinks.create({
      deckId: other.deck.id,
      tokenHash: 'c'.repeat(64),
      label: 'Pekka’s',
      includeNotes: false,
      createdByUserId: other.user.id,
      credentialId: null,
    });
    repos.shareLinks.revoke(deck.id, link.id, '2026-05-01T00:00:00.000Z');

    // Installation-wide: the workspace is named, whatever the context is bound to.
    expect(installation.shareLinks.revokeAllForWorkspace(owner.workspaceId, AT)).toBe(1);
    expect(repos.shareLinks.findActive(OTHER_HASH)).toBeNull();
    expect(repos.shareLinks.listForDeck(second.id)).toEqual([]);
    // An earlier revocation keeps its time; another workspace's links keep working.
    expect(
      db.$client.prepare('SELECT id, revoked_at AS revokedAt FROM share_links ORDER BY revoked_at').all(),
    ).toEqual([
      { id: othersLink.id, revokedAt: null },
      { id: link.id, revokedAt: '2026-05-01T00:00:00.000Z' },
      { id: viaKeyless.id, revokedAt: AT },
    ]);
    expect(installation.shareLinks.revokeAllForWorkspace(owner.workspaceId, AT)).toBe(0);
  });

  it('records a view at most once per interval', () => {
    const { repos, link } = setup();
    const view = (at: string, since: string) => repos.shareLinks.touchViewed(link.id, at, since);
    expect(view('2026-06-01T12:00:00.000Z', '2026-06-01T11:00:00.000Z')).toBe(true);
    expect(view('2026-06-01T12:59:59.000Z', '2026-06-01T11:59:59.000Z')).toBe(false);
    expect(repos.shareLinks.findActive(HASH)?.link.lastViewedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(view('2026-06-01T13:00:00.001Z', '2026-06-01T12:00:00.001Z')).toBe(true);
    expect(repos.shareLinks.findActive(HASH)?.link.lastViewedAt).toBe('2026-06-01T13:00:00.001Z');
  });

  it('finds and revokes links by the keys their sessions descend from, for their creator only', () => {
    const { db, installation, repos, owner, deck } = setup();
    const laptop = installation.credentials.createKey({
      userId: owner.id,
      label: 'Laptop',
      secretHash: 'c'.repeat(64),
    });
    const phone = installation.credentials.createKey({
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
    const viaLaptop = make(1, laptop.id);
    const viaPhone = make(2, phone.id);
    const revokedViaLaptop = make(3, laptop.id);
    repos.shareLinks.revoke(deck.id, revokedViaLaptop.id, AT);
    const other = secondUser(installation, db);

    expect(installation.shareLinks.listByCredential(owner.id, [laptop.id]).map((link) => link.id)).toEqual([
      viaLaptop.id,
    ]);
    expect(
      installation.shareLinks
        .listByCredential(owner.id, [laptop.id, phone.id])
        .map((link) => link.id)
        .sort(),
    ).toEqual([viaLaptop.id, viaPhone.id].sort());
    expect(installation.shareLinks.listByCredential(other.user.id, [laptop.id, phone.id])).toEqual([]);
    expect(installation.shareLinks.listByCredential(owner.id, [])).toEqual([]);

    expect(installation.shareLinks.revokeByCredential(other.user.id, [laptop.id], AT)).toBe(0);
    expect(installation.shareLinks.revokeByCredential(owner.id, [laptop.id], AT)).toBe(1);
    expect(installation.shareLinks.isActive(viaLaptop.id)).toBe(false);
    expect(installation.shareLinks.isActive(viaPhone.id)).toBe(true);
    expect(installation.shareLinks.revokeByCredential(owner.id, [laptop.id], AT)).toBe(0);
  });

  it('keeps a link when the key it descends from is deleted, forgetting the key', () => {
    const { db, installation, repos, owner, deck } = setup();
    const key = installation.credentials.createKey({
      userId: owner.id,
      label: 'Laptop',
      secretHash: 'c'.repeat(64),
    });
    const link = repos.shareLinks.create({
      deckId: deck.id,
      tokenHash: OTHER_HASH,
      label: 'Via laptop',
      includeNotes: false,
      createdByUserId: owner.id,
      credentialId: key.id,
    });
    db.$client.prepare('DELETE FROM credentials WHERE id = ?').run(key.id);
    expect(repos.shareLinks.findActive(OTHER_HASH)?.link).toEqual({ ...link, credentialId: null });
  });
});
