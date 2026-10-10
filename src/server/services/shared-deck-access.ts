/**
 * Resolving a share link (ADR 0007's viewer scope): from the token in a `/s/<token>/…`
 * URL to the read-only services of the one deck it grants. `sharedDeckServices(token)` in
 * `@/server/access` calls {@link openSharedDeck} with the process-wide dependencies; tests
 * call it directly.
 *
 * The token is untrusted input and a bearer secret:
 * - its format is checked before any database lookup, so malformed input never reaches SQL;
 * - it is looked up by its SHA-256 hash only, and never logged, stored or returned;
 * - every way a link stops working (unknown, revoked, deck untracked, owner disabled) gives
 *   the same `null`, so a revoked link reveals nothing a mistyped one does not.
 */
import 'server-only';

import { hashToken, parseToken } from '@/server/auth/tokens';
import type { Db } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import { createRepositories, type ShareLinkRepository } from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import type { SharedDeckAccess } from './contract';
import { settle } from './settle';
import { createSharedDeckServices } from './shared-deck-services';

/** A link's last view is recorded at most this often (it is a database write on a read path). */
export const SHARE_VIEW_RECORDING_INTERVAL_MS = 60 * 60 * 1000;

export interface SharedDeckDependencies {
  db: Db;
  sources: DeckSourceRegistry;
  /** Clock for recording views. Default: system time. */
  now?: () => Date;
  /** Default: `createLogger('share-links')`. */
  logger?: Logger;
}

/**
 * The viewer services of the deck a share link grants, and what the link is; `null` when
 * the token grants nothing (see the module comment). Records the view (at most hourly,
 * best effort: a failure to record is logged and never blocks viewing).
 */
export function openSharedDeck(
  token: unknown,
  deps: SharedDeckDependencies,
): Promise<SharedDeckAccess | null> {
  return settle(() => {
    const parsed = parseToken('share', token);
    if (parsed === null) return null;
    const now = deps.now ?? (() => new Date());
    const accounts = createRepositories(deps.db, { now });
    const found = accounts.shareLinks.findActive(hashToken(parsed));
    if (found === null) return null;
    const { link, workspaceId, ownerDisplayName } = found;
    recordView(deps, accounts.shareLinks, link.id, now());

    const services = createSharedDeckServices({
      repos: createRepositories(deps.db, { now, workspaceId }),
      sources: deps.sources,
      deckId: link.deckId,
      includeNotes: link.includeNotes,
      isActive: () => accounts.shareLinks.isActive(link.id),
    });
    return {
      services,
      share: { label: link.label, includeNotes: link.includeNotes, ownerDisplayName, deckId: link.deckId },
    };
  });
}

function recordView(
  deps: SharedDeckDependencies,
  shareLinks: ShareLinkRepository,
  linkId: string,
  at: Date,
): void {
  const since = new Date(at.getTime() - SHARE_VIEW_RECORDING_INTERVAL_MS).toISOString();
  try {
    shareLinks.touchViewed(linkId, at.toISOString(), since);
  } catch (error) {
    (deps.logger ?? createLogger('share-links')).warn('Could not record a share link view', {
      linkId,
      error,
    });
  }
}
