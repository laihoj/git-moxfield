/**
 * The access layer (ADR 0007): the one place that turns who is asking into what data
 * they can reach. Pages, server actions and route handlers obtain deck services only
 * from here; nothing else in request-handling code opens the database for deck data.
 *
 * ## Owner scope
 *
 * {@link servicesFor} binds the full {@link DeckServices} to the signed-in user's
 * workspace. Every repository query below it is filtered by that workspace, so a deck,
 * version or observation id from another workspace behaves exactly like one that does
 * not exist (`null` / `not-found`, never `forbidden`: ids do not reveal what exists).
 * The user must come from the request's session (`requireUser()` / `getCurrentUser()`
 * in `@/server/auth/current-user`), resolved again on every request and server action;
 * ids from the client are only ever looked up inside this scope.
 *
 * {@link shareLinkServicesFor} gives the same user their share links: create, list and
 * revoke read-only links to the workspace's decks. A link is made from a session, like
 * device links and keys, so it records the bookmarklet key that session descends from:
 * revoking a stolen key can then revoke the links made through it too (the auth
 * service's `revokeKey` with `includeShareLinks`, or `revokeKeyShareLinks` later on).
 * Recovering an account revokes all of its links.
 *
 * ## Viewer scope
 *
 * {@link sharedDeckServices} resolves a `gmv_` share link token to exactly one deck and
 * returns a separate, read-only `SharedDeckServices` interface: no write methods at all
 * (read-only by type, not only at runtime), committed history only (no working state, no
 * refresh, no fetch status, and nothing that says where the deck lives on Moxfield: its
 * URL opens the live deck), notes only when the link includes them. It is built on
 * repositories bound to the deck's workspace, confined to the deck: every deck id must be
 * the link's, and commits, snapshots, tags and notes are only reachable through the deck's
 * own versions (`src/server/services/confined-history.ts`). Viewers may be signed out;
 * the token is the authorization, so pages must not ask for a session.
 *
 * The token's format is checked before any database lookup, it is looked up by hash only
 * and never logged; a revoked link, an untracked deck and a disabled owner are
 * indistinguishable from an unknown token (`null`: answer 404). Every service call checks
 * the link again, so revoking it ends access at once. Sharing with a specific user can
 * later reuse this scope.
 *
 * ## Scripts
 *
 * Operator scripts are not requests: they build services for an explicit workspace with
 * `createServices` from `@/server/services` (see `scripts/`).
 */
import 'server-only';

import type { SessionUser } from '@/server/auth/types';
import { getConfig } from '@/server/config';
import { getDb } from '@/server/db/client';
import { createLogger } from '@/server/logger';
import { processSingleton } from '@/server/process-singleton';
import {
  createServices,
  createShareLinkServices,
  KeyedMutex,
  moxfieldOrigins,
  openSharedDeck,
  setupInfo,
  type DeckServices,
  type MoxfieldOriginsDTO,
  type SetupInfoDTO,
  type SharedDeckAccess,
  type ShareLinkServices,
} from '@/server/services';
import type { MoxfieldLimiterDetails } from '@/server/moxfield-limiter';
import { getDeckSourceRegistry, getMoxfieldLimiter } from '@/server/sources';

/**
 * Per-deck locks shared by every service instance of the process. They live on
 * `globalThis`, like the database connection and the deck source registry, so they
 * survive dev-server reloads and are shared by every module graph Next.js builds.
 */
function deckLocks(): KeyedMutex {
  return processSingleton(Symbol.for('git-moxfield.deckLocks'), () => new KeyedMutex());
}

/**
 * Deck services for `user` (owner scope): everything they can see and change, and
 * nothing else. Cheap to call; the process-wide state behind it (database connection,
 * deck sources with their block backoff and throttle, per-deck locks) is shared.
 *
 * Asynchronous because the database is opened on first use: it rejects when the
 * database cannot be opened (see `getDb`).
 */
export async function servicesFor(user: SessionUser): Promise<DeckServices> {
  return createServices({
    db: await getDb(),
    sources: getDeckSourceRegistry(),
    config: getConfig(),
    workspaceId: user.workspaceId,
    logger: createLogger('services'),
    locks: deckLocks(),
  });
}

/**
 * The share links of `user`'s decks (owner scope): create, list, revoke. `user` must be
 * the request's session user; new links record the key that session descends from.
 */
export async function shareLinkServicesFor(user: SessionUser): Promise<ShareLinkServices> {
  return createShareLinkServices({ db: await getDb(), user, logger: createLogger('share-links') });
}

/**
 * The viewer scope of a share link: read-only services of the one deck `token` grants and
 * what the link is, or `null` when it grants nothing (malformed, unknown or revoked token,
 * untracked deck, disabled owner; answer 404 for all of them alike). `token` is the raw
 * path segment: it is validated here, before any lookup. Never log it.
 *
 * Records the view (at most hourly). Viewer pages need no session and should not look
 * for one.
 */
export async function sharedDeckServices(token: unknown): Promise<SharedDeckAccess | null> {
  return openSharedDeck(token, {
    db: await getDb(),
    sources: getDeckSourceRegistry(),
    logger: createLogger('share-links'),
  });
}

/**
 * Where Moxfield is, for pages that render before anyone is signed in (the bookmarklet's
 * capture page, which may be how the browser signs in, and sign-in). Holds no secrets and
 * no user data, and reads no database.
 */
export function getMoxfieldOrigins(): MoxfieldOriginsDTO {
  return moxfieldOrigins(getConfig());
}

/** {@link getMoxfieldOrigins} and whether server fetching works, for the setup page. */
export function getSetupInfo(): Promise<SetupInfoDTO> {
  return setupInfo(getConfig(), getDeckSourceRegistry());
}

/** Server fetching from Moxfield as the Admin page shows it (ADR 0009). */
export interface ServerFetchAdminDTO {
  /** `MOXFIELD_SERVER_FETCH` (or its platform default). */
  mode: 'auto' | 'off';
  userAgentConfigured: boolean;
  userAgentWarning: string | null;
  limiter: MoxfieldLimiterDetails;
}

/** For the Admin page only (the caller checks the role). */
export async function getServerFetchAdminInfo(): Promise<ServerFetchAdminDTO> {
  const config = getConfig();
  return {
    mode: config.MOXFIELD_SERVER_FETCH,
    userAgentConfigured: config.moxfieldUserAgent !== undefined,
    userAgentWarning: config.moxfieldUserAgentWarning,
    limiter: await getMoxfieldLimiter().details(),
  };
}
