/**
 * The query plans of a deck's pages and of capturing and committing it: Turso bills every
 * row a query reads, so no statement of these per-deck operations may read every deck of
 * the workspace (the remote suite, `tests/remote/costs.test.ts`, measures the rows).
 *
 * Every statement the services run is recorded through Drizzle's logger and explained
 * with its parameters.
 */
import type { InValue } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql/http';
import { describe, expect, it } from 'vitest';

import type { LibsqlDb } from '@/server/db/libsql';
import * as schema from '@/server/db/schema';
import { createRepositories } from '@/server/repositories';
import { KeyedMutex, type DeckServices } from '@/server/services';
import { createDeckServices } from '@/server/services/deck-services';
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

interface Statement {
  sql: string;
  params: unknown[];
}

/** Services whose every statement is appended to `statements`. */
function recordingServices(harness: ServiceHarness, statements: Statement[]): DeckServices {
  const db: LibsqlDb = drizzle({
    client: harness.handle.client,
    schema,
    logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
  });
  return createDeckServices({
    repos: createRepositories(db, { now: harness.clock.now }),
    sources: harness.sources,
    config: harness.config,
    now: harness.clock.now,
    logger: harness.logger,
    locks: new KeyedMutex(),
  });
}

/** The plan lines of the statements that read (inserts are planned trivially). */
async function plans(
  harness: ServiceHarness,
  statements: readonly Statement[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const { sql, params } of statements) {
    if (!/^\s*(select|update|delete|with)\b/i.test(sql)) continue;
    const plan = await harness.handle.client.execute({
      sql: `EXPLAIN QUERY PLAN ${sql}`,
      args: params as InValue[],
    });
    result.set(
      sql,
      plan.rows.map((row) => (typeof row.detail === 'string' ? row.detail : '')),
    );
  }
  return result;
}

/** A scan of the workspace's decks through the `(workspace_id, …)` index. */
const WORKSPACE_DECK_SCAN = /USING (COVERING )?INDEX decks_workspace_source_external_uq \(workspace_id=\?\)$/;

describe('query plans of a deck', () => {
  it('never read every deck of the workspace, on its pages, when capturing or committing', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services } = harness;
    // Other decks in the workspace, and a deck with two versions, a tag, a note and a review.
    for (const n of [1, 2, 3])
      await captureNext(harness, services, blueFarmSpec({ publicId: `OtherDeck0000000000000${n}` }));
    await captureNext(harness, services, blueFarmSpec());
    const deckId = defined(
      (await services.listDecks()).find((deck) => deck.externalId === blueFarmSpec().publicId),
    ).id;
    committed(await commitReviewed(harness, deckId, 'Initial version', ['stable']));
    await services.setNote(deckId, 1, 'Top 4');
    const moved = moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering');
    await captureNext(harness, services, moved);

    const statements: Statement[] = [];
    const recorded = recordingServices(harness, statements);
    const overview = defined(await recorded.getOverview(deckId));
    await recorded.getVersion(deckId, 1);
    await recorded.listVersions(deckId);
    await recorded.listVersions(deckId, { tag: 'stable' });
    await recorded.compare(deckId, '1', 'working');
    await recorded.cardHistory(deckId, 'Dress Down');
    await recorded.searchCards(deckId, 'dress');
    await recorded.restoreExport(deckId, 1);
    await recorded.listTags(deckId);
    await captureNext(harness, recorded, moved);
    await captureNext(harness, recorded, blueFarmSpec({ version: 3, sideboard: [] }));
    harness.clock.advance(1);
    const latest = defined(defined(await recorded.getOverview(deckId)).working);
    committed(
      await recorded.commit(deckId, {
        message: 'Sideboard cleared',
        expectedObservationId: latest.id,
        expectedHeadCommitId: defined(overview.head).commitId,
        tags: ['testing'],
      }),
    );

    const explained = await plans(harness, statements);
    expect(explained.size).toBeGreaterThan(30);
    const scans = [...explained].filter(([, plan]) => plan.some((line) => WORKSPACE_DECK_SCAN.test(line)));
    expect(scans.map(([sql]) => sql)).toEqual([]);
  });
});
