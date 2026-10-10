/**
 * The access layer (ADR 0007): the one place that turns who is asking into what data
 * they can reach. Pages, server actions and route handlers obtain deck services only
 * from here; nothing else in request-handling code opens the database for deck data.
 *
 * ## Owner scope (this step)
 *
 * {@link servicesFor} binds the full {@link DeckServices} to the signed-in user's
 * workspace. Every repository query below it is filtered by that workspace, so a deck,
 * version or observation id from another workspace behaves exactly like one that does
 * not exist (`null` / `not-found`, never `forbidden`: ids do not reveal what exists).
 * The user must come from the request's session (`requireUser()` / `getCurrentUser()`
 * in `@/server/auth/current-user`), resolved again on every request and server action;
 * ids from the client are only ever looked up inside this scope.
 *
 * ## Viewer scope (next step: share links)
 *
 * `sharedDeckServices(token)` will live here too. It will resolve a `gmv_` share-link
 * token (hashed lookup in `share_links`, revoked links and untracked decks rejected) to
 * exactly one deck, and return a separate, read-only `SharedDeckServices` interface: no
 * write methods at all (read-only by type, not only at runtime), committed history only
 * (no working state, no refresh), notes only when the link includes them. It will be
 * built on repositories bound to the deck's workspace, plus a check that every deck id
 * equals the link's deck, so the same workspace filtering protects it. Sharing with a
 * specific user can later reuse that scope.
 *
 * Share links are made from a session, like device links and keys, so they should
 * record the bookmarklet key that session descends from (as `login_links.credential_id`
 * and `credentials.created_by_credential_id` do): revoking a stolen key can then list,
 * and offer to revoke, the share links made through it. Confirming anything that acts
 * on the browser's cookies from a page uses a same-origin POST (`isSameOriginRequest`
 * in `src/app/request-origin.ts`), as the bookmarklet hand-off does.
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
import {
  createServices,
  KeyedMutex,
  setupInfo,
  type DeckServices,
  type SetupInfoDTO,
} from '@/server/services';
import { getDeckSourceRegistry } from '@/server/sources';

const globalForAccess = globalThis as unknown as { __gitMoxfieldDeckLocks?: KeyedMutex };

/**
 * Per-deck locks shared by every service instance of the process. They live on
 * `globalThis`, like the database connection and the deck source registry, so they
 * survive dev-server reloads and are shared by every module graph Next.js builds.
 */
function deckLocks(): KeyedMutex {
  return (globalForAccess.__gitMoxfieldDeckLocks ??= new KeyedMutex());
}

/**
 * Deck services for `user` (owner scope): everything they can see and change, and
 * nothing else. Cheap to call; the process-wide state behind it (database connection,
 * deck sources with their block backoff and throttle, per-deck locks) is shared.
 */
export function servicesFor(user: SessionUser): DeckServices {
  return createServices({
    db: getDb(),
    sources: getDeckSourceRegistry(),
    config: getConfig(),
    workspaceId: user.workspaceId,
    logger: createLogger('services'),
    locks: deckLocks(),
  });
}

/**
 * Installation facts for pages that render before anyone is signed in (the
 * bookmarklet's capture page, which may be how the browser signs in). Holds no secrets
 * and no user data.
 */
export function getSetupInfo(): SetupInfoDTO {
  return setupInfo(getConfig(), getDeckSourceRegistry());
}
