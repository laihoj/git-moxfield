import { sql, type SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { LibsqlExecutor } from '@/server/db/libsql';
import { snapshotCards } from '@/server/db/schema';
import { foldForSearch } from '@/server/repositories';
import {
  cardOccurrencesQuery,
  committedCardNamesQuery,
  workingCardsQuery,
} from '@/server/repositories/card-index';
import { buildSnapshot, type SnapshotSpec } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
  openTestDatabase,
} from '@tests/support/db';

function deckState(zones: SnapshotSpec['zones']): ReturnType<typeof buildSnapshot> {
  return buildSnapshot({ zones });
}

describe('card index repository', () => {
  describe('versionsContainingCard', () => {
    it('returns the zones of the card per version that contains it, oldest first', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const other = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Dress Down', 'Island'] }));
      const v2 = await commitTestSnapshot(
        repos,
        deck,
        deckState({ mainboard: ['Island'], considering: ['Dress Down'] }),
      );
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }));
      const v4 = await commitTestSnapshot(
        repos,
        deck,
        deckState({
          sideboard: ['Dress Down'],
          mainboard: ['2 Dress Down', 'Island'],
          commanders: ['Dress Down'],
        }),
      );
      await commitTestSnapshot(repos, other, deckState({ mainboard: ['Dress Down'] }));

      expect(await repos.cardIndex.versionsContainingCard(deck.id, 'dress down')).toEqual([
        { commitId: v1.id, sequence: 1, zones: [{ zone: 'mainboard', quantity: 1 }] },
        { commitId: v2.id, sequence: 2, zones: [{ zone: 'considering', quantity: 1 }] },
        {
          commitId: v4.id,
          sequence: 4,
          zones: [
            { zone: 'commanders', quantity: 1 },
            { zone: 'mainboard', quantity: 2 },
            { zone: 'sideboard', quantity: 1 },
          ],
        },
      ]);
    });

    it('normalizes the key and returns nothing for unknown cards', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ["Thassa's Oracle"] }));

      expect(await repos.cardIndex.versionsContainingCard(deck.id, '  Thassa’s   ORACLE ')).toHaveLength(1);
      expect(await repos.cardIndex.versionsContainingCard(deck.id, 'Island')).toEqual([]);
      expect(await repos.cardIndex.versionsContainingCard('missing', "thassa's oracle")).toEqual([]);
    });
  });

  describe('searchCardsInDeck', () => {
    it('ranks exact, prefix, word-prefix, substring and all-words matches in that order', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(
        repos,
        deck,
        deckState({
          mainboard: [
            'Coracle Captain',
            "Thassa's Oracle",
            'Oracle of Mul Daya',
            'Oracle',
            'Orcish Bowmasters',
          ],
          considering: ['Oracle Engine', 'Oracular Charm'],
          sideboard: ['Pale Oracle Shade'],
        }),
      );

      const names = async (query: string): Promise<string[]> =>
        (await repos.cardIndex.searchCardsInDeck(deck.id, query)).map((h) => h.name);

      expect(await names('oracle')).toEqual([
        'Oracle',
        'Oracle Engine',
        'Oracle of Mul Daya',
        'Pale Oracle Shade',
        "Thassa's Oracle",
        'Coracle Captain',
      ]);
      expect(await names('oracle mul')).toEqual(['Oracle of Mul Daya']);
      expect(await names('mul oracle')).toEqual(['Oracle of Mul Daya']);
      expect(await names('palegracle')).toEqual([]);
    });

    it('ignores case, diacritics, ligatures, apostrophes and punctuation', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(
        repos,
        deck,
        deckState({
          commanders: ["Kraum, Ludevic's Opus"],
          mainboard: [
            'Lórien Revealed',
            "Thassa's Oracle",
            'Fire // Ice',
            'Æther Vial',
            'Lim-Dûl the Necromancer',
          ],
        }),
      );
      const first = async (query: string): Promise<string | undefined> =>
        (await repos.cardIndex.searchCardsInDeck(deck.id, query)).at(0)?.name;

      expect(await first('lorien')).toBe('Lórien Revealed');
      expect(await first('LÓRIEN rev')).toBe('Lórien Revealed');
      expect(await first('thassas oracle')).toBe("Thassa's Oracle");
      expect(await first('Thassa’s')).toBe("Thassa's Oracle");
      expect(await first('fire//ice')).toBe('Fire // Ice');
      expect(await first('aether')).toBe('Æther Vial');
      expect(await first('Æther')).toBe('Æther Vial');
      expect(await first('kraum opus')).toBe("Kraum, Ludevic's Opus");
      expect(await first('limdul')).toBe('Lim-Dûl the Necromancer');
      expect(await first('lim dul')).toBe('Lim-Dûl the Necromancer');
    });

    it('reports presence across versions, the latest name and the working state', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol ring', 'Mana Crypt'] }));
      await commitTestSnapshot(
        repos,
        deck,
        deckState({ mainboard: ['Sol Ring'], considering: ['Mana Crypt'] }),
      );
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['SOL RING'] }));
      await observeTestSnapshot(repos, deck, deckState({ mainboard: ['Sol Ring', 'Mana Vault'] }));

      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'sol ring')).toEqual([
        { key: 'sol ring', name: 'Sol Ring', versionsPresent: 3, lastSeenSequence: 3, inWorkingState: true },
      ]);
      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'mana')).toEqual([
        {
          key: 'mana crypt',
          name: 'Mana Crypt',
          versionsPresent: 2,
          lastSeenSequence: 2,
          inWorkingState: false,
        },
        {
          key: 'mana vault',
          name: 'Mana Vault',
          versionsPresent: 0,
          lastSeenSequence: null,
          inWorkingState: true,
        },
      ]);
    });

    it('uses the newest name among committed versions when the card is not in the working state', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol ring'] }));
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol Ring'] }));
      await observeTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }));

      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'sol')).toEqual([
        { key: 'sol ring', name: 'Sol Ring', versionsPresent: 2, lastSeenSequence: 2, inWorkingState: false },
      ]);
    });

    it('searches the working state of decks without versions', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'island')).toEqual([]);

      await observeTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }), {
        fetchedAt: '2026-01-01T00:00:00.000Z',
      });
      await observeTestSnapshot(repos, deck, deckState({ mainboard: ['Tropical Island'] }), {
        fetchedAt: '2026-01-02T00:00:00.000Z',
      });

      // Only the latest observation counts as the working state.
      expect((await repos.cardIndex.searchCardsInDeck(deck.id, 'island')).map((h) => h.name)).toEqual([
        'Tropical Island',
      ]);
    });

    it('only searches the given deck', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const other = await createTestDeck(repos);
      await commitTestSnapshot(repos, other, deckState({ mainboard: ['Island'] }));
      await observeTestSnapshot(repos, other, deckState({ mainboard: ['Island'] }));
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Swamp'] }));

      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'island')).toEqual([]);
    });

    it('applies the limit after ranking and validates it', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const many = Array.from({ length: 30 }, (_, i) => `Island ${String(i).padStart(2, '0')}`);
      await commitTestSnapshot(repos, deck, deckState({ mainboard: [...many, 'Island'] }));

      const defaultLimit = await repos.cardIndex.searchCardsInDeck(deck.id, 'island');
      expect(defaultLimit).toHaveLength(20);
      expect(defaultLimit[0]?.name).toBe('Island');
      expect((await repos.cardIndex.searchCardsInDeck(deck.id, 'island', 3)).map((h) => h.name)).toEqual([
        'Island',
        'Island 00',
        'Island 01',
      ]);
      await expectRepositoryError(
        () => repos.cardIndex.searchCardsInDeck(deck.id, 'island', 0),
        'invalid-input',
      );
      await expectRepositoryError(
        () => repos.cardIndex.searchCardsInDeck(deck.id, 'island', 2.5),
        'invalid-input',
      );
    });

    it('matches nothing for empty or punctuation-only queries', async () => {
      const { repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Fire // Ice'] }));
      for (const query of ['', '   ', '//', "'", ',.']) {
        expect(await repos.cardIndex.searchCardsInDeck(deck.id, query)).toEqual([]);
      }
    });
  });

  describe('search with names that changed over the history', () => {
    it('ranks a card by its newest name, also when an older name ranked it first', async () => {
      const { db, repos } = await createTestRepositories();
      const deck = await createTestDeck(repos);
      const v1 = await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }));
      const v2 = await commitTestSnapshot(repos, deck, deckState({ mainboard: ['Oracle of Mul Daya'] }));
      // Index rows of one card under two names that fold differently (names normally only
      // differ in case and quotes); `a card` sorts before every other key.
      for (const [snapshotHash, name] of [
        [v1.snapshotHash, 'Oracle Ascendant'],
        [v2.snapshotHash, 'Renamed Card'],
      ] as const) {
        await db
          .insert(snapshotCards)
          .values({ snapshotHash, zone: 'considering', cardKey: 'a card', name, quantity: 1 });
      }

      // Its old name matches "oracle", its newest does not: not a hit, and it does not take
      // the place of one within the limit.
      expect(
        await repos.cardIndex.searchCardsInDeck(deck.id, 'oracle', 1, { includeWorking: false }),
      ).toEqual([
        {
          key: 'oracle of mul daya',
          name: 'Oracle of Mul Daya',
          versionsPresent: 1,
          lastSeenSequence: 2,
          inWorkingState: false,
        },
      ]);
      expect(await repos.cardIndex.searchCardsInDeck(deck.id, 'renamed')).toEqual([
        {
          key: 'a card',
          name: 'Renamed Card',
          versionsPresent: 2,
          lastSeenSequence: 2,
          inWorkingState: false,
        },
      ]);
    });
  });

  describe('query plans', () => {
    /** The plan of `query` (Turso bills every row a query reads, including scanned ones). */
    async function plan(db: LibsqlExecutor, query: SQL): Promise<string[]> {
      const rows = await db.all<{ detail: string }>(sql`EXPLAIN QUERY PLAN ${query}`);
      return rows.map((row) => row.detail);
    }

    it('looks cards up per version of the deck through the card-key index, without scans or sorting', async () => {
      const db = await openTestDatabase();
      for (const keys of [['sol ring'], ['sol ring', 'island', 'mana vault']]) {
        expect(await plan(db, cardOccurrencesQuery('workspace', 'deck', keys))).toEqual([
          'SEARCH d USING INDEX sqlite_autoindex_decks_1 (id=?)',
          'SEARCH c USING INDEX commits_deck_sequence_uq (deck_id=?)',
          'SEARCH sc USING INDEX snapshot_cards_card_key_snapshot_idx (card_key=? AND snapshot_hash=?)',
        ]);
      }
    });

    it('reads each card row of the deck once for the search candidates', async () => {
      const db = await openTestDatabase();
      expect(await plan(db, committedCardNamesQuery('workspace', 'deck'))).toEqual([
        'SEARCH d USING INDEX sqlite_autoindex_decks_1 (id=?)',
        'SEARCH c USING INDEX commits_deck_sequence_uq (deck_id=?)',
        'SEARCH sc USING INDEX sqlite_autoindex_snapshot_cards_1 (snapshot_hash=?)',
        'USE TEMP B-TREE FOR DISTINCT',
      ]);
    });

    it('finds the working state through the latest observation, without sorting', async () => {
      const db = await openTestDatabase();
      expect(await plan(db, workingCardsQuery('workspace', 'deck'))).toEqual([
        'SEARCH sc USING INDEX sqlite_autoindex_snapshot_cards_1 (snapshot_hash=?)',
        'SCALAR SUBQUERY 1',
        'SEARCH d USING INDEX sqlite_autoindex_decks_1 (id=?)',
        'SEARCH o USING INDEX observations_deck_fetched_idx (deck_id=?)',
      ]);
    });
  });

  describe('foldForSearch', () => {
    it.each([
      ['Lórien Revealed', 'lorien revealed'],
      ["Thassa's Oracle", 'thassas oracle'],
      ['Thassa’s Oracle', 'thassas oracle'],
      ["Kraum, Ludevic's Opus", 'kraum ludevics opus'],
      ['Fire // Ice', 'fire ice'],
      ['Æther Vial', 'aether vial'],
      ['Lim-Dûl the Necromancer', 'lim dul the necromancer'],
      ['  Jötun   Grunt ', 'jotun grunt'],
      ['"Ach! Hans, Run!"', 'ach hans run'],
      ['Borrowing 100,000 Arrows', 'borrowing 100 000 arrows'],
      ['', ''],
    ])('folds %j to %j', (input, expected) => {
      expect(foldForSearch(input)).toBe(expected);
    });
  });
});
