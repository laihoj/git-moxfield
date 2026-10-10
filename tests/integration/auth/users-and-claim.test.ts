/**
 * Admin user management and the first-run claim (ADR 0006).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAuthService, SETUP_CODE_SETTING, SYSTEM_ACTOR } from '@/server/auth/service';
import { SETUP_CODE_PATTERN } from '@/server/auth/setup-code';
import { LOCAL_WORKSPACE_ID, openDatabase, type Db } from '@/server/db/client';
import { expectServiceError, keyOfBookmarklet, signUp, tokenOfPath } from '@tests/support/auth';
import {
  blueFarmSpec,
  BLUE_FARM_URL,
  createServiceHarness,
  defined,
  recordingLogger,
} from '@tests/support/services';

describe('user management', () => {
  it('lists users with their decks and keys for admins only', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    await harness.auth.createBookmarkletKey(member.user, 'Laptop', 'http://localhost:3000');

    await expectServiceError(harness.auth.listUsers(member.user), 'forbidden');
    const users = await harness.auth.listUsers(admin.user);
    expect(
      users.map(({ displayName, role, deckCount, activeKeyCount }) => ({
        displayName,
        role,
        deckCount,
        activeKeyCount,
      })),
    ).toEqual([
      { displayName: 'Admin', role: 'admin', deckCount: 0, activeKeyCount: 0 },
      { displayName: 'Mikko', role: 'member', deckCount: 0, activeKeyCount: 1 },
    ]);
    expect(await harness.auth.listUsers(SYSTEM_ACTOR)).toEqual(users);
  });

  it('disables a user: their sessions end and their keys stop working until enabled', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');
    const key = keyOfBookmarklet(
      (await harness.auth.createBookmarkletKey(member.user, 'Laptop', 'http://localhost:3000')).bookmarklets
        .popup,
    );

    const disabled = await harness.auth.disableUser(admin.user, member.user.id);
    expect(disabled).toMatchObject({
      ok: true,
      user: { id: member.user.id, disabledAt: harness.clock.iso() },
    });
    expect(await harness.auth.resolveSession(member.session.token)).toBeNull();
    expect(await harness.auth.signInWithKey(key, 'Firefox')).toBeNull();

    expect(await harness.auth.enableUser(admin.user, member.user.id)).toMatchObject({
      ok: true,
      user: { disabledAt: null },
    });
    expect(await harness.auth.signInWithKey(key, 'Firefox')).not.toBeNull();
    // Sessions ended by disabling stay ended.
    expect(await harness.auth.resolveSession(member.session.token)).toBeNull();
  });

  it('withdraws for good the links that sign a disabled user in, so enabling them revives none', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Bob');
    const deviceLink = tokenOfPath((await harness.auth.createDeviceLink(member.user)).path);
    const recovery = tokenOfPath((await harness.auth.createRecoveryLink(admin.user, member.user.id)).path);

    await harness.auth.disableUser(admin.user, member.user.id);
    expect(await harness.auth.consumeLoginLink(deviceLink, 'Phone')).toBeNull();
    await harness.auth.enableUser(admin.user, member.user.id);
    expect(await harness.auth.getLoginLink(deviceLink)).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(deviceLink, 'Phone')).toBeNull();
    expect(await harness.auth.consumeLoginLink(recovery, 'Phone')).toBeNull();
  });

  it('takes a disabled admin’s invites and recovery links with them, also after enabling them again', async () => {
    const harness = createServiceHarness();
    const root = await signUp(harness.auth, 'Root', { role: 'admin' });
    const mallory = await signUp(harness.auth, 'Mallory', { role: 'admin' });
    const bob = await signUp(harness.auth, 'Bob');
    const adminInvite = tokenOfPath((await harness.auth.createInvite(mallory.user, { role: 'admin' })).path);
    const forRoot = tokenOfPath((await harness.auth.createRecoveryLink(mallory.user, root.user.id)).path);
    const forBob = tokenOfPath((await harness.auth.createRecoveryLink(mallory.user, bob.user.id)).path);

    expect(await harness.auth.disableUser(root.user, mallory.user.id)).toMatchObject({ ok: true });
    expect(await harness.auth.getInvite(adminInvite)).toEqual({ status: 'revoked' });
    expect(await harness.auth.acceptInvite(adminInvite, 'Mallory2', null)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    expect(await harness.auth.getLoginLink(forRoot)).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(forRoot, 'Mallory')).toBeNull();
    expect(await harness.auth.consumeLoginLink(forBob, 'Mallory')).toBeNull();
    expect(await harness.auth.listRecoveryLinks(root.user)).toEqual([]);
    const [listed] = await harness.auth.listInvites(root.user);
    expect(listed).toMatchObject({ status: 'revoked', createdBy: 'Mallory' });

    await harness.auth.enableUser(root.user, mallory.user.id);
    expect(await harness.auth.acceptInvite(adminInvite, 'Mallory2', null)).toMatchObject({ ok: false });
    expect(await harness.auth.consumeLoginLink(forRoot, 'Mallory')).toBeNull();
    expect(harness.repos.users.count()).toBe(3);
  });

  it('refuses an invite whose admin was disabled from the command line', async () => {
    const harness = createServiceHarness();
    await signUp(harness.auth, 'Root', { role: 'admin' });
    const mallory = await signUp(harness.auth, 'Mallory', { role: 'admin' });
    const invite = tokenOfPath((await harness.auth.createInvite(mallory.user, { role: 'member' })).path);
    expect(await harness.auth.disableUser(SYSTEM_ACTOR, mallory.user.id)).toMatchObject({ ok: true });
    expect(await harness.auth.acceptInvite(invite, 'Eve', null)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });

  it('honours an invite or recovery link only while its admin is an active admin (defence in depth)', async () => {
    const harness = createServiceHarness();
    const root = await signUp(harness.auth, 'Root', { role: 'admin' });
    const demoted = await signUp(harness.auth, 'Demoted', { role: 'admin' });
    const bob = await signUp(harness.auth, 'Bob');
    const invite = tokenOfPath((await harness.auth.createInvite(demoted.user, { role: 'admin' })).path);
    const recovery = tokenOfPath((await harness.auth.createRecoveryLink(demoted.user, bob.user.id)).path);
    // No feature demotes an admin; an operator could, in the database. Nothing was revoked.
    harness.db.$client.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(demoted.user.id);

    expect(await harness.auth.getInvite(invite)).toEqual({ status: 'revoked' });
    expect(await harness.auth.acceptInvite(invite, 'Eve', null)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
    expect(await harness.auth.getLoginLink(recovery)).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(recovery, 'Eve')).toBeNull();
    expect((await harness.auth.listInvites(root.user))[0]).toMatchObject({ status: 'revoked' });

    // A device link made by the user themselves is not an admin's link.
    const device = tokenOfPath((await harness.auth.createDeviceLink(demoted.user)).path);
    expect(await harness.auth.consumeLoginLink(device, 'Phone')).not.toBeNull();
  });

  it('never lets an admin disable themselves or the last admin', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    expect(await harness.auth.disableUser(admin.user, admin.user.id)).toMatchObject({
      ok: false,
      reason: 'self',
    });
    expect(await harness.auth.disableUser(SYSTEM_ACTOR, admin.user.id)).toMatchObject({
      ok: false,
      reason: 'last-admin',
    });

    const second = await signUp(harness.auth, 'Second', { role: 'admin' });
    expect(await harness.auth.disableUser(second.user, admin.user.id)).toMatchObject({ ok: true });
    // The remaining admin is the last one now.
    expect(await harness.auth.disableUser(SYSTEM_ACTOR, second.user.id)).toMatchObject({
      reason: 'last-admin',
    });
    expect(await harness.auth.disableUser(SYSTEM_ACTOR, 'nope')).toMatchObject({
      ok: false,
      reason: 'not-found',
    });
  });

  it('re-checks the actor’s role in the database on every admin operation', async () => {
    const harness = createServiceHarness();
    const first = await signUp(harness.auth, 'First', { role: 'admin' });
    const second = await signUp(harness.auth, 'Second', { role: 'admin' });
    await harness.auth.disableUser(first.user, second.user.id);
    // `second.user` still says admin, but the account is disabled now.
    await expectServiceError(harness.auth.listUsers(second.user), 'forbidden');
    await expectServiceError(harness.auth.createInvite(second.user, { role: 'admin' }), 'forbidden');
    await expectServiceError(harness.auth.enableUser(second.user, second.user.id), 'forbidden');
  });

  it('renames users (admins) and oneself (anyone), validating the name', async () => {
    const harness = createServiceHarness();
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    const member = await signUp(harness.auth, 'Mikko');

    expect(await harness.auth.renameSelf(member.user, '  Mikko  V ')).toMatchObject({
      ok: true,
      user: { displayName: 'Mikko V' },
    });
    expect(await harness.auth.renameSelf(member.user, '')).toMatchObject({
      ok: false,
      reason: 'invalid-name',
    });
    expect(await harness.auth.renameUser(admin.user, member.user.id, 'Mikko Virtanen')).toMatchObject({
      ok: true,
    });
    expect(await harness.auth.renameUser(admin.user, 'nope', 'X')).toMatchObject({ reason: 'not-found' });
    await expectServiceError(harness.auth.renameUser(member.user, admin.user.id, 'Hacked'), 'forbidden');
    expect((await harness.auth.resolveSession(member.session.token))?.displayName).toBe('Mikko Virtanen');
  });
});

describe('claim', () => {
  it('creates the setup code once, prints it to the log, and changes nothing when only asked', async () => {
    const harness = createServiceHarness();
    expect(await harness.auth.isClaimable()).toBe(true);
    expect(harness.repos.settings.get(SETUP_CODE_SETTING)).toBeNull();

    expect(await harness.auth.claimStatus()).toEqual({ claimable: true });
    const code = defined(harness.repos.settings.get(SETUP_CODE_SETTING));
    expect(code).toMatch(SETUP_CODE_PATTERN);
    expect(await harness.auth.claimStatus()).toEqual({ claimable: true });
    expect(await harness.auth.setupCode()).toBe(code);

    const announcements = harness.logger.entries.filter((entry) => entry.message.includes(code));
    expect(announcements).toHaveLength(2);
    expect(announcements[0]).toMatchObject({ level: 'warn', context: { path: '/claim' } });
    expect(announcements[0]?.message).toContain('/claim');
  });

  it('includes the public URL in the log message when one is configured', async () => {
    const harness = createServiceHarness({ env: { PUBLIC_APP_URL: 'https://decks.example.com' } });
    await harness.auth.claimStatus();
    expect(harness.logger.entries.at(-1)?.message).toContain('https://decks.example.com/claim');
  });

  it('makes the first admin, who adopts the existing local history', async () => {
    const harness = createServiceHarness();
    harness.api.setDeck(blueFarmSpec());
    const tracked = await harness.services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    await harness.auth.claimStatus();
    const code = defined(await harness.auth.setupCode());

    expect(await harness.auth.claim('AAAA-AAAA-AAAA', 'Owner', null)).toMatchObject({
      ok: false,
      reason: 'invalid-code',
    });
    expect(await harness.auth.claim(code, '', null)).toMatchObject({ ok: false, reason: 'invalid-name' });

    const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
    const outcome = await harness.auth.claim(typed, 'Owner', 'Firefox');
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.adoptedLocalWorkspace).toBe(true);
    expect(outcome.signIn.user).toMatchObject({
      displayName: 'Owner',
      role: 'admin',
      workspaceId: LOCAL_WORKSPACE_ID,
    });
    expect(
      (await harness.servicesForWorkspace(outcome.signIn.user.workspaceId).listDecks()).map((d) => d.id),
    ).toEqual([tracked.deckId]);
    expect((await harness.auth.listSessions(outcome.signIn.user))[0]?.createdVia).toBe('claim');

    // The code is gone, and the installation cannot be claimed again.
    expect(harness.repos.settings.get(SETUP_CODE_SETTING)).toBeNull();
    expect(await harness.auth.isClaimable()).toBe(false);
    expect(await harness.auth.claimStatus()).toEqual({ claimable: false });
    expect(await harness.auth.setupCode()).toBeNull();
    expect(await harness.auth.claim(code, 'Intruder', null)).toMatchObject({ ok: false, reason: 'claimed' });
    expect(JSON.stringify(harness.logger.entries.filter((entry) => entry.level !== 'warn'))).not.toContain(
      code,
    );
  });

  it('gives the first admin of a fresh installation a workspace of their own', async () => {
    const harness = createServiceHarness();
    // Every database has an empty `local` workspace; there is no history to adopt.
    expect(harness.repos.workspaces.getById(LOCAL_WORKSPACE_ID)).not.toBeNull();
    const code = defined(await harness.auth.setupCode());

    const outcome = await harness.auth.claim(code, 'Owner', null);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.adoptedLocalWorkspace).toBe(false);
    expect(outcome.signIn.user.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);
    expect(harness.repos.users.getByWorkspaceId(LOCAL_WORKSPACE_ID)).toBeNull();
  });

  it('is impossible once any user exists, even with the right code', async () => {
    const harness = createServiceHarness();
    await harness.auth.claimStatus();
    const code = defined(await harness.auth.setupCode());
    await signUp(harness.auth, 'Invited first');
    expect(await harness.auth.claim(code, 'Late', null)).toMatchObject({ ok: false, reason: 'claimed' });
  });

  describe('across processes', () => {
    let dir: string | undefined;
    const open: Db[] = [];

    afterEach(() => {
      for (const db of open.splice(0)) db.$client.close();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it('lets exactly one of two processes claim, although both saw it claimable', async () => {
      dir = mkdtempSync(join(tmpdir(), 'git-moxfield-claim-'));
      const { config } = createServiceHarness();
      const start = () => {
        const db = openDatabase(join(dir ?? '', 'app.db'));
        open.push(db);
        return createAuthService({ db, config, logger: recordingLogger() });
      };
      const first = start();
      const second = start();
      // Both processes see an unclaimed installation and the same code.
      expect(await first.claimStatus()).toEqual({ claimable: true });
      expect(await second.claimStatus()).toEqual({ claimable: true });
      const code = defined(await first.setupCode());
      expect(await second.setupCode()).toBe(code);

      const outcomes = await Promise.all([
        first.claim(code, 'First', null),
        second.claim(code, 'Second', null),
      ]);
      expect(outcomes.map((outcome) => (outcome.ok ? 'ok' : outcome.reason)).sort()).toEqual([
        'claimed',
        'ok',
      ]);
      expect((await first.listUsers(SYSTEM_ACTOR)).map((user) => user.role)).toEqual(['admin']);
    });
  });
});
