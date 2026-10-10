/**
 * The owner's share links (ADR 0007): a new link's URL is the only place its token
 * exists; labels follow the account system's text rules; links record the key the
 * creating session descends from; and every operation is confined to the owner's
 * workspace, so another user can neither list nor revoke them.
 */
import { describe, expect, it } from 'vitest';

import { hashToken, parseToken } from '@/server/auth/tokens';
import { countRows } from '@tests/support/db';
import { expectServiceError, keyOfBookmarklet, signUp } from '@tests/support/auth';
import { createServiceHarness, defined, trackDeck } from '@tests/support/services';
import { APP_URL, openShared, sharedHistory, shareLinksOf, tokenOfShareUrl } from '@tests/support/sharing';

describe('share link services', () => {
  it('creates a link whose URL is the only place its token exists', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);

    const created = await shareLinks.createShareLink(
      deckId,
      { label: 'For Pekka', includeNotes: false },
      APP_URL,
    );
    const token = tokenOfShareUrl(created.url);
    expect(parseToken('share', token)).toBe(token);
    expect(created.url).toBe(`${APP_URL}/s/${token}`);
    expect(created.link).toEqual({
      id: created.link.id,
      deckId,
      label: 'For Pekka',
      includeNotes: false,
      createdAt: harness.clock.iso(),
      lastViewedAt: null,
    });

    const rows = JSON.stringify(harness.db.$client.prepare('SELECT * FROM share_links').all());
    expect(rows).toContain(hashToken(token));
    expect(rows).not.toContain(token);
    expect(JSON.stringify(harness.logger.entries)).not.toContain(token);
    expect(JSON.stringify(await shareLinks.listShareLinks(deckId))).not.toContain(token);
    expect(await shareLinks.listShareLinks(deckId)).toEqual([created.link]);
  });

  it('makes a different token every time, even with the same label', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);
    const input = { label: 'Discord', includeNotes: true };
    const first = await shareLinks.createShareLink(deckId, input, APP_URL);
    const second = await shareLinks.createShareLink(deckId, input, APP_URL);
    expect(first.url).not.toBe(second.url);
    expect((await shareLinks.listShareLinks(deckId)).map((link) => link.id)).toEqual(
      expect.arrayContaining([first.link.id, second.link.id]),
    );
  });

  it('normalizes labels and refuses invalid ones, storing nothing', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);
    const create = (label: string) =>
      shareLinks.createShareLink(deckId, { label, includeNotes: false }, APP_URL);

    expect((await create('  For   Pekka \n')).link.label).toBe('For Pekka');
    expect((await create('Café')).link.label).toBe('Café');
    expect((await create('x'.repeat(60))).link.label).toHaveLength(60);
    const before = countRows(harness.db, 'share_links');
    await expectServiceError(create('   '), 'invalid-input');
    await expectServiceError(create('x'.repeat(61)), 'invalid-input');
    await expectServiceError(create('Pekka‮'), 'invalid-input');
    await expectServiceError(create('Line\u0000break'), 'invalid-input');
    await expectServiceError(
      shareLinks.createShareLink(deckId, { label: 'Ok', includeNotes: 'yes' as unknown as boolean }, APP_URL),
      'invalid-input',
    );
    await expect(
      shareLinks.createShareLink(deckId, { label: 'Ok', includeNotes: false }, 'decks.example.com'),
    ).rejects.toThrow(TypeError);
    await expect(
      shareLinks.createShareLink(deckId, { label: 'Ok', includeNotes: false }, 'javascript:alert(1)'),
    ).rejects.toThrow(TypeError);
    expect(countRows(harness.db, 'share_links')).toBe(before);
  });

  it('records the key the creating session descends from', async () => {
    const harness = createServiceHarness();
    const { owner, deckId } = await sharedHistory(harness);
    const key = await harness.auth.createBookmarkletKey(owner.user, 'Laptop', APP_URL);
    const viaKey = defined(
      await harness.auth.signInWithKey(keyOfBookmarklet(key.bookmarklets.popup), 'Laptop'),
    );

    await shareLinksOf(harness, viaKey.user).createShareLink(
      deckId,
      { label: 'Via key', includeNotes: false },
      APP_URL,
    );
    await shareLinksOf(harness, owner.user).createShareLink(
      deckId,
      { label: 'Via invite', includeNotes: false },
      APP_URL,
    );
    const rows = harness.db.$client
      .prepare(
        'SELECT label, credential_id AS credentialId, created_by_user_id AS userId FROM share_links ORDER BY label',
      )
      .all();
    expect(rows).toEqual([
      { label: 'Via invite', credentialId: null, userId: owner.user.id },
      { label: 'Via key', credentialId: key.key.id, userId: owner.user.id },
    ]);
  });

  it('makes nothing for a session that has ended meanwhile', async () => {
    const harness = createServiceHarness();
    const { owner, shareLinks, deckId } = await sharedHistory(harness);
    await harness.auth.endAllSessions(owner.user);
    await expectServiceError(
      shareLinks.createShareLink(deckId, { label: 'Late', includeNotes: false }, APP_URL),
      'forbidden',
    );
    expect(countRows(harness.db, 'share_links')).toBe(0);
  });

  it('confines every operation to the owner’s workspace', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);
    const created = await shareLinks.createShareLink(
      deckId,
      { label: 'For Pekka', includeNotes: true },
      APP_URL,
    );
    const bob = await signUp(harness.auth, 'Bob');
    const bobs = shareLinksOf(harness, bob.user);
    const bobsDeck = await trackDeck({
      ...harness,
      services: harness.servicesForWorkspace(bob.user.workspaceId),
    });

    // Bob cannot share Mikko's deck, list its links or revoke them, by any combination of ids.
    await expectServiceError(
      bobs.createShareLink(deckId, { label: 'Stolen', includeNotes: true }, APP_URL),
      'not-found',
    );
    expect(await bobs.listShareLinks(deckId)).toEqual([]);
    expect(await bobs.revokeShareLink(deckId, created.link.id)).toBe(false);
    expect(await bobs.revokeShareLink(bobsDeck, created.link.id)).toBe(false);
    expect(await shareLinks.listShareLinks(deckId)).toEqual([created.link]);
    expect(await openShared(harness, tokenOfShareUrl(created.url))).not.toBeNull();

    // Mikko cannot reach Bob's deck either.
    await expectServiceError(
      shareLinks.createShareLink(bobsDeck, { label: 'Nope', includeNotes: false }, APP_URL),
      'not-found',
    );
    expect(await shareLinks.listShareLinks(bobsDeck)).toEqual([]);
  });

  it('revokes a link at once and idempotently, leaving the deck’s other links working', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);
    const pekka = await shareLinks.createShareLink(deckId, { label: 'Pekka', includeNotes: false }, APP_URL);
    const discord = await shareLinks.createShareLink(
      deckId,
      { label: 'Discord', includeNotes: false },
      APP_URL,
    );
    const viewer = defined(await openShared(harness, tokenOfShareUrl(pekka.url)));

    expect(await shareLinks.revokeShareLink(deckId, pekka.link.id)).toBe(true);
    expect(await shareLinks.revokeShareLink(deckId, pekka.link.id)).toBe(false);
    expect(await shareLinks.revokeShareLink(deckId, 'no-such-link')).toBe(false);
    expect(await openShared(harness, tokenOfShareUrl(pekka.url))).toBeNull();
    expect(await viewer.services.getOverview()).toBeNull();
    expect(await openShared(harness, tokenOfShareUrl(discord.url))).not.toBeNull();
    expect((await shareLinks.listShareLinks(deckId)).map((link) => link.label)).toEqual(['Discord']);
  });

  it('lists when each link was last viewed', async () => {
    const harness = createServiceHarness();
    const { shareLinks, deckId } = await sharedHistory(harness);
    const created = await shareLinks.createShareLink(
      deckId,
      { label: 'Pekka', includeNotes: false },
      APP_URL,
    );
    harness.clock.advance(60);
    await openShared(harness, tokenOfShareUrl(created.url));
    expect(await shareLinks.listShareLinks(deckId)).toEqual([
      { ...created.link, lastViewedAt: harness.clock.iso() },
    ]);
  });
});
