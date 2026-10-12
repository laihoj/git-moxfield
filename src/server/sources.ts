/**
 * Deck source registry: maps source ids (`moxfield`) to their {@link DeckSource}.
 *
 * The Moxfield source admits every request through the installation-wide request limiter
 * on the database (ADR 0009), which every process and function instance shares. The
 * registry is still a process singleton ({@link getDeckSourceRegistry}), so that it is
 * built (and warns about its configuration) once per process.
 */
import 'server-only';

import type { DeckSource } from '@/integrations/deck-source';
import { MoxfieldDeckSource } from '@/integrations/moxfield/moxfield-deck-source';
import type { MoxfieldRequestLimiter } from '@/integrations/moxfield/request-limiter';

import { getConfig, type AppConfig } from './config';
import { getDb } from './db/client';
import { createLogger, type Logger } from './logger';
import { DatabaseMoxfieldLimiter } from './moxfield-limiter';
import { processSingleton } from './process-singleton';

export interface DeckSourceRegistry {
  /** The source with this id, or `undefined` when none is registered. */
  get(id: string): DeckSource | undefined;
  /**
   * The source with this id.
   * @throws {Error} when no such source is registered (a configuration or data bug).
   */
  require(id: string): DeckSource;
  /** Every registered source, in registration order. */
  all(): DeckSource[];
}

export interface DeckSourceRegistryOptions {
  /** Admits every request to Moxfield: the installation-wide limiter (ADR 0009). */
  moxfieldLimiter: MoxfieldRequestLimiter;
  /** `fetch` used for server-side requests (tests inject a fake Moxfield). */
  fetchImpl?: typeof fetch;
  /** Logger for the Moxfield adapter. Default: `createLogger('moxfield')`. */
  logger?: Logger;
  /** Clock in epoch milliseconds, for HTTP-date `Retry-After` values. Default: `Date.now`. */
  now?: () => number;
  /** Delay before a retry. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Creates a registry with the sources configured in `config`. Today that is the
 * Moxfield source, wired to the configured API base URL, site origin, User-Agent,
 * server-fetch mode and timeout, and to `options.moxfieldLimiter`.
 */
export function createDeckSourceRegistry(
  config: AppConfig,
  options: DeckSourceRegistryOptions,
): DeckSourceRegistry {
  const moxfield = new MoxfieldDeckSource({
    apiBaseUrl: config.MOXFIELD_API_BASE_URL,
    siteOrigin: config.moxfieldSiteOrigin,
    userAgent: config.moxfieldUserAgent?.value,
    serverFetch: config.MOXFIELD_SERVER_FETCH,
    timeoutMs: config.MOXFIELD_TIMEOUT_MS,
    limiter: options.moxfieldLimiter,
    fetchImpl: options.fetchImpl,
    now: options.now,
    sleep: options.sleep,
    logger: options.logger ?? createLogger('moxfield'),
  });
  return createStaticDeckSourceRegistry([moxfield]);
}

/**
 * The process-wide Moxfield request limiter on the app's database, configured by
 * {@link getConfig}. Every instance on the same database shares its limit.
 */
export function getMoxfieldLimiter(): DatabaseMoxfieldLimiter {
  return processSingleton(Symbol.for('git-moxfield.moxfieldLimiter'), () => {
    const config = getConfig();
    return new DatabaseMoxfieldLimiter({
      db: getDb,
      intervalMs: config.MOXFIELD_MIN_REQUEST_INTERVAL_MS,
      logger: createLogger('moxfield'),
    });
  });
}

/**
 * A registry over a fixed list of sources (tests use it to wrap or replace sources).
 * @throws {Error} when two sources share an id.
 */
export function createStaticDeckSourceRegistry(sources: readonly DeckSource[]): DeckSourceRegistry {
  const byId = new Map<string, DeckSource>();
  for (const source of sources) {
    if (byId.has(source.id)) throw new Error(`Deck source ${source.id} is registered twice`);
    byId.set(source.id, source);
  }
  const list = [...byId.values()];
  return {
    get: (id) => byId.get(id),
    require(id) {
      const source = byId.get(id);
      if (source === undefined) throw new Error(`Unknown deck source ${JSON.stringify(id)}`);
      return source;
    },
    all: () => [...list],
  };
}

/**
 * The process-wide registry built from {@link getConfig}, on {@link getMoxfieldLimiter}.
 * Cached on `globalThis`, so it is built once per process, also across dev-server reloads.
 * Building it warns (loudly, as an error) when the Moxfield-issued User-Agent is configured
 * outside the Netlify production deployment.
 */
export function getDeckSourceRegistry(): DeckSourceRegistry {
  return processSingleton(Symbol.for('git-moxfield.deckSources'), () => {
    const config = getConfig();
    if (config.moxfieldUserAgentWarning !== null) {
      createLogger('moxfield').error(config.moxfieldUserAgentWarning);
    }
    return createDeckSourceRegistry(config, { moxfieldLimiter: getMoxfieldLimiter() });
  });
}
