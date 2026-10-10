/**
 * The application service layer. {@link createServices} builds {@link DeckServices} bound
 * to one workspace from explicit dependencies.
 *
 * Request-handling code (pages, server actions, route handlers) never calls it: it gets
 * services bound to the signed-in user's workspace from `servicesFor(user)` in
 * `@/server/access`, the one place that turns a request's identity into data access.
 * Tests and operator scripts call it directly.
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
export {
  FREE_TEXT_NOTE_KIND,
  MAX_CARD_SEARCH_LIMIT,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_NOTE_LENGTH,
  RECENT_VERSION_COUNT,
} from './deck-services';
export { ServiceError, isServiceError, type ServiceErrorCode } from './errors';
export { KeyedMutex } from './mutex';
export { setupInfo } from './setup-info';

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
