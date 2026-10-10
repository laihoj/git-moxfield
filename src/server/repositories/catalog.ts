/**
 * Card catalog: display facts per card key (type line, mana cost, ...). Reference data
 * that is not versioned; the latest write wins.
 */
import { inArray, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { CardFacts, CardKey } from '@/core/model';
import { cardCatalog } from '@/server/db/schema';

import { decodeStringArray, encodeJson } from './codec';
import { batches, distinct, withTransaction, type RepositoryContext } from './context';

export interface CatalogRepository {
  /**
   * Inserts or replaces facts in one transaction. When the input contains the same key
   * more than once, the last entry wins.
   */
  upsertMany(facts: readonly CardFacts[]): void;
  /** Facts for the given keys; unknown keys are absent from the result. */
  getMany(keys: Iterable<CardKey>): Map<CardKey, CardFacts>;
}

export function createCatalogRepository(ctx: RepositoryContext): CatalogRepository {
  return {
    upsertMany(facts) {
      if (facts.length === 0) return;
      const latest = new Map<CardKey, CardFacts>();
      for (const fact of facts) latest.set(fact.key, fact);
      const updatedAt = ctx.now();
      const rows = [...latest.values()].map((fact) => ({
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
      withTransaction(ctx, ({ db }) => {
        for (const batch of batches(rows)) {
          db.insert(cardCatalog)
            .values(batch)
            .onConflictDoUpdate({
              target: cardCatalog.key,
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
            })
            .run();
        }
      });
    },

    getMany(keys) {
      const result = new Map<CardKey, CardFacts>();
      for (const batch of batches(distinct(keys))) {
        const rows = ctx.db.select().from(cardCatalog).where(inArray(cardCatalog.key, batch)).all();
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
