/**
 * The auth service: identity and credentials (ADR 0006). Users, bookmarklet keys,
 * sessions, device and recovery links, invites and the first-run claim.
 *
 * Secrets: every token is generated here (`./tokens`) and only its SHA-256 hash is
 * stored. Plaintext leaves this service in exactly four places: the session token of a
 * {@link SignIn} (for the cookie), the token of a started bookmarklet hand-off (for the
 * hand-off cookie), the path of a new link (shown once to its creator) and the
 * bookmarklets of a new key (shown once to its owner). Nothing secret is logged, except
 * the setup code of an unclaimed installation, which is printed to the server log by
 * design so that only someone with access to the server can claim it.
 *
 * Authorization: methods that act for a user take the {@link SessionUser} resolved from
 * the request and only touch that user's own keys, sessions and links. Admin methods take
 * an {@link Actor}: a signed-in admin (re-checked against the database on every call) or
 * {@link SYSTEM_ACTOR}, the command line. Admins manage accounts, not decks: no admin
 * method reaches anyone's decks. The one way an admin can act as someone else is a
 * recovery link, which signs in as that person; consuming one signs every other device
 * of theirs out and revokes their bookmarklets and share links, and the person sees on
 * their account page whose link it was, so it cannot be used quietly.
 *
 * Revocation reaches everything derived: a session made through a device link descends
 * from the bookmarklet key of the session that made the link, so revoking a key ends
 * those sessions and unused links too (and, when the owner asks, the share links made
 * in them, also later on for a key revoked before); signing out everywhere, being
 * disabled or recovered withdraws unused links; being recovered revokes every share
 * link to the person's decks; disabling an admin withdraws the invites and links they
 * made (and links made by an admin who is no longer an active admin never work).
 *
 * Every multi-step change (accepting an invite, consuming a link, claiming, revoking)
 * runs in one `IMMEDIATE` transaction, so one-time things stay one-time across
 * concurrent requests and processes. Transaction callbacks may run more than once (see
 * `runInTransaction`), so they only read and write through the transaction; what happened
 * is logged after the commit.
 */
import 'server-only';

import { groupInto } from '@/core/collections';
import { absoluteAppUrl } from '@/core/http-url';
import { USER_ROLES } from '@/core/roles';
import { buildBookmarklet } from '@/integrations/moxfield/capture';
import type { AppConfig } from '@/server/config';
import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import {
  createRepositories,
  isActiveAdminRecord,
  type CredentialRecord,
  type InviteRecord,
  type LibsqlExecutor,
  type LoginLinkPurpose,
  type PendingHandoff,
  type Repositories,
  type SessionOrigin,
  type SessionRecord,
  type UserListItem,
  type UserRecord,
} from '@/server/repositories';
import { ServiceError } from '@/server/services/errors';

import { SESSION_MAX_AGE_S } from './cookie-spec';
import { oneTimeLinkState } from './link-status';
import { CLAIM_PATH, invitePath, loginLinkPath } from './paths';
import { requireActiveSession } from './require-session';
import { generateSetupCode, normalizeSetupCode, SETUP_CODE_PATTERN, setupCodesEqual } from './setup-code';
import { generateToken, hashToken, parseToken } from './tokens';
import type {
  AcceptInviteOutcome,
  BookmarkletKeyDTO,
  BookmarkletsDTO,
  ClaimOutcome,
  ClaimStatusDTO,
  CreatedBookmarkletKey,
  HandoffConfirmationDTO,
  HandoffOutcome,
  InviteDTO,
  InviteLinkStatusDTO,
  InviteStatus,
  InviteInput,
  IssuedInvite,
  IssuedLink,
  KeyRefDTO,
  LoginLinkStatusDTO,
  OneTimeLinkProblem,
  RecoveryLinkDTO,
  RecoveryUseDTO,
  RevokedKeyShareLinksDTO,
  RevokeKeyOptions,
  SessionDTO,
  SessionUser,
  SignIn,
  StartedHandoff,
  UserDTO,
  UserOutcome,
} from './types';
import { cleanUserAgent, validateDisplayName, validateInviteNote, validateKeyLabel } from './validation';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Session lifetime after the last activity: 400 days, the longest cookie lifetime browsers allow. */
export const SESSION_LIFETIME_MS = SESSION_MAX_AGE_S * 1000;
/** A session's expiry is pushed forward at most this often (it is a database write). */
export const SESSION_RENEWAL_INTERVAL_MS = DAY_MS;
/** A user's `lastSeenAt` is recorded at most this often. */
export const USER_SEEN_INTERVAL_MS = HOUR_MS;
/** Lifetime of a pending hand-off until it is completed (see {@link AuthService.startKeyHandoff}). */
export const HANDOFF_LIFETIME_MS = 5 * MINUTE_MS;
export const DEVICE_LINK_LIFETIME_MS = 15 * MINUTE_MS;
export const RECOVERY_LINK_LIFETIME_MS = DAY_MS;
export const INVITE_LIFETIME_MS = 7 * DAY_MS;

const USER_NOT_FOUND = 'This user does not exist.';

/** Settings key of the setup code of an unclaimed installation. */
export const SETUP_CODE_SETTING = 'setup-code';

/**
 * The command line acting as an admin (`pnpm users …`). Only operator scripts may pass
 * it; request-handling code always passes the {@link SessionUser} of the request.
 */
export const SYSTEM_ACTOR: unique symbol = Symbol('git-moxfield command line');

/** Who performs an admin operation: a signed-in admin, or the command line. */
export type Actor = SessionUser | typeof SYSTEM_ACTOR;

export interface AuthService {
  // --- Sessions -------------------------------------------------------------------

  /**
   * Signs a browser in with a bookmarklet key (capture endpoints) and records the key's
   * use. When `currentSessionToken` (the browser's session cookie) already belongs to
   * the key's owner, that session is kept (and its expiry renewed) instead of starting
   * another one. `null` for a malformed, unknown or revoked key, or a disabled user.
   */
  signInWithKey(
    key: unknown,
    userAgent: string | null,
    options?: { currentSessionToken?: string | null },
  ): Promise<SignIn | null>;
  /**
   * Starts a hand-off for the same-tab bookmarklet's cross-site form post, which cannot
   * see the browser's `SameSite=Lax` session cookie: a pending hand-off for the key's
   * owner that expires after {@link HANDOFF_LIFETIME_MS} and signs nobody in by itself.
   * The browser carries it (hand-off cookie) to {@link completeHandoff}, where its own
   * session cookie is visible again. `null` for an invalid key, as {@link signInWithKey}.
   *
   * Any member can make such a post with their own key from any site, so the key proves
   * whose workspace receives the capture, never that the browser's user ran it: the
   * hand-off must not change who the browser is without a same-origin confirmation.
   */
  startKeyHandoff(key: unknown, userAgent: string | null): Promise<StartedHandoff | null>;
  /**
   * Finishes a hand-off as far as it can without asking: when the browser's current
   * session belongs to the key's owner, the hand-off ends and that session goes on
   * (`kept`, renewed). Otherwise (signed out, or another user's session) nothing changes
   * and the browser must confirm ({@link confirmHandoff}) on a page of this app
   * (`confirm`). `null` when the hand-off is unknown, expired or used up, or its key was
   * revoked since.
   */
  completeHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<HandoffOutcome | null>;
  /** What confirming the hand-off would do (for the page that asks), or `null` as {@link completeHandoff}. Changes nothing. */
  describeHandoff(
    handoffToken: unknown,
    currentSessionToken: string | null,
  ): Promise<HandoffConfirmationDTO | null>;
  /**
   * Confirms a hand-off: the hand-off becomes the browser's session (with the full
   * lifetime), or, when the browser is signed in as the key's owner already, that
   * session goes on and the hand-off ends. Call it only for a same-origin request the
   * user made on the confirmation page; the caller then ends the session the browser
   * held before, if it was another user's. `null` as {@link completeHandoff}.
   */
  confirmHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<SignIn | null>;
  /** Ends a pending hand-off without signing anyone in ("not me"). */
  cancelHandoff(handoffToken: unknown): Promise<void>;
  /**
   * The user of a session cookie, or `null` when it is malformed, unknown, revoked or
   * expired, or the user is disabled. Renews the expiry to {@link SESSION_LIFETIME_MS}
   * from now (at most daily) and records the user's activity (at most hourly).
   */
  resolveSession(token: string | null | undefined): Promise<SessionUser | null>;
  /** Ends the session of a session cookie (signing that browser out). */
  endSession(token: string | null | undefined): Promise<void>;
  /**
   * Ends every session of the user, the current one included ("sign out everywhere"), and
   * withdraws their unused device links. @returns the number of sessions ended.
   */
  endAllSessions(user: SessionUser): Promise<number>;
  /**
   * Ends every session of the user except the asking one ("sign out other devices"), and
   * withdraws their unused device links. @returns the number of sessions ended.
   */
  endOtherSessions(user: SessionUser): Promise<number>;
  /** The user's active sessions, most recently seen first; `current` marks the asking one. */
  listSessions(user: SessionUser): Promise<SessionDTO[]>;
  /** Ends one of the user's own sessions. Returns whether one was ended. */
  revokeSession(user: SessionUser, sessionId: string): Promise<boolean>;

  // --- Bookmarklet keys -----------------------------------------------------------

  /**
   * Creates a bookmarklet key and the two bookmarklets that carry it, for git-moxfield at
   * `appUrl` (its public base URL). The bookmarklets are the only copy of the key: show
   * them once, to the user, and never log them. The key records which key the asking
   * session descends from (see {@link BookmarkletKeyDTO.madeFrom}).
   * @throws {ServiceError} `invalid-input` for an invalid label; `forbidden` when the
   * asking session has ended meanwhile.
   * @throws {TypeError} when `appUrl` is not an absolute http(s) URL (nothing is stored).
   */
  createBookmarkletKey(user: SessionUser, label: string, appUrl: string): Promise<CreatedBookmarkletKey>;
  /** The user's keys that are not revoked, newest first, with what they were made from. */
  listKeys(user: SessionUser): Promise<BookmarkletKeyDTO[]>;
  /**
   * Revokes one of the user's own keys. Ends every session that descends from it (the
   * browsers it signed in, and those signed in with a device link made on one of them)
   * and withdraws the unused device links made there, except the session making the
   * request. With `includeDerived`, does the same for the keys made through it
   * ({@link BookmarkletKeyDTO.derived}); otherwise those keep working. With
   * `includeShareLinks`, also revokes the share links made in those browsers (of the key,
   * and of the keys made through it when `includeDerived` is set; see
   * {@link BookmarkletKeyDTO.shareLinkCount}); otherwise they keep working.
   * @returns whether an active key was revoked.
   */
  revokeKey(user: SessionUser, keyId: string, options?: RevokeKeyOptions): Promise<boolean>;
  /**
   * The user's revoked keys through which share links that still work were made (see
   * {@link BookmarkletKeyDTO.shareLinkCount}), most recently revoked first: read access
   * that outlived its key because the key was revoked without its share links (the
   * owner's choice, or a link made after the owner looked).
   */
  listRevokedKeyShareLinks(user: SessionUser): Promise<RevokedKeyShareLinksDTO[]>;
  /**
   * Revokes the share links made in browsers one of the user's own keys signed in
   * (directly, or through a device link made on one of them), whether or not the key is
   * revoked: what `revokeKey` with `includeShareLinks` revokes, also later on. The key
   * itself, and links made through keys made through it, are not touched.
   * @returns how many links were revoked (0 for another user's or an unknown key).
   */
  revokeKeyShareLinks(user: SessionUser, keyId: string): Promise<number>;

  // --- One-time sign-in links -----------------------------------------------------

  /**
   * A link that signs another device in as `user`, valid for {@link DEVICE_LINK_LIFETIME_MS}.
   * The session it starts descends from the same key as the asking session.
   * @throws {ServiceError} `forbidden` when the asking session has ended meanwhile.
   */
  createDeviceLink(user: SessionUser): Promise<IssuedLink>;
  /**
   * A link that signs the user in once, valid for {@link RECOVERY_LINK_LIFETIME_MS}: for a
   * user who lost every key and signed-in device. Admins only. Withdraws the user's
   * earlier unused recovery links: only the newest one works.
   * @throws {ServiceError} `forbidden` for non-admins; `not-found` for an unknown user;
   * `invalid-input` for a disabled user or for the acting admin themselves (who signs
   * in on another device with a device link instead).
   */
  createRecoveryLink(actor: Actor, userId: string): Promise<IssuedLink>;
  /** Recovery links that can still be used, newest first (never their tokens). @throws {ServiceError} `forbidden` for non-admins. */
  listRecoveryLinks(actor: Actor): Promise<RecoveryLinkDTO[]>;
  /**
   * Withdraws a recovery link that has not been used. @returns whether it was withdrawn.
   * @throws {ServiceError} `forbidden` for non-admins.
   */
  revokeRecoveryLink(actor: Actor, linkId: string): Promise<boolean>;
  /** The recovery links that signed in as the user, most recent first: shown to the user. */
  listRecoveryUses(user: SessionUser): Promise<RecoveryUseDTO[]>;
  /** What a link would do (for the page that asks before signing in). Changes nothing. */
  getLoginLink(token: unknown): Promise<LoginLinkStatusDTO>;
  /**
   * Uses up a device or recovery link and signs the browser in. `null` when the link is
   * malformed, unknown, used, withdrawn or expired, its user is disabled, the key it
   * descends from is revoked, or (recovery) its admin is no longer an active admin. Call
   * it from a POST only.
   *
   * A recovery link is for someone who lost every way in, and it signs in as them
   * whoever opens it: consuming one ends every other session of the user, revokes all of
   * their bookmarklet keys, withdraws their unused links and revokes every share link to
   * their decks (ADR 0007), so a lost or stolen device is cut off, read access handed out
   * from it ends too, and an admin's misuse cannot go unnoticed or outlast the person's
   * own recovery.
   */
  consumeLoginLink(token: unknown, userAgent: string | null): Promise<SignIn | null>;

  // --- Invites --------------------------------------------------------------------

  /**
   * An invite for a new user with `role`, valid for {@link INVITE_LIFETIME_MS}. Admins
   * (or the command line) only.
   * @throws {ServiceError} `forbidden` for non-admins; `invalid-input` for an invalid note or role.
   */
  createInvite(actor: Actor, input: InviteInput): Promise<IssuedInvite>;
  /** What an invite link would do (for the invite page). Changes nothing. */
  getInvite(token: unknown): Promise<InviteLinkStatusDTO>;
  /**
   * Uses up an invite: creates the user and signs the browser in. Call it from a POST
   * only. The user gets a workspace of their own, except an admin while the `local`
   * workspace holds a pre-account installation's history and has no owner: like the
   * claim, that admin adopts it (`pnpm users invite --admin` is the claim's command-line
   * alternative).
   */
  acceptInvite(token: unknown, displayName: string, userAgent: string | null): Promise<AcceptInviteOutcome>;
  /** Every invite, newest first. @throws {ServiceError} `forbidden` for non-admins. */
  listInvites(actor: Actor): Promise<InviteDTO[]>;
  /**
   * Withdraws an invite that has not been used. @returns whether it was revoked.
   * @throws {ServiceError} `forbidden` for non-admins.
   */
  revokeInvite(actor: Actor, inviteId: string): Promise<boolean>;

  // --- Users ----------------------------------------------------------------------

  /** Every user, oldest first. @throws {ServiceError} `forbidden` for non-admins. */
  listUsers(actor: Actor): Promise<UserDTO[]>;
  /**
   * Disables a user: they cannot sign in, and their sessions end; keys and data are
   * kept. Everything one-time that involves them is withdrawn for good: unused links
   * that sign them in, and the invites and links they made (an admin's recovery links
   * and invites). Admins cannot disable themselves or the last active admin.
   * @throws {ServiceError} `forbidden` for non-admins.
   */
  disableUser(actor: Actor, userId: string): Promise<UserOutcome>;
  /**
   * Enables a disabled user again: their bookmarklet keys work again. Sessions, links and
   * invites withdrawn by disabling stay withdrawn. @throws {ServiceError} `forbidden`.
   */
  enableUser(actor: Actor, userId: string): Promise<UserOutcome>;
  /** @throws {ServiceError} `forbidden` for non-admins. */
  renameUser(actor: Actor, userId: string, displayName: string): Promise<UserOutcome>;
  /** Changes the user's own display name. */
  renameSelf(user: SessionUser, displayName: string): Promise<UserOutcome>;

  // --- First run ------------------------------------------------------------------

  /** Whether the installation has no users yet. Changes nothing. */
  isClaimable(): Promise<boolean>;
  /**
   * Whether the installation can be claimed. While it can, makes sure a setup code exists
   * and prints it to the server log (with the `/claim` path). Call it where the code is
   * needed: on process start and on the `/claim` page.
   */
  claimStatus(): Promise<ClaimStatusDTO>;
  /** The setup code while the installation is unclaimed (created if needed), else `null`. For the command line. */
  setupCode(): Promise<string | null>;
  /**
   * Creates the first admin with the setup code and signs the browser in. On a
   * single-user installation from before accounts, the admin adopts its `local`
   * workspace, so its history is kept; on a fresh installation the admin gets a workspace
   * of their own. Impossible once any user exists, also under concurrency.
   */
  claim(code: string, displayName: string, userAgent: string | null): Promise<ClaimOutcome>;
}

export interface AuthServiceDependencies {
  /** The database (or, in tests, any executor opened by `createLibsqlDatabase`). */
  db: LibsqlExecutor;
  config: AppConfig;
  /** Clock for every timestamp and expiry. Default: system time. */
  now?: () => Date;
  /** Default: `createLogger('auth')`. */
  logger?: Logger;
  /** Id generator for new rows. Default: `crypto.randomUUID`. */
  newId?: () => string;
}

export function createAuthService(deps: AuthServiceDependencies): AuthService {
  return new DefaultAuthService(deps);
}

interface ActiveSession {
  session: SessionRecord;
  user: UserRecord;
}

const INVITE_PROBLEMS: Record<OneTimeLinkProblem, string> = {
  invalid: 'This invite link is not valid. Check that you copied all of it.',
  expired: 'This invite has expired. Ask for a new one.',
  used: 'This invite has already been used.',
  revoked: 'This invite was withdrawn. Ask for a new one.',
};

class DefaultAuthService implements AuthService {
  private readonly repos: Repositories;
  private readonly config: AppConfig;
  private readonly now: () => Date;
  private readonly logger: Logger;

  constructor(deps: AuthServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.repos = createRepositories(deps.db, { now: this.now, newId: deps.newId });
    this.config = deps.config;
    this.logger = deps.logger ?? createLogger('auth');
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  async signInWithKey(
    key: unknown,
    userAgent: string | null,
    options: { currentSessionToken?: string | null } = {},
  ): Promise<SignIn | null> {
    const holder = await this.keyHolder(key);
    if (!holder) return null;
    const now = this.now();
    const currentToken = options.currentSessionToken ?? null;
    const current = await this.findSession(this.repos, currentToken, now);
    const kept = await this.keepSessionOf(this.repos, holder.user.id, current, currentToken, now);
    if (kept !== null) return kept;
    const signIn = await this.issueSession(this.repos, holder.user, {
      createdVia: 'bookmarklet',
      credentialId: holder.credential.id,
      userAgent,
    });
    this.logger.info('Signed in with a bookmarklet key', {
      userId: holder.user.id,
      keyId: holder.credential.id,
      sessionId: signIn.session.id,
    });
    return signIn;
  }

  async startKeyHandoff(key: unknown, userAgent: string | null): Promise<StartedHandoff | null> {
    const holder = await this.keyHolder(key);
    if (!holder) return null;
    const started = await this.issueSession(
      this.repos,
      holder.user,
      { createdVia: 'bookmarklet', credentialId: holder.credential.id, userAgent, pendingHandoff: true },
      HANDOFF_LIFETIME_MS,
    );
    return { user: started.user, handoff: started.session };
  }

  completeHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<HandoffOutcome | null> {
    return this.repos.transaction(async (tx): Promise<HandoffOutcome | null> => {
      const now = this.now();
      const handoff = await this.findHandoff(tx, handoffToken, now);
      if (handoff === null) return null;
      const current = await this.findSession(tx, currentSessionToken, now);
      // Already signed in as the key's owner: nothing to ask.
      const kept = await this.keepSessionOf(tx, handoff.user.id, current, currentSessionToken, now, handoff);
      if (kept !== null) return { kind: 'kept', signIn: kept };
      return { kind: 'confirm', confirmation: toHandoffConfirmation(handoff, current) };
    });
  }

  async describeHandoff(
    handoffToken: unknown,
    currentSessionToken: string | null,
  ): Promise<HandoffConfirmationDTO | null> {
    const now = this.now();
    const [handoff, current] = await Promise.all([
      this.findHandoff(this.repos, handoffToken, now),
      this.findSession(this.repos, currentSessionToken, now),
    ]);
    if (handoff === null) return null;
    return toHandoffConfirmation(handoff, current);
  }

  async confirmHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<SignIn | null> {
    const confirmed = await this.repos.transaction(
      async (tx): Promise<{ signIn: SignIn; promoted?: Record<string, unknown> } | null> => {
        const now = this.now();
        const at = now.toISOString();
        const handoff = await this.findHandoff(tx, handoffToken, now);
        if (handoff === null || typeof handoffToken !== 'string') return null;
        const current = await this.findSession(tx, currentSessionToken, now);
        const kept = await this.keepSessionOf(
          tx,
          handoff.user.id,
          current,
          currentSessionToken,
          now,
          handoff,
        );
        if (kept !== null) return { signIn: kept };
        const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
        if (!(await tx.sessions.promoteHandoff(handoff.session.id, at, expiresAt))) return null;
        return {
          signIn: {
            user: toSessionUser(handoff.user, handoff.session.id),
            session: { id: handoff.session.id, token: handoffToken, expiresAt },
          },
          promoted: {
            userId: handoff.user.id,
            keyId: handoff.credential.id,
            sessionId: handoff.session.id,
            replacedSessionOfAnotherUser: current !== null,
          },
        };
      },
    );
    if (confirmed?.promoted !== undefined)
      this.logger.info('Signed in with a bookmarklet key', confirmed.promoted);
    return confirmed?.signIn ?? null;
  }

  async cancelHandoff(handoffToken: unknown): Promise<void> {
    const parsed = parseToken('session', handoffToken);
    if (parsed === null) return;
    if (await this.repos.sessions.revokePendingHandoff(hashToken(parsed), this.now().toISOString())) {
      this.logger.info('A bookmarklet sign-in was declined');
    }
  }

  async resolveSession(token: string | null | undefined): Promise<SessionUser | null> {
    const now = this.now();
    const found = await this.findSession(this.repos, token, now);
    if (!found) return null;
    await this.recordActivity(this.repos, found, now);
    return toSessionUser(found.user, found.session.id);
  }

  async endSession(token: string | null | undefined): Promise<void> {
    const parsed = parseToken('session', token);
    if (parsed === null) return;
    await this.repos.sessions.revokeByTokenHash(hashToken(parsed), this.now().toISOString());
  }

  endAllSessions(user: SessionUser): Promise<number> {
    return this.endSessions(user, 'Signed out everywhere');
  }

  endOtherSessions(user: SessionUser): Promise<number> {
    return this.endSessions(user, 'Signed out other devices', { exceptSessionId: user.sessionId });
  }

  async listSessions(user: SessionUser): Promise<SessionDTO[]> {
    const sessions = await this.repos.sessions.listActiveForUser(user.id, this.now().toISOString());
    return sessions.map((session) => ({
      id: session.id,
      createdVia: session.createdVia,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      current: session.id === user.sessionId,
    }));
  }

  revokeSession(user: SessionUser, sessionId: string): Promise<boolean> {
    return this.repos.sessions.revoke(user.id, sessionId, this.now().toISOString());
  }

  // -------------------------------------------------------------------------
  // Bookmarklet keys
  // -------------------------------------------------------------------------

  async createBookmarkletKey(
    user: SessionUser,
    label: string,
    appUrl: string,
  ): Promise<CreatedBookmarkletKey> {
    const validation = validateKeyLabel(label);
    if (!validation.ok) throw new ServiceError('invalid-input', validation.message);
    const key = generateToken('key');
    // Built before anything is stored: an unusable app URL must not leave a key behind.
    const bookmarklets = this.bookmarklets(key, appUrl);
    const { record, dto } = await this.repos.transaction(async (tx) => {
      const session = await requireActiveSession(tx, user, this.now().toISOString());
      const created = await tx.credentials.createKey({
        userId: user.id,
        label: validation.value,
        secretHash: hashToken(key),
        createdByCredentialId: session.credentialId,
      });
      const all = await tx.credentials.listForUser(user.id, { includeRevoked: true });
      return { record: created, dto: toKeyDTO(created, all, await shareLinkCounts(tx, user.id, all)) };
    });
    this.logger.info('Bookmarklet key created', {
      userId: user.id,
      keyId: record.id,
      madeFromKeyId: record.createdByCredentialId,
    });
    return { key: dto, bookmarklets };
  }

  async listKeys(user: SessionUser): Promise<BookmarkletKeyDTO[]> {
    const all = await this.repos.credentials.listForUser(user.id, { includeRevoked: true });
    const links = await shareLinkCounts(this.repos, user.id, all);
    return all.filter((key) => key.revokedAt === null).map((key) => toKeyDTO(key, all, links));
  }

  async revokeKey(user: SessionUser, keyId: string, options: RevokeKeyOptions = {}): Promise<boolean> {
    const revoked = await this.repos.transaction(async (tx) => {
      const at = this.now().toISOString();
      const derived =
        options.includeDerived === true
          ? descendantKeyIds(await tx.credentials.listForUser(user.id, { includeRevoked: true }), keyId)
          : [];
      if (!(await tx.credentials.revoke(user.id, keyId, at))) return null;
      const keys = [keyId, ...derived];
      let derivedKeys = 0;
      let endedSessions = 0;
      let deviceLinks = 0;
      for (const id of keys) {
        if (id !== keyId && (await tx.credentials.revoke(user.id, id, at))) derivedKeys += 1;
        endedSessions += await tx.sessions.revokeAllForUser(user.id, at, {
          credentialId: id,
          exceptSessionId: user.sessionId,
        });
        deviceLinks += await tx.loginLinks.revokeUnused({ userId: user.id, credentialId: id }, at);
      }
      const shareLinks =
        options.includeShareLinks === true ? await tx.shareLinks.revokeByCredential(user.id, keys, at) : 0;
      return { derivedKeys, endedSessions, deviceLinks, shareLinks };
    });
    if (revoked === null) return false;
    this.logger.info('Bookmarklet key revoked', { userId: user.id, keyId, ...revoked });
    return true;
  }

  async listRevokedKeyShareLinks(user: SessionUser): Promise<RevokedKeyShareLinksDTO[]> {
    const revoked = (await this.repos.credentials.listForUser(user.id, { includeRevoked: true })).filter(
      (key): key is CredentialRecord & { revokedAt: string } => key.revokedAt !== null,
    );
    const links = await shareLinkCounts(this.repos, user.id, revoked);
    return revoked
      .flatMap((key) => {
        const shareLinkCount = links.get(key.id) ?? 0;
        return shareLinkCount === 0
          ? []
          : [{ id: key.id, label: key.label, revokedAt: key.revokedAt, shareLinkCount }];
      })
      .sort((a, b) => b.revokedAt.localeCompare(a.revokedAt));
  }

  async revokeKeyShareLinks(user: SessionUser, keyId: string): Promise<number> {
    const shareLinks = await this.repos.transaction(async (tx) => {
      const own = (await tx.credentials.listForUser(user.id, { includeRevoked: true })).some(
        (key) => key.id === keyId,
      );
      if (!own) return 0;
      return tx.shareLinks.revokeByCredential(user.id, [keyId], this.now().toISOString());
    });
    if (shareLinks > 0) {
      this.logger.info('Share links of a bookmarklet key revoked', { userId: user.id, keyId, shareLinks });
    }
    return shareLinks;
  }

  // -------------------------------------------------------------------------
  // One-time sign-in links
  // -------------------------------------------------------------------------

  async createDeviceLink(user: SessionUser): Promise<IssuedLink> {
    const link = await this.repos.transaction(async (tx) => {
      const session = await requireActiveSession(tx, user, this.now().toISOString());
      return this.issueLoginLink(tx, {
        userId: user.id,
        purpose: 'device',
        createdByUserId: user.id,
        credentialId: session.credentialId,
        lifetimeMs: DEVICE_LINK_LIFETIME_MS,
      });
    });
    this.logger.info('Device link created', { userId: user.id });
    return link;
  }

  async createRecoveryLink(actor: Actor, userId: string): Promise<IssuedLink> {
    const { link, actorId, replaced } = await this.adminTransaction(actor, async (tx, admin) => {
      if (admin === userId) {
        throw new ServiceError(
          'invalid-input',
          'You can’t make a recovery link for yourself. On a device where you’re signed in, use “Sign in on another device” in Account instead.',
        );
      }
      const target = await tx.users.getById(userId);
      if (!target) throw new ServiceError('not-found', USER_NOT_FOUND);
      if (target.disabledAt !== null) {
        throw new ServiceError(
          'invalid-input',
          `${target.displayName} is disabled. Enable the account before creating a recovery link.`,
        );
      }
      // Only the newest recovery link of a user works.
      const withdrawn = await tx.loginLinks.revokeUnused(
        { userId, purpose: 'recovery' },
        this.now().toISOString(),
      );
      const issued = await this.issueLoginLink(tx, {
        userId,
        purpose: 'recovery',
        createdByUserId: admin,
        credentialId: null,
        lifetimeMs: RECOVERY_LINK_LIFETIME_MS,
      });
      return { link: issued, actorId: admin, replaced: withdrawn };
    });
    this.logger.info('Recovery link created', {
      userId,
      createdBy: actorLabel(actorId),
      replacedLinks: replaced,
    });
    return link;
  }

  async listRecoveryLinks(actor: Actor): Promise<RecoveryLinkDTO[]> {
    await this.requireAdmin(this.repos, actor);
    const [names, pending] = await Promise.all([
      userNames(this.repos),
      this.repos.loginLinks.listPending('recovery', this.now().toISOString()),
    ]);
    const active = await Promise.all(pending.map((link) => this.repos.loginLinks.hasActiveCreator(link)));
    return pending
      .filter((_, index) => active[index] === true)
      .map((link) => ({
        id: link.id,
        user: { id: link.userId, displayName: names.get(link.userId) ?? '' },
        createdBy: nameOf(names, link.createdByUserId),
        createdAt: link.createdAt,
        expiresAt: link.expiresAt,
      }));
  }

  async revokeRecoveryLink(actor: Actor, linkId: string): Promise<boolean> {
    const { revoked, actorId } = await this.adminTransaction(actor, async (tx, admin) => ({
      actorId: admin,
      revoked: await tx.loginLinks.revoke(linkId, this.now().toISOString(), { purpose: 'recovery' }),
    }));
    if (revoked) this.logger.info('Recovery link withdrawn', { linkId, revokedBy: actorLabel(actorId) });
    return revoked;
  }

  async listRecoveryUses(user: SessionUser): Promise<RecoveryUseDTO[]> {
    const [names, used] = await Promise.all([
      userNames(this.repos),
      this.repos.loginLinks.listUsedForUser(user.id, 'recovery'),
    ]);
    return used.flatMap((link) =>
      link.usedAt === null
        ? []
        : [
            {
              createdBy: nameOf(names, link.createdByUserId),
              createdAt: link.createdAt,
              usedAt: link.usedAt,
            },
          ],
    );
  }

  async getLoginLink(token: unknown): Promise<LoginLinkStatusDTO> {
    const parsed = parseToken('login', token);
    const link = parsed === null ? null : await this.repos.loginLinks.getByTokenHash(hashToken(parsed));
    if (!link) return { status: 'invalid' };
    if (link.usedAt !== null) return { status: 'used' };
    const [creatorActive, user] = await Promise.all([
      this.repos.loginLinks.hasActiveCreator(link),
      this.repos.users.getById(link.userId),
    ]);
    const state = oneTimeLinkState(link, creatorActive, this.now().toISOString());
    if (state !== 'pending') return { status: state };
    if (user?.disabledAt !== null) return { status: 'invalid' };
    return {
      status: 'valid',
      purpose: link.purpose,
      displayName: user.displayName,
      expiresAt: link.expiresAt,
    };
  }

  async consumeLoginLink(token: unknown, userAgent: string | null): Promise<SignIn | null> {
    const parsed = parseToken('login', token);
    if (parsed === null) return null;
    const consumed = await this.repos.transaction(async (tx) => {
      const at = this.now().toISOString();
      const found = await tx.loginLinks.consume(hashToken(parsed), at);
      if (!found) return null;
      const { link, user } = found;
      let recovery: Record<string, unknown> | null = null;
      if (link.purpose === 'recovery') {
        // Recovery is for someone who lost every way in: whatever else still signs in as
        // them (a lost or stolen device, an old bookmarklet) stops working now, and so
        // does every share link to their decks (ADR 0007). Whoever held a lost device,
        // or an earlier recovery link, could have made those, and nothing tells them
        // apart from the person's own: the read access they grant would outlive the
        // recovery, unnoticed.
        recovery = {
          userId: user.id,
          createdBy: actorLabel(link.createdByUserId),
          endedSessions: await tx.sessions.revokeAllForUser(user.id, at),
          revokedKeys: await tx.credentials.revokeAllForUser(user.id, at),
          revokedLinks: await tx.loginLinks.revokeUnused({ userId: user.id }, at),
          revokedShareLinks: await tx.shareLinks.revokeAllForWorkspace(user.workspaceId, at),
        };
      }
      const signIn = await this.issueSession(tx, user, {
        createdVia: link.purpose === 'device' ? 'device-link' : 'recovery-link',
        // A device link's session descends from the key its creating session descends from.
        credentialId: link.purpose === 'device' ? link.credentialId : null,
        userAgent,
      });
      return { signIn, purpose: link.purpose, recovery };
    });
    if (consumed === null) return null;
    const { signIn, purpose, recovery } = consumed;
    if (recovery !== null) {
      this.logger.info('Recovery link used: other sessions ended, keys and share links revoked', recovery);
    }
    this.logger.info('Signed in with a one-time link', {
      userId: signIn.user.id,
      purpose,
      sessionId: signIn.session.id,
    });
    return signIn;
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  async createInvite(actor: Actor, input: InviteInput): Promise<IssuedInvite> {
    // Checked at runtime too: callers may pass a role straight from a form.
    if (!(USER_ROLES as readonly string[]).includes(input.role)) {
      throw new ServiceError('invalid-input', 'An invite is for a member or an admin.');
    }
    const note = validateInviteNote(input.note ?? '');
    if (!note.ok) throw new ServiceError('invalid-input', note.message);
    const { issued, actorId } = await this.adminTransaction(actor, async (tx, admin) => {
      const token = generateToken('invite');
      const expiresAt = this.expiry(INVITE_LIFETIME_MS);
      const record = await tx.invites.create({
        tokenHash: hashToken(token),
        role: input.role,
        note: note.value,
        createdByUserId: admin,
        expiresAt,
      });
      const invite = this.toInviteDTO(record, await userNames(tx), true);
      return { issued: { invite, path: invitePath(token), expiresAt }, actorId: admin };
    });
    this.logger.info('Invite created', {
      inviteId: issued.invite.id,
      role: issued.invite.role,
      createdBy: actorLabel(actorId),
    });
    return issued;
  }

  async getInvite(token: unknown): Promise<InviteLinkStatusDTO> {
    const parsed = parseToken('invite', token);
    const invite = parsed === null ? null : await this.repos.invites.getByTokenHash(hashToken(parsed));
    if (!invite) return { status: 'invalid' };
    const status = this.inviteStatus(invite, await this.repos.invites.hasActiveCreator(invite));
    return status === 'pending'
      ? { status: 'valid', role: invite.role, expiresAt: invite.expiresAt }
      : { status };
  }

  async acceptInvite(
    token: unknown,
    displayName: string,
    userAgent: string | null,
  ): Promise<AcceptInviteOutcome> {
    const name = validateDisplayName(displayName);
    if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
    const parsed = parseToken('invite', token);
    if (parsed === null) return { ok: false, reason: 'invalid', message: INVITE_PROBLEMS.invalid };
    const tokenHash = hashToken(parsed);
    const result = await this.repos.transaction(async (tx) => {
      const adopt =
        (await tx.invites.getByTokenHash(tokenHash))?.role === 'admin' && (await hasUnownedLocalHistory(tx));
      const accepted = await tx.invites.accept(tokenHash, this.now().toISOString(), {
        displayName: name.value,
        ...(adopt ? { adoptWorkspaceId: LOCAL_WORKSPACE_ID } : {}),
      });
      if (!accepted) {
        const invite = await tx.invites.getByTokenHash(tokenHash);
        const status = invite
          ? this.inviteStatus(invite, await tx.invites.hasActiveCreator(invite))
          : 'invalid';
        const reason = status === 'pending' ? 'invalid' : status;
        return {
          outcome: { ok: false, reason, message: INVITE_PROBLEMS[reason] } satisfies AcceptInviteOutcome,
        };
      }
      const signIn = await this.issueSession(tx, accepted.user, { createdVia: 'invite', userAgent });
      return { outcome: { ok: true, signIn } satisfies AcceptInviteOutcome, accepted, adopt };
    });
    if (result.accepted !== undefined) {
      this.logger.info('Invite accepted', {
        inviteId: result.accepted.invite.id,
        userId: result.accepted.user.id,
        role: result.accepted.user.role,
        adoptedLocalWorkspace: result.adopt,
      });
    }
    return result.outcome;
  }

  async listInvites(actor: Actor): Promise<InviteDTO[]> {
    await this.requireAdmin(this.repos, actor);
    const [people, invites] = await Promise.all([this.repos.users.list(), this.repos.invites.list()]);
    const names = namesById(people);
    const activeAdmins = new Set(people.filter(isActiveAdminRecord).map((person) => person.id));
    return invites.map((invite) =>
      this.toInviteDTO(
        invite,
        names,
        invite.createdByUserId === null || activeAdmins.has(invite.createdByUserId),
      ),
    );
  }

  async revokeInvite(actor: Actor, inviteId: string): Promise<boolean> {
    const { revoked, actorId } = await this.adminTransaction(actor, async (tx, admin) => ({
      actorId: admin,
      revoked: await tx.invites.revoke(inviteId, this.now().toISOString()),
    }));
    if (revoked) this.logger.info('Invite revoked', { inviteId, revokedBy: actorLabel(actorId) });
    return revoked;
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async listUsers(actor: Actor): Promise<UserDTO[]> {
    await this.requireAdmin(this.repos, actor);
    return (await this.repos.users.list()).map(toUserDTO);
  }

  async disableUser(actor: Actor, userId: string): Promise<UserOutcome> {
    const result = await this.adminTransaction(
      actor,
      async (tx, actorId): Promise<{ outcome: UserOutcome; log?: Record<string, unknown> }> => {
        if (actorId === userId) {
          return { outcome: { ok: false, reason: 'self', message: 'You cannot disable your own account.' } };
        }
        const target = await tx.users.getById(userId);
        if (!target) return { outcome: userNotFound() };
        if (isActiveAdminRecord(target) && (await tx.users.countActiveAdmins()) <= 1) {
          return {
            outcome: { ok: false, reason: 'last-admin', message: 'The last admin cannot be disabled.' },
          };
        }
        const at = this.now().toISOString();
        await tx.users.setDisabled(userId, true);
        const ended = await tx.sessions.revokeAllForUser(userId, at);
        // Withdrawn for good, so enabling the user again revives none of it: links that
        // sign them in, and what they made as an admin (invites, recovery links).
        const linksForThem = await tx.loginLinks.revokeUnused({ userId }, at);
        const linksByThem = await tx.loginLinks.revokeUnused({ createdByUserId: userId }, at);
        const invites = await tx.invites.revokePendingCreatedBy(userId, at);
        return {
          outcome: { ok: true, user: await this.userDTO(tx, userId) },
          log: {
            userId,
            disabledBy: actorLabel(actorId),
            endedSessions: ended,
            revokedLinks: linksForThem + linksByThem,
            revokedInvites: invites,
          },
        };
      },
    );
    if (result.log !== undefined) this.logger.info('User disabled', result.log);
    return result.outcome;
  }

  async enableUser(actor: Actor, userId: string): Promise<UserOutcome> {
    const result = await this.adminTransaction(
      actor,
      async (tx, actorId): Promise<{ outcome: UserOutcome; actorId?: string | null }> => {
        if (!(await tx.users.getById(userId))) return { outcome: userNotFound() };
        await tx.users.setDisabled(userId, false);
        return { outcome: { ok: true, user: await this.userDTO(tx, userId) }, actorId };
      },
    );
    if (result.actorId !== undefined) {
      this.logger.info('User enabled', { userId, enabledBy: actorLabel(result.actorId) });
    }
    return result.outcome;
  }

  renameUser(actor: Actor, userId: string, displayName: string): Promise<UserOutcome> {
    return this.adminTransaction(actor, (tx) => this.rename(tx, userId, displayName));
  }

  renameSelf(user: SessionUser, displayName: string): Promise<UserOutcome> {
    return this.repos.transaction((tx) => this.rename(tx, user.id, displayName));
  }

  // -------------------------------------------------------------------------
  // First run
  // -------------------------------------------------------------------------

  async isClaimable(): Promise<boolean> {
    return (await this.repos.users.count()) === 0;
  }

  async claimStatus(): Promise<ClaimStatusDTO> {
    if ((await this.repos.users.count()) > 0) return { claimable: false };
    const code = await this.ensureSetupCode();
    const where =
      this.config.PUBLIC_APP_URL === undefined
        ? CLAIM_PATH
        : absoluteAppUrl(CLAIM_PATH, this.config.PUBLIC_APP_URL);
    this.logger.warn(
      `git-moxfield has no admin yet. To claim it, open ${where} and enter the setup code ${code}`,
      { path: CLAIM_PATH },
    );
    return { claimable: true };
  }

  async setupCode(): Promise<string | null> {
    return (await this.repos.users.count()) > 0 ? null : this.ensureSetupCode();
  }

  async claim(code: string, displayName: string, userAgent: string | null): Promise<ClaimOutcome> {
    const name = validateDisplayName(displayName);
    if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
    const typed = normalizeSetupCode(code);
    const outcome = await this.repos.transaction(async (tx): Promise<ClaimOutcome> => {
      // Inside one IMMEDIATE transaction: a concurrent claim either committed before
      // (and this one sees its user) or waits until this one has committed.
      if ((await tx.users.count()) > 0) {
        return {
          ok: false,
          reason: 'claimed',
          message: 'git-moxfield already has an admin. Ask them for an invite.',
        };
      }
      const stored = await tx.settings.get(SETUP_CODE_SETTING);
      if (stored === null || typed === null || !setupCodesEqual(typed, stored)) {
        return {
          ok: false,
          reason: 'invalid-code',
          message: 'That is not the setup code. Copy it from the server log and try again.',
        };
      }
      const adopt = await hasUnownedLocalHistory(tx);
      const user = adopt
        ? await tx.users.createForWorkspace({
            displayName: name.value,
            role: 'admin',
            workspaceId: LOCAL_WORKSPACE_ID,
          })
        : await tx.users.create({ displayName: name.value, role: 'admin' });
      await tx.settings.delete(SETUP_CODE_SETTING);
      const signIn = await this.issueSession(tx, user, { createdVia: 'claim', userAgent });
      return { ok: true, signIn, adoptedLocalWorkspace: adopt };
    });
    if (outcome.ok) {
      this.logger.info('git-moxfield claimed', {
        userId: outcome.signIn.user.id,
        adoptedLocalWorkspace: outcome.adoptedLocalWorkspace,
      });
    } else if (outcome.reason === 'invalid-code') {
      this.logger.warn('Rejected a claim with a wrong setup code');
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The active key `key` and its (enabled) owner, recording the key's use; `null` otherwise. */
  private async keyHolder(key: unknown): Promise<{ credential: CredentialRecord; user: UserRecord } | null> {
    const parsed = parseToken('key', key);
    if (parsed === null) return null;
    const found = await this.repos.credentials.findActiveBySecretHash(hashToken(parsed));
    if (found?.credential.kind !== 'bookmarklet-key') return null;
    await this.repos.credentials.touchLastUsed(found.credential.id, this.now().toISOString());
    return found;
  }

  /** The active session of a session token (format checked before any lookup). */
  private async findSession(repos: Repositories, token: unknown, now: Date): Promise<ActiveSession | null> {
    const parsed = parseToken('session', token);
    if (parsed === null) return null;
    return repos.sessions.findActiveByTokenHash(hashToken(parsed), now.toISOString());
  }

  /** The pending hand-off of a hand-off token (format checked before any lookup). */
  private async findHandoff(repos: Repositories, token: unknown, now: Date): Promise<PendingHandoff | null> {
    const parsed = parseToken('session', token);
    if (parsed === null) return null;
    return repos.sessions.findPendingHandoffByTokenHash(hashToken(parsed), now.toISOString());
  }

  /**
   * When the browser is signed in as `ownerId` already (`current`, found with
   * `currentToken`): keeps that session, ending `handoff` first if there is one, and
   * returns it. `null` when the browser is signed out or signed in as someone else.
   */
  /** Ends the user's sessions (all, or all but `except`) and their unused device links; logs `message`. */
  private async endSessions(
    user: SessionUser,
    message: string,
    options?: { exceptSessionId: string },
  ): Promise<number> {
    const { sessions, deviceLinks } = await this.repos.transaction(async (tx) => {
      const at = this.now().toISOString();
      return {
        sessions: await tx.sessions.revokeAllForUser(user.id, at, options),
        deviceLinks: await tx.loginLinks.revokeUnused({ userId: user.id, purpose: 'device' }, at),
      };
    });
    this.logger.info(message, { userId: user.id, sessions, deviceLinks });
    return sessions;
  }

  private async keepSessionOf(
    repos: Repositories,
    ownerId: string,
    current: ActiveSession | null,
    currentToken: string | null,
    now: Date,
    handoff?: PendingHandoff,
  ): Promise<SignIn | null> {
    if (current === null || currentToken === null || current.user.id !== ownerId) return null;
    if (handoff !== undefined) {
      await repos.sessions.revoke(handoff.user.id, handoff.session.id, now.toISOString());
    }
    return this.continueSession(repos, current, currentToken, now);
  }

  /** Keeps an existing session: records activity and returns it with its current expiry. */
  private async continueSession(
    repos: Repositories,
    found: ActiveSession,
    token: string,
    now: Date,
  ): Promise<SignIn> {
    const expiresAt = await this.recordActivity(repos, found, now);
    return {
      user: toSessionUser(found.user, found.session.id),
      session: { id: found.session.id, token, expiresAt },
    };
  }

  /**
   * Sliding expiry and activity: renews the session to {@link SESSION_LIFETIME_MS} from
   * now once its expiry is more than {@link SESSION_RENEWAL_INTERVAL_MS} older than that,
   * and records the user's activity at most every {@link USER_SEEN_INTERVAL_MS}. Most
   * requests write nothing.
   * @returns the session's expiry after the update.
   */
  private async recordActivity(
    repos: Repositories,
    { session, user }: ActiveSession,
    now: Date,
  ): Promise<string> {
    const renewed = now.getTime() + SESSION_LIFETIME_MS;
    let { expiresAt } = session;
    const writes: Promise<void>[] = [];
    if (Date.parse(expiresAt) <= renewed - SESSION_RENEWAL_INTERVAL_MS) {
      expiresAt = new Date(renewed).toISOString();
      writes.push(repos.sessions.touch(session.id, { lastSeenAt: now.toISOString(), expiresAt }));
    }
    if (user.lastSeenAt === null || now.getTime() - Date.parse(user.lastSeenAt) >= USER_SEEN_INTERVAL_MS) {
      writes.push(repos.users.touchLastSeen(user.id, now.toISOString()));
    }
    await Promise.all(writes);
    return expiresAt;
  }

  private async issueSession(
    repos: Repositories,
    user: UserRecord,
    origin: {
      createdVia: SessionOrigin;
      credentialId?: string | null;
      userAgent: string | null;
      pendingHandoff?: boolean;
    },
    lifetimeMs = SESSION_LIFETIME_MS,
  ): Promise<SignIn> {
    const token = generateToken('session');
    const expiresAt = this.expiry(lifetimeMs);
    const session = await repos.sessions.create({
      userId: user.id,
      tokenHash: hashToken(token),
      createdVia: origin.createdVia,
      credentialId: origin.credentialId ?? null,
      userAgent: cleanUserAgent(origin.userAgent),
      expiresAt,
      pendingHandoff: origin.pendingHandoff ?? false,
    });
    return { user: toSessionUser(user, session.id), session: { id: session.id, token, expiresAt } };
  }

  private async issueLoginLink(
    repos: Repositories,
    link: {
      userId: string;
      purpose: LoginLinkPurpose;
      createdByUserId: string | null;
      credentialId: string | null;
      lifetimeMs: number;
    },
  ): Promise<IssuedLink> {
    const token = generateToken('login');
    const expiresAt = this.expiry(link.lifetimeMs);
    await repos.loginLinks.create({
      userId: link.userId,
      tokenHash: hashToken(token),
      purpose: link.purpose,
      createdByUserId: link.createdByUserId,
      credentialId: link.credentialId,
      expiresAt,
    });
    return { path: loginLinkPath(token), expiresAt };
  }

  /**
   * Runs `fn` in a transaction that first checks that `actor` may administer users and
   * invites ({@link requireAdmin}); `adminId` is the admin's user id, `null` for the
   * command line. Log outside `fn`: a transaction may run again.
   */
  private adminTransaction<T>(
    actor: Actor,
    fn: (tx: Repositories, adminId: string | null) => Promise<T>,
  ): Promise<T> {
    return this.repos.transaction(async (tx) => fn(tx, await this.requireAdmin(tx, actor)));
  }

  /**
   * Checks that `actor` may administer users and invites, against the database (a
   * session's role may be stale). @returns the admin's user id, `null` for the command line.
   */
  private async requireAdmin(repos: Repositories, actor: Actor): Promise<string | null> {
    if (actor === SYSTEM_ACTOR) return null;
    const current = await repos.users.getById(actor.id);
    if (current === null || !isActiveAdminRecord(current)) {
      throw new ServiceError('forbidden', 'Only admins can manage users and invites.');
    }
    return current.id;
  }

  private async rename(repos: Repositories, userId: string, displayName: string): Promise<UserOutcome> {
    const name = validateDisplayName(displayName);
    if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
    if (!(await repos.users.getById(userId))) return userNotFound();
    await repos.users.rename(userId, name.value);
    return { ok: true, user: await this.userDTO(repos, userId) };
  }

  private async userDTO(repos: Repositories, userId: string): Promise<UserDTO> {
    const listed = (await repos.users.list()).find((user) => user.id === userId);
    if (!listed) throw new Error(`User ${userId} vanished while being updated`);
    return toUserDTO(listed);
  }

  private async ensureSetupCode(): Promise<string> {
    const code = await this.repos.settings.getOrCreate(SETUP_CODE_SETTING, generateSetupCode);
    if (!SETUP_CODE_PATTERN.test(code)) {
      throw new Error(
        `The stored setup code is malformed. Delete the "${SETUP_CODE_SETTING}" row of the app_settings table; a new code is created on the next start.`,
      );
    }
    return code;
  }

  /**
   * An invite's state. `creatorActive`: whether its creator is still an active admin (or
   * it came from the command line); an unused invite of anyone else counts as withdrawn.
   */
  private inviteStatus(invite: InviteRecord, creatorActive: boolean): InviteStatus {
    return oneTimeLinkState(invite, creatorActive, this.now().toISOString());
  }

  private toInviteDTO(
    invite: InviteRecord,
    names: ReadonlyMap<string, string>,
    creatorActive: boolean,
  ): InviteDTO {
    const usedByName = invite.usedByUserId === null ? undefined : names.get(invite.usedByUserId);
    return {
      id: invite.id,
      role: invite.role,
      note: invite.note,
      status: this.inviteStatus(invite, creatorActive),
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      createdBy: nameOf(names, invite.createdByUserId),
      usedAt: invite.usedAt,
      usedBy:
        invite.usedByUserId === null || usedByName === undefined
          ? null
          : { id: invite.usedByUserId, displayName: usedByName },
    };
  }

  private bookmarklets(key: string, appUrl: string): BookmarkletsDTO {
    const target = {
      appUrl,
      apiBaseUrl: this.config.MOXFIELD_API_BASE_URL,
      siteOrigin: this.config.moxfieldSiteOrigin,
      key,
    };
    return {
      popup: buildBookmarklet({ ...target, mode: 'popup' }),
      sameTab: buildBookmarklet({ ...target, mode: 'same-tab' }),
    };
  }

  private expiry(lifetimeMs: number): string {
    return new Date(this.now().getTime() + lifetimeMs).toISOString();
  }
}

function toSessionUser(user: UserRecord, sessionId: string): SessionUser {
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    workspaceId: user.workspaceId,
    sessionId,
  };
}

/**
 * A key as listed to its owner. `all`: every key of the owner, revoked ones included, to
 * name what the key was made from and what was made through it. `shareLinks`: the
 * owner's share links that are not revoked, counted by the key they descend from.
 */
function toKeyDTO(
  record: CredentialRecord,
  all: readonly CredentialRecord[],
  shareLinks: ReadonlyMap<string, number>,
): BookmarkletKeyDTO {
  const byId = new Map(all.map((key) => [key.id, key]));
  const parent = record.createdByCredentialId === null ? undefined : byId.get(record.createdByCredentialId);
  const descendants = descendantKeyIds(all, record.id);
  const derived = descendants
    .map((id) => byId.get(id))
    .filter((key): key is CredentialRecord => key?.revokedAt === null);
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    madeFrom: parent === undefined ? null : keyRef(parent),
    derived: derived.map(keyRef),
    shareLinkCount: shareLinks.get(record.id) ?? 0,
    // Every descendant, as `revokeKey` with `includeDerived` reaches revoked ones too.
    derivedShareLinkCount: descendants.reduce((sum, id) => sum + (shareLinks.get(id) ?? 0), 0),
  };
}

/** The user's share links that are not revoked, counted by the key their creating session descends from. */
async function shareLinkCounts(
  repos: Repositories,
  userId: string,
  keys: readonly CredentialRecord[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const links = await repos.shareLinks.listByCredential(
    userId,
    keys.map((key) => key.id),
  );
  for (const link of links) {
    if (link.credentialId !== null) counts.set(link.credentialId, (counts.get(link.credentialId) ?? 0) + 1);
  }
  return counts;
}

function keyRef(key: CredentialRecord): KeyRefDTO {
  return { id: key.id, label: key.label };
}

/**
 * The ids of the keys made, directly or in turn, through key `rootId` (following
 * `createdByCredentialId`), in any state, oldest first; never `rootId` itself.
 */
function descendantKeyIds(all: readonly CredentialRecord[], rootId: string): string[] {
  const children = new Map<string, CredentialRecord[]>();
  for (const key of all) {
    if (key.createdByCredentialId === null) continue;
    groupInto(children, key.createdByCredentialId, key);
  }
  const found: CredentialRecord[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      found.push(child);
      queue.push(child.id);
    }
  }
  return found.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((key) => key.id);
}

function toHandoffConfirmation(
  handoff: PendingHandoff,
  current: ActiveSession | null,
): HandoffConfirmationDTO {
  return {
    displayName: handoff.user.displayName,
    keyLabel: handoff.credential.label,
    keyCreatedAt: handoff.credential.createdAt,
    replaces:
      current === null || current.user.id === handoff.user.id
        ? null
        : { displayName: current.user.displayName },
    expiresAt: handoff.session.expiresAt,
  };
}

function toUserDTO(user: UserListItem): UserDTO {
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastSeenAt: user.lastSeenAt,
    disabledAt: user.disabledAt,
    deckCount: user.deckCount,
    activeKeyCount: user.activeKeyCount,
  };
}

function namesById(users: readonly { id: string; displayName: string }[]): Map<string, string> {
  return new Map(users.map((user) => [user.id, user.displayName]));
}

/** The display name of user `id`; `null` for the command line (`id` null) and for users that no longer exist. */
function nameOf(names: ReadonlyMap<string, string>, id: string | null): string | null {
  return id === null ? null : (names.get(id) ?? null);
}

async function userNames(repos: Repositories): Promise<Map<string, string>> {
  return namesById(await repos.users.list());
}

/**
 * Whether the `local` workspace holds a pre-account installation's history (any deck)
 * and has no owner yet, for the first admin to adopt. Every database has a `local`
 * workspace (it is seeded when the database opens), so on a fresh installation it exists
 * but is empty; adopting that would greet the admin with history that is not there.
 */
async function hasUnownedLocalHistory(repos: Repositories): Promise<boolean> {
  const [hasDecks, owner] = await Promise.all([
    repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID),
    repos.users.getByWorkspaceId(LOCAL_WORKSPACE_ID),
  ]);
  return hasDecks && owner === null;
}

function userNotFound(): UserOutcome {
  return { ok: false, reason: 'not-found', message: USER_NOT_FOUND };
}

/** How the logs name an admin: the user id, or `command line` for the {@link SYSTEM_ACTOR}. */
function actorLabel(adminId: string | null): string {
  return adminId ?? 'command line';
}
