/**
 * Entry point of the application service layer for the UI (server components, server
 * actions, route handlers): {@link getServices} returns the process-wide
 * {@link DeckServices}; {@link createServices} builds one from explicit dependencies
 * (tests, scripts).
 */
import 'server-only';

import { getConfig, type AppConfig } from '@/server/config';
import { getDb, type Db } from '@/server/db/client';
import { createLogger, type Logger } from '@/server/logger';
import { createRepositories } from '@/server/repositories';
import { getDeckSourceRegistry, type DeckSourceRegistry } from '@/server/sources';

import type { DeckServices } from './contract';
import { createDeckServices } from './deck-services';
import { KeyedMutex } from './mutex';

export type * from './contract';
export type * from './types';
export {
  CAPTURE_TOKEN_SETTING,
  FREE_TEXT_NOTE_KIND,
  MAX_CARD_SEARCH_LIMIT,
  MAX_COMMIT_MESSAGE_LENGTH,
  MAX_NOTE_LENGTH,
  RECENT_VERSION_COUNT,
} from './deck-services';
export { ServiceError, isServiceError, type ServiceErrorCode } from './errors';
export { KeyedMutex } from './mutex';

export interface ServiceDependencies {
  db: Db;
  sources: DeckSourceRegistry;
  config: AppConfig;
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

/** Builds the service layer from explicit dependencies. */
export function createServices(deps: ServiceDependencies): DeckServices {
  const now = deps.now ?? (() => new Date());
  return createDeckServices({
    repos: createRepositories(deps.db, { now }),
    sources: deps.sources,
    config: deps.config,
    now,
    logger: deps.logger ?? createLogger('services'),
    locks: deps.locks ?? new KeyedMutex(),
  });
}

const globalForServices = globalThis as unknown as { __gitMoxfieldDeckLocks?: KeyedMutex };

let services: DeckServices | undefined;

/**
 * The process-wide services over the configured database and deck sources.
 *
 * All state lives in process singletons on `globalThis` (database connection, deck
 * source registry with its block backoff and throttle, per-deck locks), so it survives
 * dev-server hot reloads and is shared by every module graph Next.js builds (server
 * components, route handlers). The thin service object itself is rebuilt when this
 * module is re-evaluated, so code changes take effect without a restart.
 */
export function getServices(): DeckServices {
  services ??= createServices({
    db: getDb(),
    sources: getDeckSourceRegistry(),
    config: getConfig(),
    locks: (globalForServices.__gitMoxfieldDeckLocks ??= new KeyedMutex()),
  });
  return services;
}
