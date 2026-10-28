/**
 * Reads that race with another function instance's writes.
 *
 * On Netlify every function instance has its own deck locks, and remotely every statement
 * outside a transaction sees whatever is committed when it runs. An ingest prunes the
 * deck's observations to the newest two, with the snapshots only they referenced, so two
 * captures by another instance can remove the working state a request has just read. No
 * read may then fail ("Snapshot … is missing", a 500): it answers with the state it read,
 * a newer one, or (a commit) `stale`. Likewise, a deck untracked while a request reads it
 * reads as a deck that does not exist, never as a 500, for its owner and for viewers of a
 * share link.
 *
 * Each test runs an operation once for every point between two of its repository calls
 * at which the other instance acts (`interleavedRepositories`), on a fresh database each
 * time, until the operation makes fewer calls than that point.
 */
import { describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '@/server/repositories';
import {
  KeyedMutex,
  type CommitOutcome,
  type DeckServices,
  type SharedDeckServices,
} from '@/server/services';
import { createDeckServices } from '@/server/services/deck-services';
import { createSharedDeckServices } from '@/server/services/shared-deck-services';
import { interleavedRepositories } from '@tests/support/interleaving';
import type { MoxDeckSpec } from '@tests/support/moxfield-deck-builder';
import {
  blueFarmSpec,
  captureNext,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  type ServiceHarness,
} from '@tests/support/services';

/** The committed state, the reviewed working state, and the other instance's two captures. */
const STATES = {
  committed: blueFarmSpec(),
  reviewed: moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'),
  later: blueFarmSpec({ version: 3, sideboard: ['Pyroclasm', 'Fire Covenant'] }),
  latest: blueFarmSpec({ version: 4, sideboard: [] }),
} satisfies Record<string, MoxDeckSpec>;

interface Scenario {
  harness: ServiceHarness;
  deckId: string;
  /** Version 1 (the committed state). */
  headCommitId: string;
  /** The observation the user reviewed (the working state before the other instance acts). */
  reviewedObservationId: string;
  /** Another function instance: same database, its own deck locks. */
  other: DeckServices;
}

/**
 * A deck with version 1 and an uncommitted working state that only one observation
 * references. With `serverFetch`, Moxfield serves the reviewed state (fetch on commit).
 */
async function scenario(serverFetch: boolean): Promise<Scenario> {
  const harness = await createServiceHarness({
    env: { MOXFIELD_SERVER_FETCH: serverFetch ? 'auto' : 'off' },
  });
  const { services, api } = harness;
  const deckId = await captureNext(harness, services, STATES.committed);
  const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));
  await captureNext(harness, services, STATES.reviewed);
  api.setDeck(STATES.reviewed);
  const reviewed = defined(defined(await services.getOverview(deckId)).working);
  return {
    harness,
    deckId,
    headCommitId: v1.commitId,
    reviewedObservationId: reviewed.id,
    other: harness.otherInstance(),
  };
}

interface Failure {
  /** After which repository call the other instance captured. */
  at: number;
  error: string;
}

/**
 * Runs `operation` on a fresh scenario once per interleaving point (the other instance
 * captures twice after the `at`-th repository call) and returns the failures. `check`
 * validates each result.
 */
async function everyInterleaving<T>(
  options: {
    serverFetch?: boolean;
    /** What the other instance does (default: capture the deck twice). */
    interfere?: (scene: Scenario) => Promise<void>;
  },
  operation: (reader: DeckServices, scene: Scenario) => Promise<T>,
  check: (result: T, scene: Scenario) => void | Promise<void> = () => undefined,
): Promise<{ points: number; failures: Failure[] }> {
  return everyPoint(options, (repos, scene) =>
    operation(
      createDeckServices({
        repos,
        sources: scene.harness.sources,
        config: scene.harness.config,
        now: scene.harness.clock.now,
        view: 'mtg',
        logger: scene.harness.logger,
        locks: new KeyedMutex(),
      }),
      scene,
    ).then(async (result) => {
      await check(result, scene);
    }),
  );
}

/** {@link everyInterleaving} for any reader built on the interleaved repositories. */
async function everyPoint(
  options: { serverFetch?: boolean; interfere?: (scene: Scenario) => Promise<void> },
  run: (repos: Repositories, scene: Scenario) => Promise<void>,
): Promise<{ points: number; failures: Failure[] }> {
  const failures: Failure[] = [];
  const interfere =
    options.interfere ??
    (async ({ harness, other }: Scenario) => {
      await captureNext(harness, other, STATES.later);
      await captureNext(harness, other, STATES.latest);
    });
  for (let at = 1; ; at++) {
    const scene = await scenario(options.serverFetch ?? false);
    const repos = createRepositories(scene.harness.db, { now: scene.harness.clock.now });
    const interleaved = interleavedRepositories(repos, at, () => interfere(scene));
    try {
      await run(interleaved.repos, scene);
    } catch (error) {
      failures.push({ at, error: error instanceof Error ? error.message : String(error) });
    }
    if (!interleaved.interfered()) return { points: at - 1, failures };
  }
}

/** The other instance untracks the deck (its owner, in another tab). */
const untrack = async ({ other, deckId }: Scenario): Promise<void> => {
  await other.untrackDeck(deckId);
};

describe('reads racing with another instance that captures the deck twice', () => {
  it('the deck page answers with a working state, never a missing snapshot', async () => {
    const { points, failures } = await everyInterleaving(
      {},
      (reader, { deckId }) => reader.getOverview(deckId),
      (overview) => {
        const working = defined(defined(overview).working);
        expect(defined(overview).diff).not.toBeNull();
        expect(working.id).toEqual(expect.any(String));
      },
    );
    expect(points).toBeGreaterThan(1);
    expect(failures).toEqual([]);
  });

  it('the deck list, the version page, compare, card history, search and restore never fail', async () => {
    const operations: Record<string, (reader: DeckServices, scene: Scenario) => Promise<unknown>> = {
      listDecks: async (reader) => {
        expect(await reader.listDecks()).toHaveLength(1);
      },
      getVersion: async (reader, { deckId }) => defined(await reader.getVersion(deckId, 1)),
      compare: async (reader, { deckId }) => defined(await reader.compare(deckId, 'head', 'working')),
      cardHistory: async (reader, { deckId }) => defined(await reader.cardHistory(deckId, 'Dress Down')),
      searchCards: async (reader, { deckId }) => {
        expect(await reader.searchCards(deckId, 'dress')).toHaveLength(1);
      },
      restoreExport: async (reader, { deckId }) => defined(await reader.restoreExport(deckId, 1)),
    };
    const failures: Record<string, Failure[]> = {};
    for (const [name, operation] of Object.entries(operations)) {
      const result = await everyInterleaving({}, operation);
      expect(result.points, name).toBeGreaterThan(1);
      if (result.failures.length > 0) failures[name] = result.failures;
    }
    expect(failures).toEqual({});
  });

  it.each([
    ['browser captures only', false],
    ['fetch on commit', true],
  ])('a commit (%s) either records the reviewed state or answers stale', async (_, serverFetch) => {
    const { points, failures } = await everyInterleaving(
      { serverFetch },
      (reader, scene) =>
        reader.commit(scene.deckId, {
          message: 'Moved Dress Down',
          expectedObservationId: scene.reviewedObservationId,
          expectedHeadCommitId: scene.headCommitId,
        }),
      async (outcome: CommitOutcome, { harness, deckId }) => {
        const versions = await harness.services.listVersions(deckId);
        if (outcome.ok) {
          expect(versions).toHaveLength(2);
          const v2 = defined(await harness.services.getVersion(deckId, 2));
          expect(v2.diff.changes).toEqual([
            expect.objectContaining({
              key: 'dress down',
              type: 'moved',
              from: 'mainboard',
              to: 'considering',
            }),
          ]);
        } else {
          expect(outcome.reason).toBe('stale');
          expect(versions).toHaveLength(1);
        }
      },
    );
    expect(points).toBeGreaterThan(1);
    expect(failures).toEqual([]);
  });
});

describe('reads racing with the deck being untracked', () => {
  it('read as a deck that does not exist for its owner, never fail', async () => {
    const operations: Record<string, (reader: DeckServices, scene: Scenario) => Promise<unknown>> = {
      getOverview: (reader, { deckId }) => reader.getOverview(deckId),
      listDecks: (reader) => reader.listDecks(),
      getVersion: (reader, { deckId }) => reader.getVersion(deckId, 1),
      compare: (reader, { deckId }) => reader.compare(deckId, '1', 'working'),
      cardHistory: (reader, { deckId }) => reader.cardHistory(deckId, 'Dress Down'),
      searchCards: (reader, { deckId }) => reader.searchCards(deckId, 'dress'),
      restoreExport: (reader, { deckId }) => reader.restoreExport(deckId, 1),
      listVersions: (reader, { deckId }) => reader.listVersions(deckId),
    };
    const failures: Record<string, Failure[]> = {};
    for (const [name, operation] of Object.entries(operations)) {
      const result = await everyInterleaving({ interfere: untrack }, operation);
      expect(result.points, name).toBeGreaterThan(1);
      if (result.failures.length > 0) failures[name] = result.failures;
    }
    expect(failures).toEqual({});
  });

  it('read as a link that grants nothing for viewers of a share link, never fail', async () => {
    const operations: Record<string, (viewer: SharedDeckServices) => Promise<unknown>> = {
      getOverview: (viewer) => viewer.getOverview(),
      getVersion: (viewer) => viewer.getVersion(1),
      compare: (viewer) => viewer.compare('empty', '1'),
      cardHistory: (viewer) => viewer.cardHistory('Pyroclasm'),
      searchCards: (viewer) => viewer.searchCards('pyro'),
      restoreExport: (viewer) => viewer.restoreExport(1),
      listVersions: (viewer) => viewer.listVersions(),
    };
    const failures: Record<string, Failure[]> = {};
    for (const [name, operation] of Object.entries(operations)) {
      const result = await everyPoint({ interfere: untrack }, async (repos, { harness, deckId }) => {
        const viewer = createSharedDeckServices({
          repos,
          sources: harness.sources,
          deckId,
          includeNotes: true,
          view: 'mtg',
          // Untracking a deck ends its share links.
          isActive: async () => (await harness.repos.decks.getById(deckId)) !== null,
        });
        await operation(viewer);
      });
      expect(result.points, name).toBeGreaterThan(1);
      if (result.failures.length > 0) failures[name] = result.failures;
    }
    expect(failures).toEqual({});
  });
});
