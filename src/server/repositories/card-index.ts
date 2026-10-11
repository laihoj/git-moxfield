/**
 * Card-level queries over the `snapshot_cards` index: per-version zone quantities of
 * one card (the raw material of card history) and card search across a deck's history.
 *
 * Cost (Turso bills every row a query reads, including rows scanned): SQLite walks the
 * deck's commits in version order (`commits_deck_sequence_uq`) and looks each card up in
 * the `(card_key, snapshot_hash)` index (`snapshot_cards_card_key_snapshot_idx`) instead of
 * reading every card row of every version. `CROSS JOIN` fixes that join order (SQLite
 * never reorders it), so the plans do not depend on the planner's estimates;
 * `tests/integration/repositories/card-index.test.ts` asserts them, and the remote suite
 * (`tests/remote/repositories.test.ts`) bounds the rows read. Measured on a libSQL server
 * (sqld) holding 10 decks of 50 versions of 100 cards:
 *
 * - card history of one card in 29 versions: 110 rows read (5,111 before the index);
 * - a search: 5,102 rows for the candidates (each card row of the deck once) plus 2,632 for
 *   the version statistics of 20 hits (35,411 in all before, about 7 per card row).
 *
 * Search still reads every card row of the deck once, because matching folds names in
 * JavaScript (diacritics, punctuation). Should that become too expensive, a per-deck card
 * summary maintained at commit time would make it proportional to the distinct cards.
 */
import { sql, type SQL } from 'drizzle-orm';

import { compareStrings } from '@/core/canonical';
import { cardKey } from '@/core/card-key';
import type { ZoneQuantity } from '@/core/history/types';
import type { CardKey } from '@/core/model';
import { compareZones, isZoneId } from '@/core/zones';

import { corruptData } from './codec';
import { selectInBatches, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

/** Where one card was in one version. */
export interface CardVersionZones {
  commitId: string;
  sequence: number;
  /** Zones containing the card, in canonical zone order, quantities > 0. */
  zones: ZoneQuantity[];
}

export interface CardSearchHit {
  key: CardKey;
  /** Most recent display name (from the working state when it is searched and holds the card). */
  name: string;
  /** Number of versions containing the card in any zone. */
  versionsPresent: number;
  /** Highest version containing the card, `null` when it was never committed. */
  lastSeenSequence: number | null;
  /** Whether the deck's latest observation (the working state) contains the card. */
  inWorkingState: boolean;
}

export const DEFAULT_CARD_SEARCH_LIMIT = 20;

export interface CardIndexRepository {
  /**
   * The versions of a deck that contain the card, oldest first, with its zones in
   * each. Versions without the card are omitted; combine with the commit lineage to
   * get one point per version. `key` is normalized with `cardKey`.
   */
  versionsContainingCard(deckId: string, key: CardKey): Promise<CardVersionZones[]>;
  /**
   * Finds cards that appear in any version of the deck or, unless `includeWorking` is
   * `false`, in its working state (the latest observation). Committed history only, with
   * `includeWorking: false`: no card, name or flag then comes from the working state.
   * Matching ignores case, diacritics and punctuation (see {@link foldForSearch}).
   * Ranking: exact match, then prefix, then word prefix, then substring, then all
   * query words anywhere; ties sorted by card key. An empty query matches nothing.
   *
   * @throws {RepositoryError} `invalid-input` when `limit` is not a positive integer.
   */
  searchCardsInDeck(
    deckId: string,
    query: string,
    limit?: number,
    options?: { includeWorking?: boolean },
  ): Promise<CardSearchHit[]>;
}

/** One card in one zone of one version (a `snapshot_cards` row joined to its commit). */
interface CardOccurrenceRow {
  key: string;
  commitId: string;
  sequence: number;
  zone: string;
  quantity: number;
  name: string;
}

/** A card and one of its names, as it appears in a version or the working state. */
interface CardNameRow {
  key: string;
  name: string;
}

/**
 * Every row of `keys` in the versions of the deck, in version order. Walks the deck's
 * commits by `(deck_id, sequence)` and probes `(card_key, snapshot_hash)` per commit:
 * rows read ≈ versions + occurrences, whatever the size of the snapshots.
 *
 * @internal exported for the query-plan tests.
 */
export function cardOccurrencesQuery(workspaceId: string, deckId: string, keys: readonly string[]): SQL {
  return sql`
    SELECT sc.card_key AS "key", c.id AS "commitId", c.sequence AS "sequence",
      sc.zone AS "zone", sc.quantity AS "quantity", sc.name AS "name"
    FROM decks d
    CROSS JOIN commits c
    CROSS JOIN snapshot_cards sc
    WHERE d.id = ${deckId} AND d.workspace_id = ${workspaceId}
      AND c.deck_id = d.id
      AND sc.card_key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      )})
      AND sc.snapshot_hash = c.snapshot_hash
    ORDER BY c.sequence`;
}

/**
 * Every distinct (card, name) pair in the versions of the deck: the search candidates.
 * One pass over the deck's card rows through the primary key (`snapshot_hash` first);
 * the de-duplication happens in a temporary index, which reads no table rows.
 *
 * @internal exported for the query-plan tests.
 */
export function committedCardNamesQuery(workspaceId: string, deckId: string): SQL {
  return sql`
    SELECT DISTINCT sc.card_key AS "key", sc.name AS "name"
    FROM decks d
    CROSS JOIN commits c
    CROSS JOIN snapshot_cards sc
    WHERE d.id = ${deckId} AND d.workspace_id = ${workspaceId}
      AND c.deck_id = d.id
      AND sc.snapshot_hash = c.snapshot_hash`;
}

/**
 * The cards (one row per card and zone) of the deck's latest observation: latest
 * `fetched_at`, ties broken by insertion order, as `latestObservationFirst`.
 *
 * @internal exported for the query-plan tests.
 */
export function workingCardsQuery(workspaceId: string, deckId: string): SQL {
  return sql`
    SELECT sc.card_key AS "key", sc.name AS "name"
    FROM snapshot_cards sc
    WHERE sc.snapshot_hash = (
      SELECT o.snapshot_hash
      FROM decks d
      CROSS JOIN observations o
      WHERE d.id = ${deckId} AND d.workspace_id = ${workspaceId} AND o.deck_id = d.id
      ORDER BY o.fetched_at DESC, o.rowid DESC
      LIMIT 1
    )`;
}

/** The name SQLite's `MIN()` would pick (binary collation: UTF-8 byte order). */
function smallerName(a: string, b: string): string {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) <= 0 ? a : b;
}

/** Version statistics of one card in the deck's history. */
interface CommittedStats {
  versionsPresent: number;
  lastSeenSequence: number;
  /** The card's name in its newest version (the smallest, should it have several there). */
  name: string;
}

/** Aggregates occurrence rows (in version order) per card. */
function committedStats(rows: readonly CardOccurrenceRow[]): Map<string, CommittedStats> {
  const stats = new Map<string, CommittedStats>();
  for (const row of rows) {
    const known = stats.get(row.key);
    if (!known) {
      stats.set(row.key, { versionsPresent: 1, lastSeenSequence: row.sequence, name: row.name });
    } else if (row.sequence > known.lastSeenSequence) {
      known.versionsPresent++;
      known.lastSeenSequence = row.sequence;
      known.name = row.name;
    } else if (row.sequence === known.lastSeenSequence) {
      known.name = smallerName(known.name, row.name);
    }
  }
  return stats;
}

/** A search candidate before its version statistics are known. */
interface Candidate {
  key: CardKey;
  /** Its names in the deck's history (empty when it was never committed). */
  committedNames: string[];
  /** Its name in the working state, when the working state is searched and holds it. */
  workingName: string | undefined;
  /** The name it is shown and matched with, when already certain. */
  name: string | undefined;
  /** Its rank; for a card whose name is not yet certain, the best rank any of its names gets. */
  rank: number;
}

function rankOf(key: CardKey, names: readonly string[], folded: string): number {
  return Math.min(
    matchRank(foldForSearch(key), folded),
    ...names.map((name) => matchRank(foldForSearch(name), folded)),
  );
}

function byRankThenKey(a: { rank: number; key: CardKey }, b: { rank: number; key: CardKey }): number {
  return a.rank - b.rank || compareStrings(a.key, b.key);
}

export function createCardIndexRepository(ctx: RepositoryContext): CardIndexRepository {
  /** Occurrence rows of `keys` in the deck's versions, in version order. */
  async function occurrences(deckId: string, keys: readonly string[]): Promise<CardOccurrenceRow[]> {
    const rows = await selectInBatches(keys, (batch) =>
      ctx.db.all<CardOccurrenceRow>(cardOccurrencesQuery(ctx.workspaceId, deckId, batch)),
    );
    // Each batch is in version order already; merging several needs a (stable) sort.
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  return {
    async versionsContainingCard(deckId, key) {
      const rows = await occurrences(deckId, [cardKey(key)]);
      const versions: CardVersionZones[] = [];
      for (const row of rows) {
        if (!isZoneId(row.zone))
          throw corruptData(`Card index of commit ${row.commitId}`, `invalid zone ${row.zone}`);
        let current = versions.at(-1);
        if (current?.commitId !== row.commitId) {
          current = { commitId: row.commitId, sequence: row.sequence, zones: [] };
          versions.push(current);
        }
        current.zones.push({ zone: row.zone, quantity: row.quantity });
      }
      for (const version of versions) version.zones.sort((a, b) => compareZones(a.zone, b.zone));
      return versions;
    },

    async searchCardsInDeck(deckId, query, limit = DEFAULT_CARD_SEARCH_LIMIT, options = {}) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RepositoryError('invalid-input', `Search limit must be a positive integer, got ${limit}`);
      }
      const folded = foldForSearch(query);
      if (folded === '') return [];

      // 1. Candidates: every card of the deck's history with its names, and the working state.
      const [committedRows, workingRows] = await Promise.all([
        ctx.db.all<CardNameRow>(committedCardNamesQuery(ctx.workspaceId, deckId)),
        options.includeWorking === false
          ? Promise.resolve<CardNameRow[]>([])
          : ctx.db.all<CardNameRow>(workingCardsQuery(ctx.workspaceId, deckId)),
      ]);
      const candidates = new Map<CardKey, Candidate>();
      const candidate = (key: CardKey): Candidate => {
        let found = candidates.get(key);
        if (!found) {
          found = { key, committedNames: [], workingName: undefined, name: undefined, rank: NO_MATCH };
          candidates.set(key, found);
        }
        return found;
      };
      for (const row of committedRows) candidate(row.key).committedNames.push(row.name);
      for (const row of workingRows) {
        const found = candidate(row.key);
        found.workingName =
          found.workingName === undefined ? row.name : smallerName(found.workingName, row.name);
      }

      // 2. Rank. A card's shown name is its working name or its newest committed name; when
      // it had several names in its history, which one is newest is only known after step 3,
      // so it is ranked by its best name for now and ranked again then.
      const matches: Candidate[] = [];
      let uncertain = 0;
      for (const found of candidates.values()) {
        const [onlyName, ...otherNames] = found.committedNames;
        found.name = found.workingName ?? (otherNames.length === 0 ? onlyName : undefined);
        found.rank = rankOf(
          found.key,
          found.name === undefined ? found.committedNames : [found.name],
          folded,
        );
        if (found.rank === NO_MATCH) continue;
        matches.push(found);
        if (found.name === undefined) uncertain++;
      }
      // Ranking an uncertain card again can only make it worse, so the final `limit` hits
      // are among the first `limit + uncertain` by the provisional ranking.
      const shortlist = matches.sort(byRankThenKey).slice(0, limit + uncertain);

      // 3. Version statistics of the shortlisted cards, through the card-key index.
      const stats = committedStats(
        await occurrences(
          deckId,
          shortlist.filter((found) => found.committedNames.length > 0).map((found) => found.key),
        ),
      );

      const hits: { hit: CardSearchHit; rank: number; key: CardKey }[] = [];
      for (const found of shortlist) {
        const committed = stats.get(found.key);
        const name = found.workingName ?? committed?.name;
        // Gone since step 1 (the deck changed in between): nothing to show.
        if (name === undefined) continue;
        const rank = found.name === undefined ? rankOf(found.key, [name], folded) : found.rank;
        if (rank === NO_MATCH) continue;
        hits.push({
          key: found.key,
          rank,
          hit: {
            key: found.key,
            name,
            versionsPresent: committed?.versionsPresent ?? 0,
            lastSeenSequence: committed?.lastSeenSequence ?? null,
            inWorkingState: found.workingName !== undefined,
          },
        });
      }
      return hits
        .sort(byRankThenKey)
        .slice(0, limit)
        .map(({ hit }) => hit);
    },
  };
}

const NO_MATCH = Number.POSITIVE_INFINITY;

/** Lower is better; {@link NO_MATCH} when the candidate does not match. */
function matchRank(candidate: string, query: string): number {
  if (candidate === query) return 0;
  if (candidate.startsWith(query)) return 1;
  if (candidate.includes(` ${query}`)) return 2;
  if (candidate.includes(query)) return 3;
  const words = query.split(' ');
  if (words.length > 1 && words.every((word) => candidate.includes(word))) return 4;
  if (candidate.replaceAll(' ', '').includes(query.replaceAll(' ', ''))) return 4;
  return NO_MATCH;
}

/**
 * Folds text for lenient card matching: card-key normalization (case, quotes,
 * spacing), diacritics removed (`Lórien` → `lorien`), ligatures expanded
 * (`Æther` → `aether`), apostrophes dropped (`Thassa's` → `thassas`) and any other
 * punctuation turned into single spaces (`Fire // Ice` → `fire ice`).
 */
export function foldForSearch(text: string): string {
  return cardKey(text)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/ß/g, 'ss')
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
