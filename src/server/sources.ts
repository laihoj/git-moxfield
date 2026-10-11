/**
 * Deck source registry: maps source ids (`moxfield`) to their {@link DeckSource}.
 *
 * Sources are stateful: the Moxfield source spaces its requests and pauses server
 * fetches after a bot-protection block. The registry must therefore be a process
 * singleton ({@link getDeckSourceRegistry}), so every request handler and the service
 * layer share the same throttle and block backoff.
 */
import 'server-only';

import type { DeckSource } from '@/integrations/deck-source';
import { MoxfieldDeckSource } from '@/integrations/moxfield/moxfield-deck-source';

import { getConfig, type AppConfig } from './config';
import { createLogger, type Logger } from './logger';
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
  /** `fetch` used for server-side requests (tests inject a fake Moxfield). */
  fetchImpl?: typeof fetch;
  /** Logger for the Moxfield adapter. Default: `createLogger('moxfield')`. */
  logger?: Logger;
  /** Clock in epoch milliseconds for throttling and block backoff. Default: `Date.now`. */
  now?: () => number;
  /** Delay function used between retries and for throttling. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Creates a registry with the sources configured in `config`. Today that is the
 * Moxfield source, wired to the configured API base URL, site origin, User-Agent,
 * server-fetch mode, timeout, request spacing and block backoff.
 */
export function createDeckSourceRegistry(
  config: AppConfig,
  options: DeckSourceRegistryOptions = {},
): DeckSourceRegistry {
  const moxfield = new MoxfieldDeckSource({
    apiBaseUrl: config.MOXFIELD_API_BASE_URL,
    siteOrigin: config.moxfieldSiteOrigin,
    userAgent: config.MOXFIELD_USER_AGENT,
    serverFetch: config.MOXFIELD_SERVER_FETCH,
    timeoutMs: config.MOXFIELD_TIMEOUT_MS,
    minRequestIntervalMs: config.MOXFIELD_MIN_REQUEST_INTERVAL_MS,
    blockBackoffSeconds: config.MOXFIELD_BLOCK_BACKOFF_SECONDS,
    fetchImpl: options.fetchImpl,
    now: options.now,
    sleep: options.sleep,
    logger: options.logger ?? createLogger('moxfield'),
  });
  return createStaticDeckSourceRegistry([moxfield]);
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
 * The process-wide registry built from {@link getConfig}. Cached on `globalThis`, so the
 * block backoff and request throttle survive dev-server hot reloads.
 */
export function getDeckSourceRegistry(): DeckSourceRegistry {
  return processSingleton(Symbol.for('git-moxfield.deckSources'), () =>
    createDeckSourceRegistry(getConfig()),
  );
}
