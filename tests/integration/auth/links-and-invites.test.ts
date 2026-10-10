/**
 * One-time ways in (ADR 0006): device and recovery links for existing users, invites
 * for new ones. All expire, work once (also when used concurrently) and are stored
 * hashed; admins (or the command line) create invites and recovery links.
 */
import { describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import {
  DEVICE_LINK_LIFETIME_MS,
  INVITE_LIFETIME_MS,
  RECOVERY_LINK_LIFETIME_MS,
  SYSTEM_ACTOR,
} from '@/server/auth/service';
import { hashToken } from '@/server/auth/tokens';
import { countRows } from '@tests/support/db';
import { expectServiceError, keyOfBookmarklet, signUp, tokenOfPath } from '@tests/support/auth';
import { blueFarmSpec, BLUE_FARM_URL, createServiceHarness, defined } from '@tests/support/services';

describe('device links', () => {
  it('sign another device in once, within 15 minutes', async () => {
    const harness = createServiceHarness();
    const { user } = await signUp(harness.auth, 'Mikko');
    const link = await harness.auth.createDeviceLink(user);
    expect(link.path).toMatch(/^\/signin\/gml_[A-Za-z0-9_-]{43}$/);
    expect(link.expiresAt).toBe(new Date(harness.clock.epochMs() + DEVICE_LINK_LIFETIME_MS).toISOString());
    const token = tokenOfPath(link.path);
    expect(harness.db.$client.prepare('SELECT token_hash AS hash FROM login_links').all()).toEqual([
      { hash: hashToken(token) },
    ]);

    expect(await harness.auth.getLoginLink(token)).toEqual({
      status: 'valid',
      purpose: 'device',
      displayName: 'Mikko',
      expiresAt: link.expiresAt,
    });
    const signIn = defined(await harness.auth.consumeLoginLink(token, 'Phone'));
    expect(signIn.user.id).toBe(user.id);
    expect((await harness.auth.listSessions(signIn.user)).find((entry) => entry.current)?.createdVia).toBe(
      'device-link',
    );
    expect(await harness.auth.consumeLoginLink(token, 'Phone')).toBeNull();
    expect(await harness.auth.getLoginLink(token)).toEqual({ status: 'used' });
    expect(JSON.stringify(harness.logger.entries)).not.toContain(token);
  });

  it('expire, and do nothing for disabled users or malformed tokens', async () => {
    const harness = createServiceHarness();
    const { user } = await signUp(harness.auth, 'Mikko');
    const expiring = tokenOfPath((await harness.auth.createDeviceLink(user)).path);
    const forDisabled = tokenOfPath((await harness.auth.createDeviceLink(user)).path);

    harness.clock.advance(DEVICE_LINK_LIFETIME_MS / 1000);
    expect(await harness.auth.getLoginLink(expiring)).toEqual({ status: 'expired' });
    expect(await harness.auth.consumeLoginLink(expiring, 'Phone')).toBeNull();

    harness.repos.users.setDisabled(user.id, true);
    expect(await harness.auth.getLoginLink(forDisabled)).toEqual({ status: 'expired' });
    expect(await harness.auth.getLoginLink('gml_short')).toEqual({ status: 'invalid' });
    expect(await harness.auth.getLoginLink(`gmi_${'A'.repeat(43)}`)).toEqual({ status: 'invalid' });
    expect(await harness.auth.consumeLoginLink(undefined, 'Phone')).toBeNull();
  });

  it('cannot be used for a disabled user', async () => {
    const harness = createServiceHarness();
    const { user } = await signUp(harness.auth, 'Mikko');
    const token = tokenOfPath((await harness.auth.createDeviceLink(user)).path);
    harness.repos.users.setDisabled(user.id, true);
    expect(await harness.auth.getLoginLink(token)).toEqual({ status: 'invalid' });
    expect(await harness.auth.consumeLoginLink(token, 'Phone')).toBeNull();
  });

  it('sign in exactly once when used twice at the same time', async () => {
    const harness = createServiceHarness();
    const { user } = await signUp(harness.auth, 'Mikko');
    const token = tokenOfPath((await harness.auth.createDeviceLink(user)).path);
    const results = await Promise.all([
      harness.auth.consumeLoginLink(token, 'A'),
      harness.auth.consumeLoginLink(token, 'B'),
      harness.auth.consumeLoginLink(token, 'C'),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
  });
});

describe('recovery links', () => {
  it('are created by admins or the command line for 24 hours; only the newest works', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');

    await expectServiceError(harness.auth.createRecoveryLink(member.user, admin.user.id), 'forbidden');
    const byAdmin = await harness.auth.createRecoveryLink(admin.user, member.user.id);
    expect(byAdmin.expiresAt).toBe(
      new Date(harness.clock.epochMs() + RECOVERY_LINK_LIFETIME_MS).toISOString(),
    );
    expect(await harness.auth.getLoginLink(tokenOfPath(byAdmin.path))).toMatchObject({
      status: 'valid',
      purpose: 'recovery',
      displayName: 'Mikko',
    });
    const bySystem = await harness.auth.createRecoveryLink(SYSTEM_ACTOR, member.user.id);
    expect(await harness.auth.getLoginLink(tokenOfPath(byAdmin.path))).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(tokenOfPath(byAdmin.path), 'Old link')).toBeNull();

    const signIn = defined(await harness.auth.consumeLoginLink(tokenOfPath(bySystem.path), 'New laptop'));
    expect(signIn.user.id).toBe(member.user.id);
    expect((await harness.auth.listSessions(signIn.user)).find((entry) => entry.current)?.createdVia).toBe(
      'recovery-link',
    );
    expect(JSON.stringify(harness.logger.entries)).not.toContain(tokenOfPath(bySystem.path));
  });

  it('are refused for unknown and disabled users, and for the asking admin themselves', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    await expectServiceError(harness.auth.createRecoveryLink(SYSTEM_ACTOR, 'nope'), 'not-found');
    await expectServiceError(harness.auth.createRecoveryLink(admin.user, admin.user.id), 'invalid-input');
    harness.repos.users.setDisabled(member.user.id, true);
    await expectServiceError(harness.auth.createRecoveryLink(SYSTEM_ACTOR, member.user.id), 'invalid-input');
    expect(countRows(harness.db, 'login_links')).toBe(0);
    // The command line may make one for an admin (the operator helping themselves).
    await harness.auth.createRecoveryLink(SYSTEM_ACTOR, admin.user.id);
  });

  it('sign out every other device of the person, revoke their keys and withdraw their links', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    const key = keyOfBookmarklet(
      (await harness.auth.createBookmarkletKey(member.user, 'Lost laptop', 'http://localhost:3000'))
        .bookmarklets.popup,
    );
    const viaKey = defined(await harness.auth.signInWithKey(key, 'Lost laptop'));
    const deviceLink = tokenOfPath((await harness.auth.createDeviceLink(member.user)).path);
    const recovery = tokenOfPath((await harness.auth.createRecoveryLink(admin.user, member.user.id)).path);

    const recovered = defined(await harness.auth.consumeLoginLink(recovery, 'New laptop'));
    expect(await harness.auth.resolveSession(member.session.token)).toBeNull();
    expect(await harness.auth.resolveSession(viaKey.session.token)).toBeNull();
    expect(await harness.auth.signInWithKey(key, 'Lost laptop')).toBeNull();
    expect(await harness.auth.listKeys(recovered.user)).toEqual([]);
    expect(await harness.auth.getLoginLink(deviceLink)).toEqual({ status: 'revoked' });
    expect((await harness.auth.listSessions(recovered.user)).map((entry) => entry.id)).toEqual([
      recovered.session.id,
    ]);
    expect(await harness.auth.resolveSession(admin.session.token)).not.toBeNull();
  });

  it('leave a record the person sees, which signing the recovered browser out does not erase', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    expect(await harness.auth.listRecoveryUses(member.user)).toEqual([]);
    const issued = await harness.auth.createRecoveryLink(admin.user, member.user.id);
    const createdAt = harness.clock.iso();
    harness.clock.advance(60);
    const recovered = defined(
      await harness.auth.consumeLoginLink(tokenOfPath(issued.path), 'Private window'),
    );
    await harness.auth.endSession(recovered.session.token);

    const later = await signUp(harness.auth, 'Someone else');
    expect(await harness.auth.listRecoveryUses(later.user)).toEqual([]);
    const relogin = tokenOfPath((await harness.auth.createRecoveryLink(SYSTEM_ACTOR, member.user.id)).path);
    harness.clock.advance(60);
    const back = defined(await harness.auth.consumeLoginLink(relogin, 'Mikko’s laptop'));
    expect(await harness.auth.listRecoveryUses(back.user)).toEqual([
      {
        createdBy: null,
        createdAt: new Date(harness.clock.epochMs() - 60_000).toISOString(),
        usedAt: harness.clock.iso(),
      },
      { createdBy: 'Admin', createdAt, usedAt: new Date(Date.parse(createdAt) + 60_000).toISOString() },
    ]);
  });

  it('between admins sign the other admin out everywhere, so a takeover cannot go unnoticed', async () => {
    const harness = createServiceHarness();
    const first = await signUp(harness.auth, 'First', { role: 'admin' });
    const second = await signUp(harness.auth, 'Second', { role: 'admin' });
    const link = tokenOfPath((await harness.auth.createRecoveryLink(first.user, second.user.id)).path);
    const asSecond = defined(await harness.auth.consumeLoginLink(link, 'Somewhere'));
    expect(asSecond.user).toMatchObject({ id: second.user.id, role: 'admin' });
    expect(await harness.auth.resolveSession(second.session.token)).toBeNull();
    expect(await harness.auth.listRecoveryUses(asSecond.user)).toMatchObject([{ createdBy: 'First' }]);
  });

  it('are listed to admins (never their tokens) and can be withdrawn', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    const other = await signUp(harness.auth, 'Anna');
    const issued = await harness.auth.createRecoveryLink(admin.user, member.user.id);
    await harness.auth.createRecoveryLink(SYSTEM_ACTOR, other.user.id);
    const used = tokenOfPath((await harness.auth.createRecoveryLink(SYSTEM_ACTOR, admin.user.id)).path);
    await harness.auth.consumeLoginLink(used, 'Admin laptop');

    await expectServiceError(harness.auth.listRecoveryLinks(member.user), 'forbidden');
    const listed = await harness.auth.listRecoveryLinks(SYSTEM_ACTOR);
    expect(listed.map((link) => [link.user.displayName, link.createdBy])).toEqual([
      ['Anna', null],
      ['Mikko', 'Admin'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(tokenOfPath(issued.path));
    const forMikko = defined(listed.find((link) => link.user.id === member.user.id));
    expect(forMikko).toEqual({
      id: forMikko.id,
      user: { id: member.user.id, displayName: 'Mikko' },
      createdBy: 'Admin',
      createdAt: harness.clock.iso(),
      expiresAt: issued.expiresAt,
    });

    await expectServiceError(harness.auth.revokeRecoveryLink(member.user, forMikko.id), 'forbidden');
    expect(await harness.auth.revokeRecoveryLink(SYSTEM_ACTOR, forMikko.id)).toBe(true);
    expect(await harness.auth.revokeRecoveryLink(SYSTEM_ACTOR, forMikko.id)).toBe(false);
    expect(await harness.auth.getLoginLink(tokenOfPath(issued.path))).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(tokenOfPath(issued.path), 'Mikko')).toBeNull();
    expect((await harness.auth.listRecoveryLinks(SYSTEM_ACTOR)).map((link) => link.user.displayName)).toEqual(
      ['Anna'],
    );
  });

  it('cannot withdraw a device link through the recovery link admin action', async () => {
    const harness = createServiceHarness();
    const member = await signUp(harness.auth, 'Mikko');
    const device = tokenOfPath((await harness.auth.createDeviceLink(member.user)).path);
    const id = defined(harness.repos.loginLinks.getByTokenHash(hashToken(device))).id;
    expect(await harness.auth.revokeRecoveryLink(SYSTEM_ACTOR, id)).toBe(false);
    expect(await harness.auth.getLoginLink(device)).toMatchObject({ status: 'valid' });
  });
});

describe('device links and keys', () => {
  it('start a session that descends from the key of the session that made the link', async () => {
    const harness = createServiceHarness();
    const owner = await signUp(harness.auth, 'Mikko');
    const created = await harness.auth.createBookmarkletKey(owner.user, 'Laptop', 'http://localhost:3000');
    const viaKey = defined(
      await harness.auth.signInWithKey(keyOfBookmarklet(created.bookmarklets.popup), 'Laptop'),
    );
    const fromInvite = tokenOfPath((await harness.auth.createDeviceLink(owner.user)).path);
    const fromKey = tokenOfPath((await harness.auth.createDeviceLink(viaKey.user)).path);
    const phoneA = defined(await harness.auth.consumeLoginLink(fromInvite, 'Phone A'));
    const phoneB = defined(await harness.auth.consumeLoginLink(fromKey, 'Phone B'));

    await harness.auth.revokeKey(owner.user, created.key.id);
    expect(await harness.auth.resolveSession(phoneA.session.token)).not.toBeNull();
    expect(await harness.auth.resolveSession(phoneB.session.token)).toBeNull();
    expect((await harness.auth.listSessions(phoneA.user)).map((entry) => entry.createdVia).sort()).toEqual([
      'device-link',
      'invite',
    ]);
  });
});

describe('invites', () => {
  it('are created by admins or the command line, never by members', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');

    await expectServiceError(harness.auth.createInvite(member.user, { role: 'member' }), 'forbidden');
    await expectServiceError(harness.auth.listInvites(member.user), 'forbidden');
    const issued = await harness.auth.createInvite(admin.user, { role: 'member', note: ' for  Anna ' });
    expect(issued.path).toMatch(/^\/invite\/gmi_[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresAt).toBe(new Date(harness.clock.epochMs() + INVITE_LIFETIME_MS).toISOString());
    expect(issued.invite).toMatchObject({
      role: 'member',
      note: 'for Anna',
      status: 'pending',
      createdBy: 'Admin',
    });

    await expectServiceError(
      harness.auth.createInvite(admin.user, { role: 'member', note: 'x'.repeat(201) }),
      'invalid-input',
    );
    await expectServiceError(
      harness.auth.createInvite(admin.user, { role: 'owner' as unknown as 'member' }),
      'invalid-input',
    );
    expect(JSON.stringify(harness.logger.entries)).not.toContain(tokenOfPath(issued.path));
  });

  it('create a user with a workspace of their own and sign them in', async () => {
    const harness = createServiceHarness();
    const issued = await harness.auth.createInvite(SYSTEM_ACTOR, { role: 'member', note: 'for Anna' });
    const token = tokenOfPath(issued.path);
    expect(await harness.auth.getInvite(token)).toEqual({
      status: 'valid',
      role: 'member',
      expiresAt: issued.expiresAt,
    });

    const outcome = await harness.auth.acceptInvite(token, ' Anna ', 'Firefox');
    if (!outcome.ok) throw new Error(outcome.message);
    const { user } = outcome.signIn;
    expect(user).toMatchObject({ displayName: 'Anna', role: 'member' });
    expect(user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(await harness.auth.resolveSession(outcome.signIn.session.token)).toEqual(user);
    expect(await harness.auth.getInvite(token)).toEqual({ status: 'used' });
    expect(await harness.auth.acceptInvite(token, 'Anna again', 'Firefox')).toMatchObject({
      ok: false,
      reason: 'used',
    });

    const [listed] = await harness.auth.listInvites(SYSTEM_ACTOR);
    expect(listed).toMatchObject({
      status: 'used',
      createdBy: null,
      usedBy: { id: user.id, displayName: 'Anna' },
    });
  });

  it('keep an invite usable when the name is invalid', async () => {
    const harness = createServiceHarness();
    const token = tokenOfPath((await harness.auth.createInvite(SYSTEM_ACTOR, { role: 'member' })).path);
    expect(await harness.auth.acceptInvite(token, '   ', 'Firefox')).toMatchObject({
      ok: false,
      reason: 'invalid-name',
    });
    expect(await harness.auth.getInvite(token)).toMatchObject({ status: 'valid' });
  });

  it('expire after 7 days, can be revoked while unused, and reject malformed tokens', async () => {
    const harness = createServiceHarness();
    const expiring = await harness.auth.createInvite(SYSTEM_ACTOR, { role: 'member' });
    const revoked = await harness.auth.createInvite(SYSTEM_ACTOR, { role: 'member' });

    expect(await harness.auth.revokeInvite(SYSTEM_ACTOR, revoked.invite.id)).toBe(true);
    expect(await harness.auth.revokeInvite(SYSTEM_ACTOR, revoked.invite.id)).toBe(false);
    expect(await harness.auth.getInvite(tokenOfPath(revoked.path))).toEqual({ status: 'revoked' });
    expect(await harness.auth.acceptInvite(tokenOfPath(revoked.path), 'X', null)).toMatchObject({
      reason: 'revoked',
    });

    harness.clock.advance(INVITE_LIFETIME_MS / 1000);
    expect(await harness.auth.getInvite(tokenOfPath(expiring.path))).toEqual({ status: 'expired' });
    expect(await harness.auth.acceptInvite(tokenOfPath(expiring.path), 'X', null)).toMatchObject({
      reason: 'expired',
    });
    expect((await harness.auth.listInvites(SYSTEM_ACTOR)).map((invite) => invite.status).sort()).toEqual([
      'expired',
      'revoked',
    ]);

    expect(await harness.auth.getInvite('gmi_short')).toEqual({ status: 'invalid' });
    expect(await harness.auth.acceptInvite(`gmi_${'A'.repeat(43)}`, 'X', null)).toMatchObject({
      reason: 'invalid',
    });
    expect(harness.repos.users.count()).toBe(0);
  });

  it('create exactly one user when accepted twice at the same time', async () => {
    const harness = createServiceHarness();
    const token = tokenOfPath((await harness.auth.createInvite(SYSTEM_ACTOR, { role: 'member' })).path);
    const outcomes = await Promise.all([
      harness.auth.acceptInvite(token, 'First', null),
      harness.auth.acceptInvite(token, 'Second', null),
    ]);
    expect(outcomes.map((outcome) => (outcome.ok ? 'ok' : outcome.reason)).sort()).toEqual(['ok', 'used']);
    expect(harness.repos.users.count()).toBe(1);
  });

  it('let the first admin adopt the history of a pre-account installation (the command-line claim)', async () => {
    const harness = createServiceHarness();
    // A single-user installation: a deck in the `local` workspace, no users.
    harness.api.setDeck(blueFarmSpec());
    const tracked = await harness.services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);

    const member = await signUp(harness.auth, 'Member first');
    expect(member.user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    const admin = await signUp(harness.auth, 'Operator', { role: 'admin' });
    expect(admin.user.workspaceId).toBe(LOCAL_WORKSPACE_ID);
    const decks = await harness.servicesForWorkspace(admin.user.workspaceId).listDecks();
    expect(decks.map((deck) => deck.id)).toEqual([tracked.deckId]);

    const second = await signUp(harness.auth, 'Second admin', { role: 'admin' });
    expect(second.user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(defined(harness.repos.users.getByWorkspaceId(LOCAL_WORKSPACE_ID)).id).toBe(admin.user.id);
  });

  it('give the first admin of a fresh installation a workspace of their own', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Operator', { role: 'admin' });
    expect(admin.user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(harness.repos.users.getByWorkspaceId(LOCAL_WORKSPACE_ID)).toBeNull();
  });
});
