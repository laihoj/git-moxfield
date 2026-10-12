/**
 * The application service layer, built from explicit dependencies:
 *
 * - {@link createServices}: {@link DeckServices} bound to one workspace (owner scope);
 * - {@link createShareLinkServices}: the owner's share links, bound to a signed-in user;
 * - {@link openSharedDeck}: the viewer scope of a share link token.
 *
 * Request-handling code (pages, server actions, route handlers) never calls these: it
 * gets services from `@/server/access` (`servicesFor(user)`, `shareLinkServicesFor(user)`,
 * `sharedDeckServices(token)`), the one place that turns who is asking into data access.
 * Tests and operator scripts call them directly.
 */
import 'server-only';

import type { AppConfig } from '@/server/config';
import type { Db } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import { createRepositories } from '@/server/repositories';
import type { DeckSourceRegistry } from '@/server/sources';

import type { DeckServices } from './contract';
import { createDeckServices } from './deck-services';
import { KeyedMutex } from './mutex';

export type * from './contract';
export type * from './types';
export { FREE_TEXT_NOTE_KIND, RECENT_VERSION_COUNT } from './deck-services';
export { MAX_CARD_SEARCH_LIMIT } from './history';
export { ServiceError, isServiceError, type ServiceErrorCode } from './errors';
export { KeyedMutex } from './mutex';
export { setupInfo } from './setup-info';
export { createShareLinkServices, type ShareLinkServicesDependencies } from './share-links';
export {
  openSharedDeck,
  SHARE_VIEW_RECORDING_INTERVAL_MS,
  type SharedDeckDependencies,
} from './shared-deck-access';
export { DeckConfinementError } from './confined-history';

export interface ServiceDependencies {
  db: Db;
  sources: DeckSourceRegistry;
  config: AppConfig;
  /**
   * The workspace the services are bound to: decks are listed from, tracked in and
   * looked up in this workspace only. Required, so that no code path silently works on
   * another user's (or the `local`) workspace.
   */
  workspaceId: string;
  /** Clock for every timestamp the services and repositories record. Default: system time. */
  now?: () => Date;
  /** Default: `createLogger('services')`. */
  logger?: Logger;
  /**
   * Per-deck locks serializing refresh, capture, commit and untrack. Every service
   * instance working on the same database in one process must share one instance.
   * Default: a new, private instance.
   */
  locks?: KeyedMutex;
}

/** Builds the service layer for one workspace from explicit dependencies. */
export function createServices(deps: ServiceDependencies): DeckServices {
  const now = deps.now ?? (() => new Date());
  return createDeckServices({
    repos: createRepositories(deps.db, { now, workspaceId: deps.workspaceId }),
    sources: deps.sources,
    config: deps.config,
    now,
    logger: deps.logger ?? createLogger('services'),
    locks: deps.locks ?? new KeyedMutex(),
  });
}
