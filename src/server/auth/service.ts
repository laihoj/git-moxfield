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
 * of theirs out and revokes their bookmarklets, and the person sees on their account
 * page whose link it was, so it cannot be used quietly.
 *
 * Revocation reaches everything derived: a session made through a device link descends
 * from the bookmarklet key of the session that made the link, so revoking a key ends
 * those sessions and unused links too; signing out everywhere, being disabled or
 * recovered withdraws unused links; disabling an admin withdraws the invites and links
 * they made (and links made by an admin who is no longer an active admin never work).
 *
 * Every multi-step change (accepting an invite, consuming a link, claiming, revoking)
 * runs in one `IMMEDIATE` transaction, so one-time things stay one-time across
 * concurrent requests and processes.
 */
import 'server-only';

import { buildBookmarklet } from '@/integrations/moxfield/capture';
import type { AppConfig } from '@/server/config';
import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import {
  createRepositories,
  type CredentialRecord,
  type DbExecutor,
  type InviteRecord,
  type LoginLinkPurpose,
  type PendingHandoff,
  type Repositories,
  type SessionOrigin,
  type SessionRecord,
  type UserListItem,
  type UserRecord,
  type UserRole,
} from '@/server/repositories';
import { ServiceError } from '@/server/services/errors';
import { settle } from '@/server/services/settle';

import { SESSION_MAX_AGE_S } from './cookie-spec';
import { CLAIM_PATH, invitePath, loginLinkPath } from './paths';
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
  IssuedInvite,
  IssuedLink,
  KeyRefDTO,
  LoginLinkStatusDTO,
  RecoveryLinkDTO,
  RecoveryUseDTO,
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

const USER_ROLES: readonly string[] = ['admin', 'member'] satisfies UserRole[];

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
   * ({@link BookmarkletKeyDTO.derived}); otherwise those keep working.
   * @returns whether an active key was revoked.
   */
  revokeKey(user: SessionUser, keyId: string, options?: { includeDerived?: boolean }): Promise<boolean>;

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
   * their bookmarklet keys and withdraws their unused links, so a lost or stolen device
   * is cut off and an admin's misuse cannot go unnoticed.
   */
  consumeLoginLink(token: unknown, userAgent: string | null): Promise<SignIn | null>;

  // --- Invites --------------------------------------------------------------------

  /**
   * An invite for a new user with `role`, valid for {@link INVITE_LIFETIME_MS}. Admins
   * (or the command line) only.
   * @throws {ServiceError} `forbidden` for non-admins; `invalid-input` for an invalid note or role.
   */
  createInvite(actor: Actor, input: { role: UserRole; note?: string }): Promise<IssuedInvite>;
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
  db: DbExecutor;
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

const INVITE_PROBLEMS: Record<Exclude<InviteLinkStatusDTO['status'], 'valid'>, string> = {
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

  signInWithKey(
    key: unknown,
    userAgent: string | null,
    options: { currentSessionToken?: string | null } = {},
  ): Promise<SignIn | null> {
    return settle(() => {
      const holder = this.keyHolder(key);
      if (!holder) return null;
      const now = this.now();
      const currentToken = options.currentSessionToken ?? null;
      const current = this.findSession(currentToken, now);
      if (current !== null && currentToken !== null && current.user.id === holder.user.id) {
        return this.continueSession(current, currentToken, now);
      }
      const signIn = this.issueSession(this.repos, holder.user, {
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
    });
  }

  startKeyHandoff(key: unknown, userAgent: string | null): Promise<StartedHandoff | null> {
    return settle(() => {
      const holder = this.keyHolder(key);
      if (!holder) return null;
      const started = this.issueSession(
        this.repos,
        holder.user,
        { createdVia: 'bookmarklet', credentialId: holder.credential.id, userAgent, pendingHandoff: true },
        HANDOFF_LIFETIME_MS,
      );
      return { user: started.user, handoff: started.session };
    });
  }

  completeHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<HandoffOutcome | null> {
    return settle(() =>
      this.repos.transaction((tx): HandoffOutcome | null => {
        const now = this.now();
        const handoff = this.findHandoff(tx, handoffToken, now);
        if (handoff === null) return null;
        const current = this.findSession(currentSessionToken, now);
        if (current !== null && currentSessionToken !== null && current.user.id === handoff.user.id) {
          // The browser is already signed in as the key's owner: nothing to ask.
          tx.sessions.revoke(handoff.user.id, handoff.session.id, now.toISOString());
          return { kind: 'kept', signIn: this.continueSession(current, currentSessionToken, now) };
        }
        return { kind: 'confirm', confirmation: toHandoffConfirmation(handoff, current) };
      }),
    );
  }

  describeHandoff(
    handoffToken: unknown,
    currentSessionToken: string | null,
  ): Promise<HandoffConfirmationDTO | null> {
    return settle(() => {
      const now = this.now();
      const handoff = this.findHandoff(this.repos, handoffToken, now);
      if (handoff === null) return null;
      return toHandoffConfirmation(handoff, this.findSession(currentSessionToken, now));
    });
  }

  confirmHandoff(handoffToken: unknown, currentSessionToken: string | null): Promise<SignIn | null> {
    return settle(() =>
      this.repos.transaction((tx): SignIn | null => {
        const now = this.now();
        const at = now.toISOString();
        const handoff = this.findHandoff(tx, handoffToken, now);
        if (handoff === null || typeof handoffToken !== 'string') return null;
        const current = this.findSession(currentSessionToken, now);
        if (current !== null && currentSessionToken !== null && current.user.id === handoff.user.id) {
          tx.sessions.revoke(handoff.user.id, handoff.session.id, at);
          return this.continueSession(current, currentSessionToken, now);
        }
        const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
        if (!tx.sessions.promoteHandoff(handoff.session.id, at, expiresAt)) return null;
        this.logger.info('Signed in with a bookmarklet key', {
          userId: handoff.user.id,
          keyId: handoff.credential.id,
          sessionId: handoff.session.id,
          replacedSessionOfAnotherUser: current !== null,
        });
        return {
          user: toSessionUser(handoff.user, handoff.session.id),
          session: { id: handoff.session.id, token: handoffToken, expiresAt },
        };
      }),
    );
  }

  cancelHandoff(handoffToken: unknown): Promise<void> {
    return settle(() => {
      const parsed = parseToken('session', handoffToken);
      if (parsed === null) return;
      if (this.repos.sessions.revokePendingHandoff(hashToken(parsed), this.now().toISOString())) {
        this.logger.info('A bookmarklet sign-in was declined');
      }
    });
  }

  resolveSession(token: string | null | undefined): Promise<SessionUser | null> {
    return settle(() => {
      const now = this.now();
      const found = this.findSession(token, now);
      if (!found) return null;
      this.recordActivity(found, now);
      return toSessionUser(found.user, found.session.id);
    });
  }

  endSession(token: string | null | undefined): Promise<void> {
    return settle(() => {
      const parsed = parseToken('session', token);
      if (parsed === null) return;
      this.repos.sessions.revokeByTokenHash(hashToken(parsed), this.now().toISOString());
    });
  }

  endAllSessions(user: SessionUser): Promise<number> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const at = this.now().toISOString();
        const ended = tx.sessions.revokeAllForUser(user.id, at);
        const links = tx.loginLinks.revokeUnused({ userId: user.id, purpose: 'device' }, at);
        this.logger.info('Signed out everywhere', { userId: user.id, sessions: ended, deviceLinks: links });
        return ended;
      }),
    );
  }

  endOtherSessions(user: SessionUser): Promise<number> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const at = this.now().toISOString();
        const ended = tx.sessions.revokeAllForUser(user.id, at, { exceptSessionId: user.sessionId });
        const links = tx.loginLinks.revokeUnused({ userId: user.id, purpose: 'device' }, at);
        this.logger.info('Signed out other devices', {
          userId: user.id,
          sessions: ended,
          deviceLinks: links,
        });
        return ended;
      }),
    );
  }

  listSessions(user: SessionUser): Promise<SessionDTO[]> {
    return settle(() =>
      this.repos.sessions.listActiveForUser(user.id, this.now().toISOString()).map((session) => ({
        id: session.id,
        createdVia: session.createdVia,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        current: session.id === user.sessionId,
      })),
    );
  }

  revokeSession(user: SessionUser, sessionId: string): Promise<boolean> {
    return settle(() => this.repos.sessions.revoke(user.id, sessionId, this.now().toISOString()));
  }

  // -------------------------------------------------------------------------
  // Bookmarklet keys
  // -------------------------------------------------------------------------

  createBookmarkletKey(user: SessionUser, label: string, appUrl: string): Promise<CreatedBookmarkletKey> {
    return settle(() => {
      const validation = validateKeyLabel(label);
      if (!validation.ok) throw new ServiceError('invalid-input', validation.message);
      const key = generateToken('key');
      // Built before anything is stored: an unusable app URL must not leave a key behind.
      const bookmarklets = this.bookmarklets(key, appUrl);
      return this.repos.transaction((tx) => {
        const session = this.requireOwnSession(tx, user);
        const record = tx.credentials.createKey({
          userId: user.id,
          label: validation.value,
          secretHash: hashToken(key),
          createdByCredentialId: session.credentialId,
        });
        this.logger.info('Bookmarklet key created', {
          userId: user.id,
          keyId: record.id,
          madeFromKeyId: record.createdByCredentialId,
        });
        const all = tx.credentials.listForUser(user.id, { includeRevoked: true });
        return { key: toKeyDTO(record, all), bookmarklets };
      });
    });
  }

  listKeys(user: SessionUser): Promise<BookmarkletKeyDTO[]> {
    return settle(() => {
      const all = this.repos.credentials.listForUser(user.id, { includeRevoked: true });
      return all.filter((key) => key.revokedAt === null).map((key) => toKeyDTO(key, all));
    });
  }

  revokeKey(user: SessionUser, keyId: string, options: { includeDerived?: boolean } = {}): Promise<boolean> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const at = this.now().toISOString();
        const derived =
          options.includeDerived === true
            ? descendantKeyIds(tx.credentials.listForUser(user.id, { includeRevoked: true }), keyId)
            : [];
        if (!tx.credentials.revoke(user.id, keyId, at)) return false;
        let derivedKeys = 0;
        let sessions = 0;
        let deviceLinks = 0;
        for (const id of [keyId, ...derived]) {
          if (id !== keyId && tx.credentials.revoke(user.id, id, at)) derivedKeys += 1;
          sessions += tx.sessions.revokeAllForUser(user.id, at, {
            credentialId: id,
            exceptSessionId: user.sessionId,
          });
          deviceLinks += tx.loginLinks.revokeUnused({ userId: user.id, credentialId: id }, at);
        }
        this.logger.info('Bookmarklet key revoked', {
          userId: user.id,
          keyId,
          derivedKeys,
          endedSessions: sessions,
          deviceLinks,
        });
        return true;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // One-time sign-in links
  // -------------------------------------------------------------------------

  createDeviceLink(user: SessionUser): Promise<IssuedLink> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const session = this.requireOwnSession(tx, user);
        const link = this.issueLoginLink(tx, {
          userId: user.id,
          purpose: 'device',
          createdByUserId: user.id,
          credentialId: session.credentialId,
          lifetimeMs: DEVICE_LINK_LIFETIME_MS,
        });
        this.logger.info('Device link created', { userId: user.id });
        return link;
      }),
    );
  }

  createRecoveryLink(actor: Actor, userId: string): Promise<IssuedLink> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const actorId = this.requireAdmin(tx, actor);
        if (actorId === userId) {
          throw new ServiceError(
            'invalid-input',
            'You can’t make a recovery link for yourself. On a device where you’re signed in, use “Sign in on another device” in Account instead.',
          );
        }
        const target = tx.users.getById(userId);
        if (!target) throw new ServiceError('not-found', 'This user does not exist.');
        if (target.disabledAt !== null) {
          throw new ServiceError(
            'invalid-input',
            `${target.displayName} is disabled. Enable the account before creating a recovery link.`,
          );
        }
        // Only the newest recovery link of a user works.
        const replaced = tx.loginLinks.revokeUnused(
          { userId, purpose: 'recovery' },
          this.now().toISOString(),
        );
        const link = this.issueLoginLink(tx, {
          userId,
          purpose: 'recovery',
          createdByUserId: actorId,
          credentialId: null,
          lifetimeMs: RECOVERY_LINK_LIFETIME_MS,
        });
        this.logger.info('Recovery link created', {
          userId,
          createdBy: actorId ?? 'command line',
          replacedLinks: replaced,
        });
        return link;
      }),
    );
  }

  listRecoveryLinks(actor: Actor): Promise<RecoveryLinkDTO[]> {
    return settle(() => {
      this.requireAdmin(this.repos, actor);
      const people = this.repos.users.list();
      const names = new Map(people.map((person) => [person.id, person.displayName]));
      return this.repos.loginLinks
        .listPending('recovery', this.now().toISOString())
        .filter((link) => this.repos.loginLinks.hasActiveCreator(link))
        .map((link) => ({
          id: link.id,
          user: { id: link.userId, displayName: names.get(link.userId) ?? '' },
          createdBy: link.createdByUserId === null ? null : (names.get(link.createdByUserId) ?? null),
          createdAt: link.createdAt,
          expiresAt: link.expiresAt,
        }));
    });
  }

  revokeRecoveryLink(actor: Actor, linkId: string): Promise<boolean> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const actorId = this.requireAdmin(tx, actor);
        const revoked = tx.loginLinks.revoke(linkId, this.now().toISOString(), { purpose: 'recovery' });
        if (revoked) {
          this.logger.info('Recovery link withdrawn', { linkId, revokedBy: actorId ?? 'command line' });
        }
        return revoked;
      }),
    );
  }

  listRecoveryUses(user: SessionUser): Promise<RecoveryUseDTO[]> {
    return settle(() => {
      const names = userNames(this.repos);
      return this.repos.loginLinks.listUsedForUser(user.id, 'recovery').flatMap((link) =>
        link.usedAt === null
          ? []
          : [
              {
                createdBy: link.createdByUserId === null ? null : (names.get(link.createdByUserId) ?? null),
                createdAt: link.createdAt,
                usedAt: link.usedAt,
              },
            ],
      );
    });
  }

  getLoginLink(token: unknown): Promise<LoginLinkStatusDTO> {
    return settle((): LoginLinkStatusDTO => {
      const parsed = parseToken('login', token);
      const link = parsed === null ? null : this.repos.loginLinks.getByTokenHash(hashToken(parsed));
      if (!link) return { status: 'invalid' };
      if (link.usedAt !== null) return { status: 'used' };
      if (link.revokedAt !== null || !this.repos.loginLinks.hasActiveCreator(link))
        return { status: 'revoked' };
      if (link.expiresAt <= this.now().toISOString()) return { status: 'expired' };
      const user = this.repos.users.getById(link.userId);
      if (user?.disabledAt !== null) return { status: 'invalid' };
      return {
        status: 'valid',
        purpose: link.purpose,
        displayName: user.displayName,
        expiresAt: link.expiresAt,
      };
    });
  }

  consumeLoginLink(token: unknown, userAgent: string | null): Promise<SignIn | null> {
    return settle(() => {
      const parsed = parseToken('login', token);
      if (parsed === null) return null;
      return this.repos.transaction((tx) => {
        const at = this.now().toISOString();
        const consumed = tx.loginLinks.consume(hashToken(parsed), at);
        if (!consumed) return null;
        const { link, user } = consumed;
        if (link.purpose === 'recovery') {
          // Recovery is for someone who lost every way in: whatever else still signs in as
          // them (a lost or stolen device, an old bookmarklet) stops working now.
          const endedSessions = tx.sessions.revokeAllForUser(user.id, at);
          const revokedKeys = tx.credentials.revokeAllForUser(user.id, at);
          const revokedLinks = tx.loginLinks.revokeUnused({ userId: user.id }, at);
          this.logger.info('Recovery link used: other sessions ended, keys revoked', {
            userId: user.id,
            createdBy: link.createdByUserId ?? 'command line',
            endedSessions,
            revokedKeys,
            revokedLinks,
          });
        }
        const signIn = this.issueSession(tx, user, {
          createdVia: link.purpose === 'device' ? 'device-link' : 'recovery-link',
          // A device link's session descends from the key its creating session descends from.
          credentialId: link.purpose === 'device' ? link.credentialId : null,
          userAgent,
        });
        this.logger.info('Signed in with a one-time link', {
          userId: user.id,
          purpose: link.purpose,
          sessionId: signIn.session.id,
        });
        return signIn;
      });
    });
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  createInvite(actor: Actor, input: { role: UserRole; note?: string }): Promise<IssuedInvite> {
    return settle(() => {
      // Checked at runtime too: callers may pass a role straight from a form.
      if (!USER_ROLES.includes(input.role)) {
        throw new ServiceError('invalid-input', 'An invite is for a member or an admin.');
      }
      const note = validateInviteNote(input.note ?? '');
      if (!note.ok) throw new ServiceError('invalid-input', note.message);
      return this.repos.transaction((tx) => {
        const actorId = this.requireAdmin(tx, actor);
        const token = generateToken('invite');
        const expiresAt = this.expiry(INVITE_LIFETIME_MS);
        const record = tx.invites.create({
          tokenHash: hashToken(token),
          role: input.role,
          note: note.value,
          createdByUserId: actorId,
          expiresAt,
        });
        this.logger.info('Invite created', {
          inviteId: record.id,
          role: record.role,
          createdBy: actorId ?? 'command line',
        });
        return { invite: this.toInviteDTO(record, userNames(tx), true), path: invitePath(token), expiresAt };
      });
    });
  }

  getInvite(token: unknown): Promise<InviteLinkStatusDTO> {
    return settle((): InviteLinkStatusDTO => {
      const parsed = parseToken('invite', token);
      const invite = parsed === null ? null : this.repos.invites.getByTokenHash(hashToken(parsed));
      if (!invite) return { status: 'invalid' };
      const status = this.inviteStatus(invite, this.repos.invites.hasActiveCreator(invite));
      return status === 'pending'
        ? { status: 'valid', role: invite.role, expiresAt: invite.expiresAt }
        : { status };
    });
  }

  acceptInvite(token: unknown, displayName: string, userAgent: string | null): Promise<AcceptInviteOutcome> {
    return settle((): AcceptInviteOutcome => {
      const name = validateDisplayName(displayName);
      if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
      const parsed = parseToken('invite', token);
      if (parsed === null) return { ok: false, reason: 'invalid', message: INVITE_PROBLEMS.invalid };
      const tokenHash = hashToken(parsed);
      return this.repos.transaction((tx): AcceptInviteOutcome => {
        const adopt = tx.invites.getByTokenHash(tokenHash)?.role === 'admin' && hasUnownedLocalHistory(tx);
        const accepted = tx.invites.accept(tokenHash, this.now().toISOString(), {
          displayName: name.value,
          ...(adopt ? { adoptWorkspaceId: LOCAL_WORKSPACE_ID } : {}),
        });
        if (!accepted) {
          const invite = tx.invites.getByTokenHash(tokenHash);
          const status = invite ? this.inviteStatus(invite, tx.invites.hasActiveCreator(invite)) : 'invalid';
          const reason = status === 'pending' ? 'invalid' : status;
          return { ok: false, reason, message: INVITE_PROBLEMS[reason] };
        }
        const signIn = this.issueSession(tx, accepted.user, { createdVia: 'invite', userAgent });
        this.logger.info('Invite accepted', {
          inviteId: accepted.invite.id,
          userId: accepted.user.id,
          role: accepted.user.role,
          adoptedLocalWorkspace: adopt,
        });
        return { ok: true, signIn };
      });
    });
  }

  listInvites(actor: Actor): Promise<InviteDTO[]> {
    return settle(() => {
      this.requireAdmin(this.repos, actor);
      const people = this.repos.users.list();
      const names = new Map(people.map((person) => [person.id, person.displayName]));
      const activeAdmins = new Set(
        people.filter((person) => person.role === 'admin' && person.disabledAt === null).map((p) => p.id),
      );
      return this.repos.invites
        .list()
        .map((invite) =>
          this.toInviteDTO(
            invite,
            names,
            invite.createdByUserId === null || activeAdmins.has(invite.createdByUserId),
          ),
        );
    });
  }

  revokeInvite(actor: Actor, inviteId: string): Promise<boolean> {
    return settle(() =>
      this.repos.transaction((tx) => {
        const actorId = this.requireAdmin(tx, actor);
        const revoked = tx.invites.revoke(inviteId, this.now().toISOString());
        if (revoked) this.logger.info('Invite revoked', { inviteId, revokedBy: actorId ?? 'command line' });
        return revoked;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  listUsers(actor: Actor): Promise<UserDTO[]> {
    return settle(() => {
      this.requireAdmin(this.repos, actor);
      return this.repos.users.list().map(toUserDTO);
    });
  }

  disableUser(actor: Actor, userId: string): Promise<UserOutcome> {
    return settle(() =>
      this.repos.transaction((tx): UserOutcome => {
        const actorId = this.requireAdmin(tx, actor);
        if (actorId === userId) {
          return { ok: false, reason: 'self', message: 'You cannot disable your own account.' };
        }
        const target = tx.users.getById(userId);
        if (!target) return userNotFound();
        if (target.role === 'admin' && target.disabledAt === null && tx.users.countActiveAdmins() <= 1) {
          return { ok: false, reason: 'last-admin', message: 'The last admin cannot be disabled.' };
        }
        const at = this.now().toISOString();
        tx.users.setDisabled(userId, true);
        const ended = tx.sessions.revokeAllForUser(userId, at);
        // Withdrawn for good, so enabling the user again revives none of it: links that
        // sign them in, and what they made as an admin (invites, recovery links).
        const linksForThem = tx.loginLinks.revokeUnused({ userId }, at);
        const linksByThem = tx.loginLinks.revokeUnused({ createdByUserId: userId }, at);
        const invites = tx.invites.revokePendingCreatedBy(userId, at);
        this.logger.info('User disabled', {
          userId,
          disabledBy: actorId ?? 'command line',
          endedSessions: ended,
          revokedLinks: linksForThem + linksByThem,
          revokedInvites: invites,
        });
        return { ok: true, user: this.userDTO(tx, userId) };
      }),
    );
  }

  enableUser(actor: Actor, userId: string): Promise<UserOutcome> {
    return settle(() =>
      this.repos.transaction((tx): UserOutcome => {
        const actorId = this.requireAdmin(tx, actor);
        if (!tx.users.getById(userId)) return userNotFound();
        tx.users.setDisabled(userId, false);
        this.logger.info('User enabled', { userId, enabledBy: actorId ?? 'command line' });
        return { ok: true, user: this.userDTO(tx, userId) };
      }),
    );
  }

  renameUser(actor: Actor, userId: string, displayName: string): Promise<UserOutcome> {
    return settle(() =>
      this.repos.transaction((tx) => {
        this.requireAdmin(tx, actor);
        return this.rename(tx, userId, displayName);
      }),
    );
  }

  renameSelf(user: SessionUser, displayName: string): Promise<UserOutcome> {
    return settle(() => this.repos.transaction((tx) => this.rename(tx, user.id, displayName)));
  }

  // -------------------------------------------------------------------------
  // First run
  // -------------------------------------------------------------------------

  isClaimable(): Promise<boolean> {
    return settle(() => this.repos.users.count() === 0);
  }

  claimStatus(): Promise<ClaimStatusDTO> {
    return settle(() => {
      if (this.repos.users.count() > 0) return { claimable: false };
      const code = this.ensureSetupCode();
      const where =
        this.config.PUBLIC_APP_URL === undefined
          ? CLAIM_PATH
          : new URL(CLAIM_PATH, this.config.PUBLIC_APP_URL).href;
      this.logger.warn(
        `git-moxfield has no admin yet. To claim it, open ${where} and enter the setup code ${code}`,
        { path: CLAIM_PATH },
      );
      return { claimable: true };
    });
  }

  setupCode(): Promise<string | null> {
    return settle(() => (this.repos.users.count() > 0 ? null : this.ensureSetupCode()));
  }

  claim(code: string, displayName: string, userAgent: string | null): Promise<ClaimOutcome> {
    return settle((): ClaimOutcome => {
      const name = validateDisplayName(displayName);
      if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
      const typed = normalizeSetupCode(code);
      return this.repos.transaction((tx): ClaimOutcome => {
        // Inside one IMMEDIATE transaction: a concurrent claim either committed before
        // (and this one sees its user) or waits until this one has committed.
        if (tx.users.count() > 0) {
          return {
            ok: false,
            reason: 'claimed',
            message: 'git-moxfield already has an admin. Ask them for an invite.',
          };
        }
        const stored = tx.settings.get(SETUP_CODE_SETTING);
        if (stored === null || typed === null || !setupCodesEqual(typed, stored)) {
          this.logger.warn('Rejected a claim with a wrong setup code');
          return {
            ok: false,
            reason: 'invalid-code',
            message: 'That is not the setup code. Copy it from the server log and try again.',
          };
        }
        const adopt = hasUnownedLocalHistory(tx);
        const user = adopt
          ? tx.users.createForWorkspace({
              displayName: name.value,
              role: 'admin',
              workspaceId: LOCAL_WORKSPACE_ID,
            })
          : tx.users.create({ displayName: name.value, role: 'admin' });
        tx.settings.delete(SETUP_CODE_SETTING);
        const signIn = this.issueSession(tx, user, { createdVia: 'claim', userAgent });
        this.logger.info('git-moxfield claimed', { userId: user.id, adoptedLocalWorkspace: adopt });
        return { ok: true, signIn, adoptedLocalWorkspace: adopt };
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The active key `key` and its (enabled) owner, recording the key's use; `null` otherwise. */
  private keyHolder(key: unknown): { credential: CredentialRecord; user: UserRecord } | null {
    const parsed = parseToken('key', key);
    if (parsed === null) return null;
    const found = this.repos.credentials.findActiveBySecretHash(hashToken(parsed));
    if (found?.credential.kind !== 'bookmarklet-key') return null;
    this.repos.credentials.touchLastUsed(found.credential.id, this.now().toISOString());
    return found;
  }

  /** The active session of a session token (format checked before any lookup). */
  private findSession(token: unknown, now: Date): ActiveSession | null {
    const parsed = parseToken('session', token);
    if (parsed === null) return null;
    return this.repos.sessions.findActiveByTokenHash(hashToken(parsed), now.toISOString());
  }

  /** The pending hand-off of a hand-off token (format checked before any lookup). */
  private findHandoff(repos: Repositories, token: unknown, now: Date): PendingHandoff | null {
    const parsed = parseToken('session', token);
    if (parsed === null) return null;
    return repos.sessions.findPendingHandoffByTokenHash(hashToken(parsed), now.toISOString());
  }

  /**
   * The asking session of `user`, which must still be active: what a user makes from a
   * session (keys, device links) inherits its lineage, and nothing is made for a session
   * that ended meanwhile (signed out everywhere, revoked key).
   */
  private requireOwnSession(repos: Repositories, user: SessionUser): SessionRecord {
    const session = repos.sessions.getActive(user.id, user.sessionId, this.now().toISOString());
    if (session === null) throw new ServiceError('forbidden', 'You were signed out. Sign in again.');
    return session;
  }

  /** Keeps an existing session: records activity and returns it with its current expiry. */
  private continueSession(found: ActiveSession, token: string, now: Date): SignIn {
    const expiresAt = this.recordActivity(found, now);
    return {
      user: toSessionUser(found.user, found.session.id),
      session: { id: found.session.id, token, expiresAt },
    };
  }

  /**
   * Sliding expiry and activity: renews the session to {@link SESSION_LIFETIME_MS} from
   * now once its expiry is more than {@link SESSION_RENEWAL_INTERVAL_MS} older than that,
   * and records the user's activity at most every {@link USER_SEEN_INTERVAL_MS}.
   * @returns the session's expiry after the update.
   */
  private recordActivity({ session, user }: ActiveSession, now: Date): string {
    const renewed = now.getTime() + SESSION_LIFETIME_MS;
    let { expiresAt } = session;
    if (Date.parse(expiresAt) <= renewed - SESSION_RENEWAL_INTERVAL_MS) {
      expiresAt = new Date(renewed).toISOString();
      this.repos.sessions.touch(session.id, { lastSeenAt: now.toISOString(), expiresAt });
    }
    if (user.lastSeenAt === null || now.getTime() - Date.parse(user.lastSeenAt) >= USER_SEEN_INTERVAL_MS) {
      this.repos.users.touchLastSeen(user.id, now.toISOString());
    }
    return expiresAt;
  }

  private issueSession(
    repos: Repositories,
    user: UserRecord,
    origin: {
      createdVia: SessionOrigin;
      credentialId?: string | null;
      userAgent: string | null;
      pendingHandoff?: boolean;
    },
    lifetimeMs = SESSION_LIFETIME_MS,
  ): SignIn {
    const token = generateToken('session');
    const expiresAt = this.expiry(lifetimeMs);
    const session = repos.sessions.create({
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

  private issueLoginLink(
    repos: Repositories,
    link: {
      userId: string;
      purpose: LoginLinkPurpose;
      createdByUserId: string | null;
      credentialId: string | null;
      lifetimeMs: number;
    },
  ): IssuedLink {
    const token = generateToken('login');
    const expiresAt = this.expiry(link.lifetimeMs);
    repos.loginLinks.create({
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
   * Checks that `actor` may administer users and invites, against the database (a
   * session's role may be stale). @returns the admin's user id, `null` for the command line.
   */
  private requireAdmin(repos: Repositories, actor: Actor): string | null {
    if (actor === SYSTEM_ACTOR) return null;
    const current = repos.users.getById(actor.id);
    if (current?.role !== 'admin' || current.disabledAt !== null) {
      throw new ServiceError('forbidden', 'Only admins can manage users and invites.');
    }
    return current.id;
  }

  private rename(repos: Repositories, userId: string, displayName: string): UserOutcome {
    const name = validateDisplayName(displayName);
    if (!name.ok) return { ok: false, reason: 'invalid-name', message: name.message };
    if (!repos.users.getById(userId)) return userNotFound();
    repos.users.rename(userId, name.value);
    return { ok: true, user: this.userDTO(repos, userId) };
  }

  private userDTO(repos: Repositories, userId: string): UserDTO {
    const listed = repos.users.list().find((user) => user.id === userId);
    if (!listed) throw new Error(`User ${userId} vanished while being updated`);
    return toUserDTO(listed);
  }

  private ensureSetupCode(): string {
    const code = this.repos.settings.getOrCreate(SETUP_CODE_SETTING, generateSetupCode);
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
    if (invite.usedAt !== null) return 'used';
    if (invite.revokedAt !== null || !creatorActive) return 'revoked';
    if (invite.expiresAt <= this.now().toISOString()) return 'expired';
    return 'pending';
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
      createdBy: invite.createdByUserId === null ? null : (names.get(invite.createdByUserId) ?? null),
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
 * name what the key was made from and what was made through it.
 */
function toKeyDTO(record: CredentialRecord, all: readonly CredentialRecord[]): BookmarkletKeyDTO {
  const byId = new Map(all.map((key) => [key.id, key]));
  const parent = record.createdByCredentialId === null ? undefined : byId.get(record.createdByCredentialId);
  const derived = descendantKeyIds(all, record.id)
    .map((id) => byId.get(id))
    .filter((key): key is CredentialRecord => key?.revokedAt === null);
  return {
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    madeFrom: parent === undefined ? null : keyRef(parent),
    derived: derived.map(keyRef),
  };
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
    const siblings = children.get(key.createdByCredentialId) ?? [];
    siblings.push(key);
    children.set(key.createdByCredentialId, siblings);
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

function userNames(repos: Repositories): Map<string, string> {
  return new Map(repos.users.list().map((user) => [user.id, user.displayName]));
}

/**
 * Whether the `local` workspace holds a pre-account installation's history (any deck)
 * and has no owner yet, for the first admin to adopt. Every database has a `local`
 * workspace (it is seeded when the database opens), so on a fresh installation it exists
 * but is empty; adopting that would greet the admin with history that is not there.
 */
function hasUnownedLocalHistory(repos: Repositories): boolean {
  return (
    repos.workspaces.hasDecks(LOCAL_WORKSPACE_ID) && repos.users.getByWorkspaceId(LOCAL_WORKSPACE_ID) === null
  );
}

function userNotFound(): UserOutcome {
  return { ok: false, reason: 'not-found', message: 'This user does not exist.' };
}
