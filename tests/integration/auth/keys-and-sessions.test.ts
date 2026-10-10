/**
 * Bookmarklet keys and sessions (ADR 0006): keys are shown once inside the bookmarklets
 * and stored hashed; running a bookmarklet signs the browser in without duplicating an
 * existing session; sessions slide, end, and end with a revoked key or a disabled user.
 */
import { describe, expect, it } from 'vitest';

import { HANDOFF_LIFETIME_MS, SESSION_LIFETIME_MS } from '@/server/auth/service';
import { hashToken } from '@/server/auth/tokens';
import type { SessionUser } from '@/server/auth/types';
import { countRows } from '@tests/support/db';
import { expectServiceError, keyOfBookmarklet, signUp, tokenOfPath } from '@tests/support/auth';
import { createServiceHarness, defined, trackDeck, type ServiceHarness } from '@tests/support/services';
import { openShared, shareLinksOf, tokenOfShareUrl } from '@tests/support/sharing';

const APP_URL = 'https://decks.example.com';
const DAY_S = 86_400;

async function withKey(harness: ServiceHarness, name = 'Mikko') {
  const signIn = await signUp(harness.auth, name);
  const created = await harness.auth.createBookmarkletKey(signIn.user, 'Laptop Chrome', APP_URL);
  return { signIn, created, key: keyOfBookmarklet(created.bookmarklets.popup) };
}

function allRowsText(harness: ServiceHarness): string {
  const tables = ['users', 'credentials', 'sessions', 'login_links', 'invites', 'app_settings'];
  return JSON.stringify(tables.map((table) => harness.db.$client.prepare(`SELECT * FROM "${table}"`).all()));
}

describe('bookmarklet keys', () => {
  it('embeds a new key in both bookmarklets and stores only its hash', async () => {
    const harness = createServiceHarness();
    const { signIn, created, key } = await withKey(harness);

    expect(created.key).toEqual({
      id: created.key.id,
      label: 'Laptop Chrome',
      createdAt: harness.clock.iso(),
      lastUsedAt: null,
      madeFrom: null,
      derived: [],
      shareLinkCount: 0,
      derivedShareLinkCount: 0,
    });
    expect(keyOfBookmarklet(created.bookmarklets.sameTab)).toBe(key);
    expect(decodeURIComponent(created.bookmarklets.popup)).toContain(`"app":"${APP_URL}"`);
    expect(harness.db.$client.prepare('SELECT secret_hash AS hash FROM credentials').all()).toEqual([
      { hash: hashToken(key) },
    ]);
    expect(allRowsText(harness)).not.toContain(key);
    expect(JSON.stringify(harness.logger.entries)).not.toContain(key);
    expect(await harness.auth.listKeys(signIn.user)).toEqual([created.key]);
  });

  it('validates the label and the app URL before storing anything', async () => {
    const harness = createServiceHarness();
    const { user } = await signUp(harness.auth, 'Mikko');
    await expectServiceError(harness.auth.createBookmarkletKey(user, '   ', APP_URL), 'invalid-input');
    await expect(harness.auth.createBookmarkletKey(user, 'Phone', 'localhost:3000')).rejects.toThrow(
      TypeError,
    );
    expect(countRows(harness.db, 'credentials')).toBe(0);
  });

  it('signs a browser in, recording the key’s use', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, created, key } = await withKey(harness);
    harness.clock.advance(60);

    const signIn = defined(await harness.auth.signInWithKey(key, 'Safari on iPhone'));
    expect(signIn.user).toEqual({ ...owner.user, sessionId: signIn.session.id });
    expect(signIn.session.token).toMatch(/^gms_[A-Za-z0-9_-]{43}$/);
    expect(signIn.session.expiresAt).toBe(
      new Date(harness.clock.epochMs() + SESSION_LIFETIME_MS).toISOString(),
    );
    expect((await harness.auth.resolveSession(signIn.session.token))?.id).toBe(owner.user.id);
    expect(await harness.auth.listKeys(owner.user)).toEqual([
      { ...created.key, lastUsedAt: harness.clock.iso() },
    ]);
    const [session] = (await harness.auth.listSessions(signIn.user)).filter((entry) => entry.current);
    expect(session).toMatchObject({ createdVia: 'bookmarklet', userAgent: 'Safari on iPhone' });
    expect(JSON.stringify(harness.logger.entries)).not.toContain(signIn.session.token);
  });

  it('keeps the browser’s session of the same user instead of starting another', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, key } = await withKey(harness);
    const sessions = countRows(harness.db, 'sessions');

    const again = defined(
      await harness.auth.signInWithKey(key, 'Firefox', { currentSessionToken: owner.session.token }),
    );
    expect(again.session.token).toBe(owner.session.token);
    expect(again.session.id).toBe(owner.session.id);
    expect(countRows(harness.db, 'sessions')).toBe(sessions);

    // Another user's session is not reused: the key's owner gets a session of their own.
    const other = await signUp(harness.auth, 'Anna');
    const switched = defined(
      await harness.auth.signInWithKey(key, 'Firefox', { currentSessionToken: other.session.token }),
    );
    expect(switched.user.id).toBe(owner.user.id);
    expect(switched.session.token).not.toBe(other.session.token);
  });

  it.each([
    ['malformed', () => 'gmk_short'],
    ['well-formed but unknown', () => `gmk_${'Q'.repeat(43)}`],
    ['another kind of token', () => `gms_${'Q'.repeat(43)}`],
    ['not a string', () => 42],
  ])('refuses a %s key', async (_case, key) => {
    const harness = createServiceHarness();
    await withKey(harness);
    expect(await harness.auth.signInWithKey(key(), 'Firefox')).toBeNull();
    expect(await harness.auth.startKeyHandoff(key(), 'Firefox')).toBeNull();
  });

  it('stops signing in with a revoked key, and ends the sessions it started except the current one', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, created, key } = await withKey(harness);
    const viaKey1 = defined(await harness.auth.signInWithKey(key, 'Phone'));
    const viaKey2 = defined(await harness.auth.signInWithKey(key, 'Tablet'));
    const other = await signUp(harness.auth, 'Anna');

    // Only the owner can revoke it.
    expect(await harness.auth.revokeKey(other.user, created.key.id)).toBe(false);
    expect(await harness.auth.revokeKey(viaKey2.user, created.key.id)).toBe(true);
    expect(await harness.auth.revokeKey(viaKey2.user, created.key.id)).toBe(false);

    expect(await harness.auth.signInWithKey(key, 'Phone')).toBeNull();
    expect(await harness.auth.resolveSession(viaKey1.session.token)).toBeNull();
    // The session that asked survives, and so do sessions the key did not start.
    expect(await harness.auth.resolveSession(viaKey2.session.token)).not.toBeNull();
    expect(await harness.auth.resolveSession(owner.session.token)).not.toBeNull();
    expect(await harness.auth.listKeys(owner.user)).toEqual([]);
  });

  it('refuses the keys of a disabled user', async () => {
    const harness = createServiceHarness();
    const { signIn, key } = await withKey(harness);
    harness.repos.users.setDisabled(signIn.user.id, true);
    expect(await harness.auth.signInWithKey(key, 'Firefox')).toBeNull();
  });
});

describe('sessions', () => {
  it('renew their expiry at most once a day and record the user’s activity at most hourly', async () => {
    const harness = createServiceHarness();
    const { session, user } = await signUp(harness.auth, 'Mikko');
    const initialExpiry = session.expiresAt;
    const userSeen = () => harness.repos.users.getById(user.id)?.lastSeenAt;
    const current = async () =>
      defined(
        (await harness.auth.listSessions({ ...user, sessionId: session.id })).find((entry) => entry.current),
      );

    await harness.auth.resolveSession(session.token);
    const firstSeen = userSeen();
    expect(firstSeen).toBe(harness.clock.iso());

    harness.clock.advance(30 * 60);
    await harness.auth.resolveSession(session.token);
    expect(userSeen()).toBe(firstSeen);
    expect((await current()).expiresAt).toBe(initialExpiry);

    harness.clock.advance(31 * 60);
    await harness.auth.resolveSession(session.token);
    expect(userSeen()).toBe(harness.clock.iso());
    expect((await current()).expiresAt).toBe(initialExpiry);

    harness.clock.advance(DAY_S);
    await harness.auth.resolveSession(session.token);
    const renewed = await current();
    expect(renewed.expiresAt).toBe(new Date(harness.clock.epochMs() + SESSION_LIFETIME_MS).toISOString());
    expect(renewed.lastSeenAt).toBe(harness.clock.iso());
  });

  it('expire after 400 days without use', async () => {
    const harness = createServiceHarness();
    const { session } = await signUp(harness.auth, 'Mikko');
    harness.clock.advance(399 * DAY_S);
    expect(await harness.auth.resolveSession(session.token)).not.toBeNull();
    harness.clock.advance(399 * DAY_S);
    expect(await harness.auth.resolveSession(session.token)).not.toBeNull();
    harness.clock.advance(400 * DAY_S + 1);
    expect(await harness.auth.resolveSession(session.token)).toBeNull();
  });

  it.each([null, undefined, '', 'gms_short', `gmk_${'A'.repeat(43)}`, `gms_${'A'.repeat(43)}`])(
    'resolve no user for %j',
    async (token) => {
      const harness = createServiceHarness();
      await signUp(harness.auth, 'Mikko');
      expect(await harness.auth.resolveSession(token)).toBeNull();
    },
  );

  it('end one at a time, all at once, and only the user’s own', async () => {
    const harness = createServiceHarness();
    const laptop = await signUp(harness.auth, 'Mikko');
    const created = await harness.auth.createBookmarkletKey(laptop.user, 'Phone', APP_URL);
    const key = keyOfBookmarklet(created.bookmarklets.popup);
    const phone = defined(await harness.auth.signInWithKey(key, 'Phone'));
    const tablet = defined(await harness.auth.signInWithKey(key, 'Tablet'));
    const anna = await signUp(harness.auth, 'Anna');

    const listed = await harness.auth.listSessions(phone.user);
    expect(listed.map((entry) => [entry.id, entry.current]).sort()).toEqual(
      [
        [laptop.session.id, false],
        [phone.session.id, true],
        [tablet.session.id, false],
      ].sort(),
    );

    expect(await harness.auth.revokeSession(anna.user, tablet.session.id)).toBe(false);
    expect(await harness.auth.revokeSession(phone.user, tablet.session.id)).toBe(true);
    expect(await harness.auth.resolveSession(tablet.session.token)).toBeNull();

    await harness.auth.endSession(phone.session.token);
    expect(await harness.auth.resolveSession(phone.session.token)).toBeNull();

    expect(await harness.auth.endAllSessions(laptop.user)).toBe(1);
    expect(await harness.auth.resolveSession(laptop.session.token)).toBeNull();
    expect(await harness.auth.resolveSession(anna.session.token)).not.toBeNull();
  });
});

describe('signing out other devices and everywhere', () => {
  it('withdraws unused device links, which would sign another device in after it', async () => {
    const harness = createServiceHarness();
    const laptop = await signUp(harness.auth, 'Mikko');
    const beforeAll = tokenOfPath((await harness.auth.createDeviceLink(laptop.user)).path);
    expect(await harness.auth.endAllSessions(laptop.user)).toBe(1);
    harness.clock.advance(60);
    expect(await harness.auth.getLoginLink(beforeAll)).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(beforeAll, 'Phone')).toBeNull();
  });

  it('signs out every other device and withdraws device links, keeping the asking one', async () => {
    const harness = createServiceHarness();
    const laptop = await signUp(harness.auth, 'Mikko');
    const phoneLink = tokenOfPath((await harness.auth.createDeviceLink(laptop.user)).path);
    const phone = defined(await harness.auth.consumeLoginLink(phoneLink, 'Phone'));
    const pending = tokenOfPath((await harness.auth.createDeviceLink(phone.user)).path);
    const anna = await signUp(harness.auth, 'Anna');

    expect(await harness.auth.endOtherSessions(laptop.user)).toBe(1);
    expect(await harness.auth.resolveSession(laptop.session.token)).not.toBeNull();
    expect(await harness.auth.resolveSession(phone.session.token)).toBeNull();
    expect(await harness.auth.getLoginLink(pending)).toEqual({ status: 'revoked' });
    expect(await harness.auth.resolveSession(anna.session.token)).not.toBeNull();
  });
});

describe('same-tab hand-off', () => {
  it('is no session: its token signs nobody in, and an ordinary session token is no hand-off', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, key } = await withKey(harness);
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari on iPhone'));
    expect(started.user.id).toBe(owner.user.id);
    expect(started.handoff.expiresAt).toBe(
      new Date(harness.clock.epochMs() + HANDOFF_LIFETIME_MS).toISOString(),
    );
    expect(await harness.auth.resolveSession(started.handoff.token)).toBeNull();
    expect((await harness.auth.listSessions(owner.user)).map((entry) => entry.id)).toEqual([
      owner.session.id,
    ]);
    // A planted session token (cookie tossing) cannot pose as a hand-off.
    expect(await harness.auth.completeHandoff(owner.session.token, null)).toBeNull();
    expect(await harness.auth.confirmHandoff(owner.session.token, null)).toBeNull();
    expect(JSON.stringify(harness.logger.entries)).not.toContain(started.handoff.token);
  });

  it('asks a signed-out browser first, and signs it in only when confirmed', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, created, key } = await withKey(harness);
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari on iPhone'));

    harness.clock.advance(1);
    const outcome = defined(await harness.auth.completeHandoff(started.handoff.token, null));
    expect(outcome).toEqual({
      kind: 'confirm',
      confirmation: {
        displayName: 'Mikko',
        keyLabel: 'Laptop Chrome',
        keyCreatedAt: created.key.createdAt,
        replaces: null,
        expiresAt: started.handoff.expiresAt,
      },
    });
    expect(await harness.auth.describeHandoff(started.handoff.token, null)).toEqual(
      outcome.kind === 'confirm' ? outcome.confirmation : null,
    );
    // Asking changed nothing.
    expect(await harness.auth.resolveSession(started.handoff.token)).toBeNull();

    const signIn = defined(await harness.auth.confirmHandoff(started.handoff.token, null));
    expect(signIn.user).toEqual({ ...owner.user, sessionId: started.handoff.id });
    expect(signIn.session).toEqual({
      id: started.handoff.id,
      token: started.handoff.token,
      expiresAt: new Date(harness.clock.epochMs() + SESSION_LIFETIME_MS).toISOString(),
    });
    harness.clock.advance(HANDOFF_LIFETIME_MS / 1000 + 60);
    expect((await harness.auth.resolveSession(signIn.session.token))?.id).toBe(owner.user.id);
    const current = (await harness.auth.listSessions(signIn.user)).find((entry) => entry.current);
    expect(current).toMatchObject({ createdVia: 'bookmarklet', userAgent: 'Safari on iPhone' });

    // Used up: neither the hand-off nor its confirmation works twice.
    expect(await harness.auth.completeHandoff(started.handoff.token, signIn.session.token)).toBeNull();
    expect(await harness.auth.confirmHandoff(started.handoff.token, null)).toBeNull();
  });

  it('keeps the browser’s session of the same user without asking, and ends the hand-off', async () => {
    const harness = createServiceHarness();
    const { signIn: current, key } = await withKey(harness);
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari'));

    const outcome = defined(await harness.auth.completeHandoff(started.handoff.token, current.session.token));
    if (outcome.kind !== 'kept') throw new Error(`Expected kept, got ${outcome.kind}`);
    expect(outcome.signIn.session.token).toBe(current.session.token);
    expect(outcome.signIn.user.id).toBe(current.user.id);
    expect(await harness.auth.confirmHandoff(started.handoff.token, null)).toBeNull();
    expect((await harness.auth.listSessions(outcome.signIn.user)).map((entry) => entry.id)).toEqual([
      current.session.id,
    ]);
  });

  it('never touches the session of another user the browser holds: it asks, naming both accounts', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, key } = await withKey(harness);
    const anna = await signUp(harness.auth, 'Anna');
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari'));

    const outcome = defined(await harness.auth.completeHandoff(started.handoff.token, anna.session.token));
    expect(outcome).toMatchObject({
      kind: 'confirm',
      confirmation: { displayName: 'Mikko', keyLabel: 'Laptop Chrome', replaces: { displayName: 'Anna' } },
    });
    expect((await harness.auth.resolveSession(anna.session.token))?.id).toBe(anna.user.id);
    expect(await harness.auth.resolveSession(started.handoff.token)).toBeNull();

    // Confirmed on the app's own page: the hand-off becomes the browser's session. Ending
    // Anna's session is the caller's job (it replaces her cookie); the service leaves it.
    const signIn = defined(await harness.auth.confirmHandoff(started.handoff.token, anna.session.token));
    expect(signIn.user.id).toBe(owner.user.id);
    expect(signIn.session.token).toBe(started.handoff.token);
    expect((await harness.auth.resolveSession(anna.session.token))?.id).toBe(anna.user.id);
  });

  it('confirming keeps the browser’s session when it is the key owner’s by then', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, key } = await withKey(harness);
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari'));
    const signIn = defined(await harness.auth.confirmHandoff(started.handoff.token, owner.session.token));
    expect(signIn.session.token).toBe(owner.session.token);
    expect(await harness.auth.confirmHandoff(started.handoff.token, null)).toBeNull();
  });

  it('can be cancelled, signing nobody in and leaving the browser’s session alone', async () => {
    const harness = createServiceHarness();
    const { key } = await withKey(harness);
    const anna = await signUp(harness.auth, 'Anna');
    const started = defined(await harness.auth.startKeyHandoff(key, 'Safari'));

    await harness.auth.cancelHandoff(started.handoff.token);
    expect(await harness.auth.completeHandoff(started.handoff.token, anna.session.token)).toBeNull();
    expect(await harness.auth.confirmHandoff(started.handoff.token, null)).toBeNull();
    expect(await harness.auth.resolveSession(anna.session.token)).not.toBeNull();
    // Cancelling never ends an ordinary session, whatever token it is given.
    await harness.auth.cancelHandoff(anna.session.token);
    await harness.auth.cancelHandoff('nonsense');
    expect(await harness.auth.resolveSession(anna.session.token)).not.toBeNull();
  });

  it('expires when it is not completed in time, and dies with its key', async () => {
    const harness = createServiceHarness();
    const { signIn: owner, created, key } = await withKey(harness);
    const expiring = defined(await harness.auth.startKeyHandoff(key, 'Safari'));
    const revokedKey = defined(await harness.auth.startKeyHandoff(key, 'Safari'));

    harness.clock.advance(HANDOFF_LIFETIME_MS / 1000);
    expect(await harness.auth.completeHandoff(expiring.handoff.token, null)).toBeNull();
    expect(await harness.auth.describeHandoff(expiring.handoff.token, null)).toBeNull();
    expect(await harness.auth.confirmHandoff(expiring.handoff.token, null)).toBeNull();
    expect(await harness.auth.completeHandoff('gms_bogus', null)).toBeNull();
    expect(await harness.auth.completeHandoff(undefined, null)).toBeNull();

    harness.clock.advance(-HANDOFF_LIFETIME_MS / 1000);
    await harness.auth.revokeKey(owner.user, created.key.id);
    expect(await harness.auth.completeHandoff(revokedKey.handoff.token, null)).toBeNull();
    expect(await harness.auth.confirmHandoff(revokedKey.handoff.token, null)).toBeNull();
  });
});

describe('what a key signed in, and what was made there', () => {
  /** Mikko's laptop key, stolen: the thief signs a browser in with it and digs in. */
  async function stolenKeyScenario(harness: ServiceHarness) {
    const { signIn: owner, created, key } = await withKey(harness);
    const thief = defined(await harness.auth.signInWithKey(key, 'Thief browser'));
    const phoneLink = tokenOfPath((await harness.auth.createDeviceLink(thief.user)).path);
    const thiefPhone = defined(await harness.auth.consumeLoginLink(phoneLink, 'Thief phone'));
    const pendingLink = tokenOfPath((await harness.auth.createDeviceLink(thiefPhone.user)).path);
    const minted = await harness.auth.createBookmarkletKey(thiefPhone.user, 'Innocent label', APP_URL);
    return {
      owner,
      stolen: created.key,
      thief,
      thiefPhone,
      pendingLink,
      minted,
      mintedKey: keyOfBookmarklet(minted.bookmarklets.popup),
    };
  }

  it('lists a key’s lineage: what it was made with, and what was made through it', async () => {
    const harness = createServiceHarness();
    const { owner, stolen, minted } = await stolenKeyScenario(harness);
    const own = await harness.auth.createBookmarkletKey(owner.user, 'Desktop', APP_URL);

    const keys = await harness.auth.listKeys(owner.user);
    expect(
      keys.map((key) => [key.label, key.madeFrom?.label ?? null, key.derived.map((d) => d.label)]),
    ).toEqual([
      ['Desktop', null, []],
      ['Innocent label', 'Laptop Chrome', []],
      ['Laptop Chrome', null, ['Innocent label']],
    ]);
    expect(own.key.madeFrom).toBeNull();
    expect(minted.key.madeFrom).toEqual({ id: stolen.id, label: 'Laptop Chrome' });
  });

  it('revoking a stolen key ends the sessions it signed in, also through device links, and their links', async () => {
    const harness = createServiceHarness();
    const { owner, stolen, thief, thiefPhone, pendingLink, mintedKey } = await stolenKeyScenario(harness);

    expect(await harness.auth.revokeKey(owner.user, stolen.id)).toBe(true);
    expect(await harness.auth.resolveSession(thief.session.token)).toBeNull();
    expect(await harness.auth.resolveSession(thiefPhone.session.token)).toBeNull();
    expect(await harness.auth.getLoginLink(pendingLink)).toEqual({ status: 'revoked' });
    expect(await harness.auth.consumeLoginLink(pendingLink, 'Thief laptop')).toBeNull();
    expect(await harness.auth.resolveSession(owner.session.token)).not.toBeNull();
    // Not cascaded without asking: a key made in such a browser may be the owner's own replacement.
    expect(await harness.auth.signInWithKey(mintedKey, 'Thief again')).not.toBeNull();
    const [remaining] = await harness.auth.listKeys(owner.user);
    expect(remaining).toMatchObject({ label: 'Innocent label', madeFrom: { label: 'Laptop Chrome' } });
  });

  it('revokes the keys made through it too when asked, and the sessions those signed in', async () => {
    const harness = createServiceHarness();
    const { owner, stolen, mintedKey } = await stolenKeyScenario(harness);
    const viaMinted = defined(await harness.auth.signInWithKey(mintedKey, 'Thief tablet'));
    // A key made through the minted one: revoked transitively.
    const grandchild = keyOfBookmarklet(
      (await harness.auth.createBookmarkletKey(viaMinted.user, 'Second hop', APP_URL)).bookmarklets.popup,
    );

    expect(await harness.auth.revokeKey(owner.user, stolen.id, { includeDerived: true })).toBe(true);
    expect(await harness.auth.signInWithKey(mintedKey, 'Thief again')).toBeNull();
    expect(await harness.auth.signInWithKey(grandchild, 'Thief again')).toBeNull();
    expect(await harness.auth.resolveSession(viaMinted.session.token)).toBeNull();
    expect(await harness.auth.listKeys(owner.user)).toEqual([]);
    expect(await harness.auth.resolveSession(owner.session.token)).not.toBeNull();
  });

  it('keeps the revoking session, even when it descends from the key', async () => {
    const harness = createServiceHarness();
    const { stolen, thief, thiefPhone } = await stolenKeyScenario(harness);
    expect(await harness.auth.revokeKey(thiefPhone.user, stolen.id)).toBe(true);
    expect(await harness.auth.resolveSession(thiefPhone.session.token)).not.toBeNull();
    expect(await harness.auth.resolveSession(thief.session.token)).toBeNull();
  });

  describe('share links made in those browsers', () => {
    /** The stolen-key scenario, with a deck to share and links made in every browser involved. */
    async function withShareLinks(harness: ServiceHarness) {
      const scenario = await stolenKeyScenario(harness);
      const services = harness.servicesForWorkspace(scenario.owner.user.workspaceId);
      const deckId = await trackDeck({ ...harness, services });
      const viaMinted = defined(await harness.auth.signInWithKey(scenario.mintedKey, 'Thief tablet'));
      const share = async (user: SessionUser, label: string) =>
        tokenOfShareUrl(
          (await shareLinksOf(harness, user).createShareLink(deckId, { label, includeNotes: true }, APP_URL))
            .url,
        );
      return {
        ...scenario,
        deckId,
        links: {
          own: await share(scenario.owner.user, 'Own'),
          thief: await share(scenario.thief.user, 'Thief'),
          thiefPhone: await share(scenario.thiefPhone.user, 'Thief phone'),
          viaMinted: await share(viaMinted.user, 'Via minted'),
        },
      };
    }

    async function working(harness: ServiceHarness, token: string): Promise<boolean> {
      return (await openShared(harness, token)) !== null;
    }

    it('are counted on the key their browser descends from, and on the key it was made through', async () => {
      const harness = createServiceHarness();
      const { owner } = await withShareLinks(harness);
      const keys = await harness.auth.listKeys(owner.user);
      expect(keys.map((key) => [key.label, key.shareLinkCount, key.derivedShareLinkCount])).toEqual([
        ['Innocent label', 1, 0],
        // The thief's browser and the phone signed in with its device link.
        ['Laptop Chrome', 2, 1],
      ]);
    });

    it('keep working when the key is revoked without them: they may be the owner’s own', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, links } = await withShareLinks(harness);
      expect(await harness.auth.revokeKey(owner.user, stolen.id)).toBe(true);
      for (const token of Object.values(links)) expect(await working(harness, token)).toBe(true);
    });

    it('are revoked with the key when asked, and with the keys made through it too', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, links } = await withShareLinks(harness);
      expect(await harness.auth.revokeKey(owner.user, stolen.id, { includeShareLinks: true })).toBe(true);
      expect(await working(harness, links.thief)).toBe(false);
      expect(await working(harness, links.thiefPhone)).toBe(false);
      expect(await working(harness, links.viaMinted)).toBe(true);
      expect(await working(harness, links.own)).toBe(true);
    });

    it('reach the keys made through it when both options are chosen', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, links } = await withShareLinks(harness);
      expect(
        await harness.auth.revokeKey(owner.user, stolen.id, {
          includeDerived: true,
          includeShareLinks: true,
        }),
      ).toBe(true);
      expect(await working(harness, links.thief)).toBe(false);
      expect(await working(harness, links.thiefPhone)).toBe(false);
      expect(await working(harness, links.viaMinted)).toBe(false);
      expect(await working(harness, links.own)).toBe(true);
      expect(JSON.stringify(harness.logger.entries)).not.toContain(links.thief);
    });

    it('are not touched when the key cannot be revoked (another user’s or already revoked)', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, links } = await withShareLinks(harness);
      const stranger = await signUp(harness.auth, 'Stranger');
      expect(await harness.auth.revokeKey(stranger.user, stolen.id, { includeShareLinks: true })).toBe(false);
      expect(await working(harness, links.thief)).toBe(true);
      expect(await harness.auth.revokeKey(owner.user, stolen.id)).toBe(true);
      // `revokeKey` revokes keys; a revoked key's links are revoked with `revokeKeyShareLinks`.
      expect(await harness.auth.revokeKey(owner.user, stolen.id, { includeShareLinks: true })).toBe(false);
      expect(await working(harness, links.thief)).toBe(true);
    });

    it('stay listed, and revocable, after the key was revoked without them', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, minted, links } = await withShareLinks(harness);
      expect(await harness.auth.listRevokedKeyShareLinks(owner.user)).toEqual([]);
      harness.clock.advance(60);
      expect(await harness.auth.revokeKey(owner.user, stolen.id, { includeDerived: true })).toBe(true);
      const revokedAt = harness.clock.iso();
      expect(await harness.auth.listKeys(owner.user)).toEqual([]);
      // Each key with the links made in the browsers it signed in itself.
      expect(await harness.auth.listRevokedKeyShareLinks(owner.user)).toEqual([
        { id: minted.key.id, label: 'Innocent label', revokedAt, shareLinkCount: 1 },
        { id: stolen.id, label: 'Laptop Chrome', revokedAt, shareLinkCount: 2 },
      ]);

      const stranger = await signUp(harness.auth, 'Stranger');
      expect(await harness.auth.revokeKeyShareLinks(stranger.user, stolen.id)).toBe(0);
      expect(await harness.auth.revokeKeyShareLinks(owner.user, 'no-such-key')).toBe(0);
      expect(await working(harness, links.thief)).toBe(true);

      expect(await harness.auth.revokeKeyShareLinks(owner.user, stolen.id)).toBe(2);
      expect(await working(harness, links.thief)).toBe(false);
      expect(await working(harness, links.thiefPhone)).toBe(false);
      expect(await working(harness, links.viaMinted)).toBe(true);
      expect(await working(harness, links.own)).toBe(true);
      expect(await harness.auth.revokeKeyShareLinks(owner.user, stolen.id)).toBe(0);
      expect((await harness.auth.listRevokedKeyShareLinks(owner.user)).map((key) => key.label)).toEqual([
        'Innocent label',
      ]);
      expect(harness.logger.entries).toContainEqual(
        expect.objectContaining({
          message: 'Share links of a bookmarklet key revoked',
          context: { userId: owner.user.id, keyId: stolen.id, shareLinks: 2 },
        }),
      );
      expect(JSON.stringify(harness.logger.entries)).not.toContain(links.thief);
    });

    it('of an active key are revoked the same way, leaving the key working', async () => {
      const harness = createServiceHarness();
      const { owner, stolen, thief, links } = await withShareLinks(harness);
      expect(await harness.auth.revokeKeyShareLinks(owner.user, stolen.id)).toBe(2);
      expect(await working(harness, links.thief)).toBe(false);
      expect(await harness.auth.resolveSession(thief.session.token)).not.toBeNull();
      expect((await harness.auth.listKeys(owner.user)).find((key) => key.id === stolen.id)).toMatchObject({
        shareLinkCount: 0,
      });
    });
  });

  it('makes nothing for a session that has ended meanwhile', async () => {
    const harness = createServiceHarness();
    const { signIn } = await withKey(harness);
    await harness.auth.endAllSessions(signIn.user);
    await expectServiceError(harness.auth.createDeviceLink(signIn.user), 'forbidden');
    await expectServiceError(harness.auth.createBookmarkletKey(signIn.user, 'Late', APP_URL), 'forbidden');
    expect(countRows(harness.db, 'login_links')).toBe(0);
    expect(countRows(harness.db, 'credentials')).toBe(1);
  });
});
