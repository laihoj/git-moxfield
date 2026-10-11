/**
 * Test harness for the service layer: an in-memory database, the REAL Moxfield deck
 * source wired to a {@link FakeMoxfieldApi}, a manual clock shared by the services and
 * the Moxfield client (cooldowns, block backoff), and a silent logger that records
 * entries for assertions.
 *
 * `services` work on the `local` workspace, like a pre-account installation. For
 * multi-user tests, {@link ServiceHarness.createUser} adds a user with a workspace of
 * their own and services bound to it, and {@link ServiceHarness.auth} is the auth service
 * on the same database and clock.
 */
import type { LogLevel } from '@/core/logger';
import { createAuthService, type AuthService } from '@/server/auth/service';
import { LOCAL_WORKSPACE_ID, type Db } from '@/server/db/client';
import { parseConfig, type AppConfig } from '@/server/config';
import type { Logger } from '@/server/logger';
import { createRepositories, type Repositories, type UserRecord, type UserRole } from '@/server/repositories';
import {
  createServices,
  KeyedMutex,
  type CommitOutcome,
  type DeckServices,
  type FetchOutcome,
  type VersionRefDTO,
} from '@/server/services';
import { createDeckSourceRegistry, type DeckSourceRegistry } from '@/server/sources';
import type { LibsqlDatabase } from '@/server/db/libsql';
import { ManualClock } from '@tests/support/clock';
import { captureSpec, commitWorkingState } from '@tests/support/flows';
import { openTestDatabaseHandle } from '@tests/support/db';
import { FakeMoxfieldApi, type MoxCardSpec, type MoxDeckSpec } from '@tests/support/moxfield-deck-builder';

export { ManualClock };

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown> | undefined;
}

/** A logger that writes nothing and keeps every entry for assertions. */
export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const log =
    (level: LogEntry['level']) =>
    (message: string, context?: Record<string, unknown>): void => {
      entries.push({ level, message, context });
    };
  return { entries, debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export interface HarnessUser {
  user: UserRecord;
  /** Services bound to the user's workspace (what `servicesFor(user)` returns in the app). */
  services: DeckServices;
}

export interface ServiceHarness {
  /** Services bound to the `local` workspace. */
  services: DeckServices;
  api: FakeMoxfieldApi;
  clock: ManualClock;
  db: Db;
  /** The database's handle (closed when the test finishes; close it earlier to release a file). */
  handle: LibsqlDatabase;
  /** Repositories on the same database, for assertions that bypass the services. */
  repos: Repositories;
  config: AppConfig;
  sources: DeckSourceRegistry;
  logger: ReturnType<typeof recordingLogger>;
  /** Creates another service instance on the same database, sources and locks. */
  sibling(): DeckServices;
  /** Services bound to `workspaceId`, on the same database, sources, clock and locks. */
  servicesForWorkspace(workspaceId: string): DeckServices;
  /**
   * Services on the same database, sources, config, clock and logger, with deck locks of
   * their own: another function instance, as on Netlify, where only the database orders
   * what two instances do to a deck.
   */
  otherInstance(workspaceId?: string): DeckServices;
  /** Creates a user with a workspace of their own (directly, bypassing invites). */
  createUser(displayName: string, role?: UserRole): Promise<HarnessUser>;
  /** The auth service on the same database, config, clock and logger. */
  auth: AuthService;
}

export interface ServiceHarnessOptions {
  /** Extra environment variables for `parseConfig`. */
  env?: Record<string, string | undefined>;
  /** Replaces the registry built from the config (e.g. to wrap a source). */
  sources?: (defaults: DeckSourceRegistry) => DeckSourceRegistry;
  /** The database to use, e.g. a `file:` URL in a temporary directory. Default: a private in-memory one. */
  databaseUrl?: string;
}

/**
 * Services over a fresh in-memory database (or `options.databaseUrl`), closed when the
 * current test finishes (see `openTestDatabase`). Defaults: no request spacing, a 10 s refresh cooldown, auto refresh
 * after 300 s and a one-hour block backoff.
 */
export async function createServiceHarness(options: ServiceHarnessOptions = {}): Promise<ServiceHarness> {
  const api = new FakeMoxfieldApi();
  const clock = new ManualClock();
  const logger = recordingLogger();
  const config = parseConfig({
    MOXFIELD_API_BASE_URL: api.apiBaseUrl,
    MOXFIELD_MIN_REQUEST_INTERVAL_MS: '0',
    REFRESH_COOLDOWN_SECONDS: '10',
    AUTO_REFRESH_AFTER_SECONDS: '300',
    MOXFIELD_BLOCK_BACKOFF_SECONDS: '3600',
    ...options.env,
  });
  const defaults = createDeckSourceRegistry(config, {
    fetchImpl: api.fetch,
    now: clock.epochMs,
    sleep: () => Promise.resolve(),
    logger,
  });
  const sources = options.sources ? options.sources(defaults) : defaults;
  const handle = await openTestDatabaseHandle(
    options.databaseUrl === undefined ? {} : { url: options.databaseUrl },
  );
  const { db } = handle;
  const locks = new KeyedMutex();
  const servicesForWorkspace = (workspaceId: string): DeckServices =>
    createServices({ db, sources, config, workspaceId, now: clock.now, logger, locks });
  const build = (): DeckServices => servicesForWorkspace(LOCAL_WORKSPACE_ID);
  const repos = createRepositories(db, { now: clock.now });
  return {
    services: build(),
    api,
    clock,
    db,
    handle,
    repos,
    config,
    sources,
    logger,
    sibling: build,
    servicesForWorkspace,
    otherInstance: (workspaceId = LOCAL_WORKSPACE_ID) =>
      createServices({ db, sources, config, workspaceId, now: clock.now, logger, locks: new KeyedMutex() }),
    createUser: async (displayName, role = 'member') => {
      const user = await repos.users.create({ displayName, role });
      return { user, services: servicesForWorkspace(user.workspaceId) };
    },
    auth: createAuthService({ db, config, now: clock.now, logger }),
  };
}

export const BLUE_FARM_PUBLIC_ID = 'BlueFarmTestDeck000001';
export const BLUE_FARM_URL = `https://moxfield.com/decks/${BLUE_FARM_PUBLIC_ID}`;

/** Primer of {@link blueFarmSpec}, using Moxfield directives. */
export const BLUE_FARM_PRIMER = [
  '# Blue Farm',
  '',
  "Win with [[Thassa's Oracle]] after [[Underworld Breach]] loops.",
  '',
  '===panel: Mulligans',
  'Keep fast mana and a tutor.',
  '===endpanel',
].join('\n');

/**
 * A small Tymna/Kraum deck on (fake) Moxfield. Card lists can be replaced through
 * `overrides`; the version defaults to 1.
 */
export function blueFarmSpec(overrides: Partial<MoxDeckSpec> = {}): MoxDeckSpec {
  return {
    publicId: BLUE_FARM_PUBLIC_ID,
    name: 'Blue Farm',
    format: 'commander',
    description: 'Tymna/Kraum turbo',
    version: 1,
    hubs: ['cEDH'],
    lastUpdatedAtUtc: '2026-10-01T12:00:00.000Z',
    commanders: ['Tymna the Weaver', "Kraum, Ludevic's Opus"],
    mainboard: [
      'Dress Down',
      'Underworld Breach',
      "Thassa's Oracle",
      'Demonic Tutor',
      'Rhystic Study',
      'Orcish Bowmasters',
      'Force of Will',
      'Mana Vault',
      'Sol Ring',
      'Command Tower',
      '3 Island',
    ],
    considering: ['Mnemonic Betrayal', 'Peer into the Abyss'],
    sideboard: ['Pyroclasm'],
    primer: BLUE_FARM_PRIMER,
    ...overrides,
  };
}

/** Moves a card between two board lists of a spec (returns a new spec). */
export function moveCard(
  spec: MoxDeckSpec,
  name: string,
  from: 'mainboard' | 'considering' | 'sideboard',
  to: 'mainboard' | 'considering' | 'sideboard',
): MoxDeckSpec {
  const source = spec[from] ?? [];
  const entry = source.find((card) => specName(card) === name);
  if (entry === undefined) throw new Error(`${name} is not in ${from}`);
  return {
    ...spec,
    [from]: source.filter((card) => card !== entry),
    [to]: [...(spec[to] ?? []), entry],
  };
}

function specName(card: MoxCardSpec): string {
  return typeof card === 'string' ? card.replace(/^\d+\s+/, '') : card.name;
}

/** Narrows away `null`/`undefined`, failing the test with `what` otherwise. */
export function defined<T>(value: T | null | undefined, what = 'value'): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}

/** Puts `spec` on the fake Moxfield and tracks it; returns the deck id. */
export async function trackDeck(
  harness: ServiceHarness,
  spec: MoxDeckSpec = blueFarmSpec(),
): Promise<string> {
  harness.api.setDeck(spec);
  const outcome = await harness.services.trackDeck(`https://moxfield.com/decks/${spec.publicId}`);
  if (!outcome.ok) throw new Error(`Tracking failed: ${outcome.reason}`);
  return outcome.deckId;
}

/** Publishes `spec` on the fake Moxfield, waits out the refresh cooldown and refreshes. */
export async function publishAndRefresh(
  harness: ServiceHarness,
  deckId: string,
  spec: MoxDeckSpec,
): Promise<FetchOutcome> {
  harness.api.setDeck(spec);
  harness.clock.advance(60);
  return harness.services.refresh(deckId, 'manual');
}

/** Commits the working state exactly as the deck overview presents it for review. */
export async function commitReviewed(
  harness: ServiceHarness,
  deckId: string,
  message: string,
  tags?: string[],
): Promise<CommitOutcome> {
  harness.clock.advance(1);
  return commitWorkingState(harness.services, deckId, { message, ...(tags ? { tags } : {}) });
}

/**
 * Captures `spec` through `services` one second after the harness clock's time, like the
 * bookmarklet does; returns the deck's id.
 */
export async function captureNext(
  harness: Pick<ServiceHarness, 'clock'>,
  services: DeckServices,
  spec: MoxDeckSpec,
): Promise<string> {
  harness.clock.advance(1);
  return captureSpec(services, spec, harness.clock.iso());
}

/** The version of a successful commit; fails the test for any other outcome. */
export function committed(outcome: CommitOutcome): VersionRefDTO {
  if (!outcome.ok) throw new Error(`Commit failed (${outcome.reason}): ${outcome.message}`);
  return outcome.version;
}
