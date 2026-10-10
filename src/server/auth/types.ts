/**
 * Types of the auth service API (`./service`). Everything here is plain, serializable
 * data. Secrets appear in exactly three places, each documented where it is: a session
 * token in {@link IssuedSession.token} (for the cookie only), a link token inside
 * {@link IssuedLink.path} / {@link IssuedInvite.path} (shown once to whoever creates the
 * link), and a bookmarklet key inside {@link BookmarkletsDTO} (shown once, inside the
 * bookmarklet).
 */
import type { LoginLinkPurpose, SessionOrigin, UserRole } from '@/server/repositories';

export type { LoginLinkPurpose, SessionOrigin, UserRole } from '@/server/repositories';

/**
 * The signed-in user of a request, as resolved from the session cookie
 * (`resolveSession`, `getCurrentUser`). The only identity the access layer accepts.
 */
export interface SessionUser {
  id: string;
  displayName: string;
  role: UserRole;
  /** The user's workspace: every deck the user can see or change lives in it. */
  workspaceId: string;
  /** The session the request was made with (marks "this device" in session lists). */
  sessionId: string;
}

/** A session a browser should hold. */
export interface IssuedSession {
  id: string;
  /**
   * The session token: put it in the session cookie and nowhere else (never log it,
   * render it or send it to the browser in a response body).
   */
  token: string;
  expiresAt: string;
}

/** The result of a successful sign-in: who signed in, and the session to set as cookie. */
export interface SignIn {
  user: SessionUser;
  session: IssuedSession;
}

/** A bookmarklet key named by its label, in another key's listing. */
export interface KeyRefDTO {
  id: string;
  label: string;
}

/** A bookmarklet key as listed to its owner (the secret itself is never stored). */
export interface BookmarkletKeyDTO {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /**
   * The key that signed in the browser this one was made in (directly, or through a
   * device link made there), also when that key is revoked by now; `null` when the
   * browser was signed in otherwise (invite, claim, recovery).
   */
  madeFrom: KeyRefDTO | null;
  /**
   * Active keys made, directly or in turn, in browsers this key signed in: what someone
   * holding a stolen copy of this key could have made. Revoking this key can revoke them
   * too (`revokeKey` with `includeDerived`); a legitimate replacement looks the same, so
   * it is the owner's choice.
   */
  derived: KeyRefDTO[];
  /**
   * Share links (ADR 0007) that are not revoked and were made in browsers this key signed
   * in (directly, or through a device link made on one of them): read access someone
   * holding a stolen copy of this key could have handed out, and which outlives the key.
   * `revokeKey` with `includeShareLinks` revokes them; they may be the owner's own, so it
   * is the owner's choice.
   */
  shareLinkCount: number;
  /**
   * Share links made the same way through the keys made through this one (see
   * `derived`): `revokeKey` with both `includeDerived` and `includeShareLinks` revokes
   * these too.
   */
  derivedShareLinkCount: number;
}

/**
 * A revoked bookmarklet key whose share links (ADR 0007) still work: read access made in
 * browsers it signed in, which outlived the key because it was revoked without them. The
 * owner can still revoke those links (`revokeKeyShareLinks`).
 */
export interface RevokedKeyShareLinksDTO {
  id: string;
  label: string;
  revokedAt: string;
  /**
   * Share links that are not revoked and were made in browsers this key signed in
   * (directly, or through a device link made on one of them); at least 1.
   */
  shareLinkCount: number;
}

/** The "Send to git-moxfield" bookmarklets of one key, as `javascript:` URLs. */
export interface BookmarkletsDTO {
  /** Desktop browsers: opens git-moxfield in a popup and hands the deck over by `postMessage`. */
  popup: string;
  /** Phones and in-app browsers: posts the deck to git-moxfield in the same tab. */
  sameTab: string;
}

/**
 * A newly created key. Both bookmarklets embed the key in plaintext: this is the only
 * time it exists outside its owner's bookmarks. Show them once, to the owner; never log
 * or store them.
 */
export interface CreatedBookmarkletKey {
  key: BookmarkletKeyDTO;
  bookmarklets: BookmarkletsDTO;
}

/** A signed-in browser as listed to its user. */
export interface SessionDTO {
  id: string;
  createdVia: SessionOrigin;
  /** Truncated User-Agent of the browser that signed in. */
  userAgent: string | null;
  createdAt: string;
  /** Recorded at most daily. */
  lastSeenAt: string;
  expiresAt: string;
  /** Whether this is the session of the request that asked. */
  current: boolean;
}

/**
 * A new one-time link. `path` contains the link token (`/signin/gml_…`, `/invite/gmi_…`):
 * show the full URL once to whoever created the link; never log or store it.
 */
export interface IssuedLink {
  path: string;
  expiresAt: string;
}

/** What a device or recovery link would do, for the page that asks before signing in. */
export type LoginLinkStatusDTO =
  | { status: 'valid'; purpose: LoginLinkPurpose; displayName: string; expiresAt: string }
  | { status: 'invalid' | 'expired' | 'used' | 'revoked' };

/** A recovery link that can still be used, as listed to admins (never its token). */
export interface RecoveryLinkDTO {
  id: string;
  /** Who the link signs in. */
  user: { id: string; displayName: string };
  /** Display name of the admin who made it; `null` for the command line. */
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * A recovery link that signed in as the user, as shown to that user: the record of an
 * admin's link being used, which nobody signed in as them can remove.
 */
export interface RecoveryUseDTO {
  /** Display name of the admin who made the link; `null` for the command line. */
  createdBy: string | null;
  createdAt: string;
  usedAt: string;
}

/**
 * A hand-off the same-tab bookmarklet started (`POST /api/capture/form`): the key's
 * owner, and the hand-off token for the hand-off cookie (put it there and nowhere else;
 * it signs nobody in until the browser completes the hand-off).
 */
export interface StartedHandoff {
  user: SessionUser;
  handoff: IssuedSession;
}

/**
 * What confirming a bookmarklet hand-off would do, for the page that asks. Display names
 * are not unique, so the key's label and creation date identify the account too.
 */
export interface HandoffConfirmationDTO {
  /** The account the bookmarklet signs in: the key's owner. */
  displayName: string;
  /** The bookmarklet (key) that was run. */
  keyLabel: string;
  keyCreatedAt: string;
  /**
   * The account this browser is signed in as now, which confirming signs out of it;
   * `null` when the browser is signed out (or already signed in as the key's owner).
   */
  replaces: { displayName: string } | null;
  /** When the hand-off expires unconfirmed. */
  expiresAt: string;
}

/**
 * How the auth service's `completeHandoff` finished a hand-off:
 * - `kept`: the browser was already signed in as the key's owner; that session goes on
 *   (renewed) and the hand-off ended;
 * - `confirm`: anything else (signed out, or signed in as someone else). Nothing changed:
 *   the browser's session, if any, is untouched and the hand-off waits for a same-origin
 *   confirmation (`confirmHandoff`) or cancellation, at most until it expires.
 */
export type HandoffOutcome =
  { kind: 'kept'; signIn: SignIn } | { kind: 'confirm'; confirmation: HandoffConfirmationDTO };

export type InviteStatus = 'pending' | 'used' | 'expired' | 'revoked';

/** An invite as listed to admins. */
export interface InviteDTO {
  id: string;
  role: UserRole;
  /** Who the invite is for (a reminder for admins; never shown to the invitee). */
  note: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  /** Display name of the admin who created it; `null` for the command line. */
  createdBy: string | null;
  usedAt: string | null;
  usedBy: { id: string; displayName: string } | null;
}

/** A new invite and its link (see {@link IssuedLink} for handling the path). */
export interface IssuedInvite extends IssuedLink {
  invite: InviteDTO;
}

/** What an invite link would do, for the invite page. */
export type InviteLinkStatusDTO =
  | { status: 'valid'; role: UserRole; expiresAt: string }
  | { status: 'invalid' | 'expired' | 'used' | 'revoked' };

/** A user as listed to admins. */
export interface UserDTO {
  id: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
  deckCount: number;
  activeKeyCount: number;
}

export type UserOutcome =
  | { ok: true; user: UserDTO }
  | {
      ok: false;
      /**
       * `not-found`: no such user. `self`: admins cannot disable themselves.
       * `last-admin`: the last active admin cannot be disabled. `invalid-name`: see message.
       */
      reason: 'not-found' | 'self' | 'last-admin' | 'invalid-name';
      message: string;
    };

export type AcceptInviteOutcome =
  | { ok: true; signIn: SignIn }
  | { ok: false; reason: 'invalid' | 'expired' | 'used' | 'revoked' | 'invalid-name'; message: string };

export interface ClaimStatusDTO {
  /** True while the installation has no users: `/claim` with the setup code creates the first admin. */
  claimable: boolean;
}

export type ClaimOutcome =
  | {
      ok: true;
      signIn: SignIn;
      /**
       * Whether the admin adopted the `local` workspace with the history of a single-user
       * installation from before accounts (never on a fresh installation).
       */
      adoptedLocalWorkspace: boolean;
    }
  | { ok: false; reason: 'claimed' | 'invalid-code' | 'invalid-name'; message: string };
