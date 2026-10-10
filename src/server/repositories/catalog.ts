/**
 * Card catalog: display facts per card key (type line, mana cost, ...), scoped to the
 * context's workspace like the decks they describe. The facts come from captured or
 * pasted Moxfield JSON, which is untrusted, so a capture only ever writes, and a page
 * only ever reads, the facts of its own workspace. Reference data that is not versioned;
 * within a workspace the latest write wins.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { CardFacts, CardKey } from '@/core/model';
import { cardCatalog } from '@/server/db/schema';

import { decodeStringArray, encodeJson } from './codec';
import { batches, distinct, writeAll, type RepositoryContext } from './context';

export interface CatalogRepository {
  /**
   * Inserts or replaces the workspace's facts atomically (one batch). When the input
   * contains the same key more than once, the last entry wins.
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
      const [first = [], ...rest] = batches(rows);
      await writeAll(ctx, (db) => {
        const upsert = (batch: typeof rows) =>
          db
            .insert(cardCatalog)
            .values(batch)
            .onConflictDoUpdate({
              target: [cardCatalog.workspaceId, cardCatalog.key],
              set: {
                name: excluded(cardCatalog.name),
                typeLine: excluded(cardCatalog.typeLine),
                primaryType: excluded(cardCatalog.primaryType),
                manaCost: excluded(cardCatalog.manaCost),
                cmc: excluded(cardCatalog.cmc),
                colorIdentityJson: excluded(cardCatalog.colorIdentityJson),
                layout: excluded(cardCatalog.layout),
                scryfallId: excluded(cardCatalog.scryfallId),
                updatedAt: excluded(cardCatalog.updatedAt),
              },
            });
        return [upsert(first), ...rest.map(upsert)] as const;
      });
    },

    async getMany(keys) {
      const result = new Map<CardKey, CardFacts>();
      const pages = await Promise.all(
        batches(distinct(keys)).map((batch) =>
          ctx.db
            .select()
            .from(cardCatalog)
            .where(and(eq(cardCatalog.workspaceId, ctx.workspaceId), inArray(cardCatalog.key, batch)))
            .all(),
        ),
      );
      for (const rows of pages) {
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
      }
      return result;
    },
  };
}

/** The value an upsert tried to insert into `column` (SQLite's `excluded` pseudo-table). */
function excluded(column: SQLiteColumn): SQL {
  return sql.raw(`excluded."${column.name}"`);
}
