/**
 * Card catalog: display facts per card key (type line, mana cost, ...), scoped to the
 * context's workspace like the decks they describe. The facts come from captured or
 * pasted Moxfield JSON, which is untrusted, so a capture only ever writes, and a page
 * only ever reads, the facts of its own workspace. Reference data that is not versioned;
 * within a workspace the latest write wins.
 *
 * Every capture upserts the facts of every card of the deck, but card facts rarely change,
 * so the upsert only rewrites a row whose facts differ: Turso bills every row written, and
 * rewriting them all made the catalog most of a capture's writes (a deck of 103 distinct
 * cards: 103 of 111 rows when the deck had not changed). `updated_at` is when the facts last
 * changed.
 */
import { getTableColumns, or, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { CardFacts, CardKey } from '@/core/model';
import { cardCatalog } from '@/server/db/schema';

import { decodeStringArray, encodeJson } from './codec';
import {
  batches,
  excluded,
  selectInBatches,
  valuesTable,
  writeAll,
  type LibsqlExecutor,
  type RepositoryContext,
  type WriteSet,
} from './context';

export interface CatalogRepository {
  /**
   * Inserts or replaces the workspace's facts atomically (one batch). When the input
   * contains the same key more than once, the last entry wins. Rows whose facts are
   * unchanged are not written (their `updated_at` stays).
   */
  upsertMany(facts: readonly CardFacts[]): Promise<void>;
  /** The workspace's facts for the given keys; unknown keys are absent from the result. */
  getMany(keys: Iterable<CardKey>): Promise<Map<CardKey, CardFacts>>;
}

export function createCatalogRepository(ctx: RepositoryContext): CatalogRepository {
  return {
    async upsertMany(facts) {
      if (facts.length === 0) return;
      const latest = new Map<CardKey, CardFacts>();
      for (const fact of facts) latest.set(fact.key, fact);
      const updatedAt = ctx.now();
      const rows = [...latest.values()].map((fact) => ({
        workspaceId: ctx.workspaceId,
        key: fact.key,
        name: fact.name,
        typeLine: fact.typeLine,
        primaryType: fact.primaryType,
        manaCost: fact.manaCost,
        cmc: fact.cmc,
        colorIdentityJson: encodeJson(fact.colorIdentity, `Color identity of ${fact.key}`),
        layout: fact.layout,
        scryfallId: fact.scryfallId ?? null,
        updatedAt,
      }));
      await writeAll(ctx, (db) =>
        catalogUpserts(
          db,
          rows,
          // Only rows whose facts changed (`IS NOT`: NULL-safe, for `scryfall_id`).
          or(...FACT_COLUMNS.map(([, column]) => sql`${column} IS NOT ${excluded(column)}`)),
        ),
      );
    },

    async getMany(keys) {
      const result = new Map<CardKey, CardFacts>();
      // One row read per card (a version page asks for every card of the deck).
      const rows = await selectInBatches(keys, (batch) =>
        ctx.db.all<CatalogRow>(catalogLookupQuery(ctx.workspaceId, batch)),
      );
      for (const row of rows) {
        const facts: CardFacts = {
          key: row.key,
          name: row.name,
          typeLine: row.typeLine,
          primaryType: row.primaryType,
          manaCost: row.manaCost,
          cmc: row.cmc,
          colorIdentity: decodeStringArray(row.colorIdentityJson, `Color identity of ${row.key}`),
          layout: row.layout,
        };
        if (row.scryfallId !== null) facts.scryfallId = row.scryfallId;
        result.set(row.key, facts);
      }
      return result;
    },
  };
}

/** A `card_catalog` row as {@link catalogLookupQuery} reads it. */
interface CatalogRow {
  key: string;
  name: string;
  typeLine: string;
  primaryType: string;
  manaCost: string;
  cmc: number;
  colorIdentityJson: string;
  layout: string;
  scryfallId: string | null;
}

/**
 * The workspace's facts for `keys` (distinct, at most `BATCH_SIZE`), one primary-key probe
 * per key (see `valuesTable`).
 *
 * @internal exported for the query-plan tests.
 */
export function catalogLookupQuery(workspaceId: string, keys: readonly string[]): SQL {
  return sql`
    SELECT c.key AS "key", c.name AS "name", c.type_line AS "typeLine",
      c.primary_type AS "primaryType", c.mana_cost AS "manaCost", c.cmc AS "cmc",
      c.color_identity_json AS "colorIdentityJson", c.layout AS "layout",
      c.scryfall_id AS "scryfallId"
    FROM ${valuesTable(keys)} AS wanted
    CROSS JOIN card_catalog AS c
    WHERE c.workspace_id = ${workspaceId} AND c.key = wanted.column1`;
}

/**
 * Upserts `rows` into the catalog in batches, as a write set for `writeAll`: a new key is
 * inserted, an existing one takes every fact column and `updated_at` of the row, provided
 * `setWhere` holds (over `card_catalog` and `excluded`, see {@link excluded}). The facts are
 * the table's columns but the workspace, the key and `updated_at`, so a column added to the
 * table is carried along. `rows` must not be empty.
 */
export function catalogUpserts(
  db: LibsqlExecutor,
  rows: readonly (typeof cardCatalog.$inferInsert)[],
  setWhere: SQL | undefined,
): WriteSet {
  const [first = [], ...rest] = batches(rows);
  const upsert = (batch: typeof first) =>
    db
      .insert(cardCatalog)
      .values(batch)
      .onConflictDoUpdate({
        target: [cardCatalog.workspaceId, cardCatalog.key],
        set: {
          ...Object.fromEntries(FACT_COLUMNS.map(([field, column]) => [field, excluded(column)])),
          updatedAt: excluded(cardCatalog.updatedAt),
        },
        setWhere,
      });
  return [upsert(first), ...rest.map(upsert)] as const;
}

/** The columns holding a card's facts: every column but the workspace, the key and `updated_at`. */
const FACT_COLUMNS: readonly (readonly [string, SQLiteColumn])[] = Object.entries(
  getTableColumns(cardCatalog),
).filter(([field]) => field !== 'workspaceId' && field !== 'key' && field !== 'updatedAt');
