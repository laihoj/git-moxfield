/**
 * Card-level queries over the `snapshot_cards` index: per-version zone quantities of
 * one card (the raw material of card history) and card search across a deck's history.
 */
import { and, asc, eq, min, sql } from 'drizzle-orm';

import { compareStrings } from '@/core/canonical';
import { cardKey } from '@/core/card-key';
import type { ZoneQuantity } from '@/core/history/types';
import type { CardKey } from '@/core/model';
import { compareZones, isZoneId } from '@/core/zones';
import { commits, observations, snapshotCards } from '@/server/db/schema';

import { corruptData } from './codec';
import { inWorkspace, type RepositoryContext } from './context';
import { RepositoryError } from './errors';
import { latestObservationFirst } from './observations';

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
  versionsContainingCard(deckId: string, key: CardKey): CardVersionZones[];
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
  ): CardSearchHit[];
}

export function createCardIndexRepository(ctx: RepositoryContext): CardIndexRepository {
  return {
    versionsContainingCard(deckId, key) {
      const rows = ctx.db
        .select({
          commitId: commits.id,
          sequence: commits.sequence,
          zone: snapshotCards.zone,
          quantity: snapshotCards.quantity,
        })
        .from(commits)
        .innerJoin(snapshotCards, eq(snapshotCards.snapshotHash, commits.snapshotHash))
        .where(
          and(
            eq(commits.deckId, deckId),
            eq(snapshotCards.cardKey, cardKey(key)),
            inWorkspace(ctx, commits.deckId),
          ),
        )
        .orderBy(asc(commits.sequence))
        .all();
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

    searchCardsInDeck(deckId, query, limit = DEFAULT_CARD_SEARCH_LIMIT, options = {}) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new RepositoryError('invalid-input', `Search limit must be a positive integer, got ${limit}`);
      }
      const folded = foldForSearch(query);
      if (folded === '') return [];

      const candidates = new Map<CardKey, CardSearchHit>();
      for (const row of committedCards(ctx, deckId)) {
        candidates.set(row.key, {
          key: row.key,
          name: row.name,
          versionsPresent: row.versions,
          lastSeenSequence: row.lastSeenSequence,
          inWorkingState: false,
        });
      }
      const working = options.includeWorking === false ? [] : workingCards(ctx, deckId);
      for (const row of working) {
        const known = candidates.get(row.key);
        if (known) {
          known.name = row.name;
          known.inWorkingState = true;
        } else {
          candidates.set(row.key, {
            key: row.key,
            name: row.name,
            versionsPresent: 0,
            lastSeenSequence: null,
            inWorkingState: true,
          });
        }
      }

      const ranked: { hit: CardSearchHit; rank: number }[] = [];
      for (const hit of candidates.values()) {
        const rank = Math.min(
          matchRank(foldForSearch(hit.key), folded),
          matchRank(foldForSearch(hit.name), folded),
        );
        if (rank !== NO_MATCH) ranked.push({ hit, rank });
      }
      return ranked
        .sort((a, b) => a.rank - b.rank || compareStrings(a.hit.key, b.hit.key))
        .slice(0, limit)
        .map(({ hit }) => hit);
    },
  };
}

interface CommittedCardRow {
  key: string;
  name: string;
  versions: number;
  lastSeenSequence: number;
}

/**
 * Every card that appears in any version of the deck, with the number of versions
 * containing it and its name in the newest such version (aggregated in SQL so only
 * one row per distinct card reaches JavaScript).
 */
function committedCards(ctx: RepositoryContext, deckId: string): CommittedCardRow[] {
  return ctx.db.all<CommittedCardRow>(sql`
    WITH per_version AS (
      SELECT sc.card_key, c.sequence, MIN(sc.name) AS name
      FROM commits c
      JOIN snapshot_cards sc ON sc.snapshot_hash = c.snapshot_hash
      WHERE c.deck_id = ${deckId}
        AND c.deck_id IN (SELECT d.id FROM decks d WHERE d.workspace_id = ${ctx.workspaceId})
      GROUP BY sc.card_key, c.id, c.sequence
    ),
    ranked AS (
      SELECT card_key, name, sequence,
        COUNT(*) OVER (PARTITION BY card_key) AS versions,
        ROW_NUMBER() OVER (PARTITION BY card_key ORDER BY sequence DESC) AS position
      FROM per_version
    )
    SELECT card_key AS "key", name, versions, sequence AS "lastSeenSequence"
    FROM ranked
    WHERE position = 1
  `);
}

/** Cards of the deck's latest observation (one row per card, any zone). */
function workingCards(ctx: RepositoryContext, deckId: string): { key: string; name: string }[] {
  const latest = ctx.db
    .select({ snapshotHash: observations.snapshotHash })
    .from(observations)
    .where(and(eq(observations.deckId, deckId), inWorkspace(ctx, observations.deckId)))
    .orderBy(...latestObservationFirst)
    .limit(1)
    .get();
  if (!latest) return [];
  return ctx.db
    .select({ key: snapshotCards.cardKey, name: min(snapshotCards.name).mapWith(String) })
    .from(snapshotCards)
    .where(eq(snapshotCards.snapshotHash, latest.snapshotHash))
    .groupBy(snapshotCards.cardKey)
    .all();
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
