import { describe, expect, it } from 'vitest';

import { foldForSearch } from '@/server/repositories';
import { buildSnapshot, type SnapshotSpec } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  expectRepositoryError,
  observeTestSnapshot,
} from '@tests/support/db';

function deckState(zones: SnapshotSpec['zones']): ReturnType<typeof buildSnapshot> {
  return buildSnapshot({ zones });
}

describe('card index repository', () => {
  describe('versionsContainingCard', () => {
    it('returns the zones of the card per version that contains it, oldest first', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const other = createTestDeck(repos);
      const v1 = commitTestSnapshot(repos, deck, deckState({ mainboard: ['Dress Down', 'Island'] }));
      const v2 = commitTestSnapshot(
        repos,
        deck,
        deckState({ mainboard: ['Island'], considering: ['Dress Down'] }),
      );
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }));
      const v4 = commitTestSnapshot(
        repos,
        deck,
        deckState({
          sideboard: ['Dress Down'],
          mainboard: ['2 Dress Down', 'Island'],
          commanders: ['Dress Down'],
        }),
      );
      commitTestSnapshot(repos, other, deckState({ mainboard: ['Dress Down'] }));

      expect(repos.cardIndex.versionsContainingCard(deck.id, 'dress down')).toEqual([
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

    it('normalizes the key and returns nothing for unknown cards', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(repos, deck, deckState({ mainboard: ["Thassa's Oracle"] }));

      expect(repos.cardIndex.versionsContainingCard(deck.id, '  Thassa’s   ORACLE ')).toHaveLength(1);
      expect(repos.cardIndex.versionsContainingCard(deck.id, 'Island')).toEqual([]);
      expect(repos.cardIndex.versionsContainingCard('missing', "thassa's oracle")).toEqual([]);
    });
  });

  describe('searchCardsInDeck', () => {
    it('ranks exact, prefix, word-prefix, substring and all-words matches in that order', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(
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

      const names = (query: string): string[] =>
        repos.cardIndex.searchCardsInDeck(deck.id, query).map((h) => h.name);

      expect(names('oracle')).toEqual([
        'Oracle',
        'Oracle Engine',
        'Oracle of Mul Daya',
        'Pale Oracle Shade',
        "Thassa's Oracle",
        'Coracle Captain',
      ]);
      expect(names('oracle mul')).toEqual(['Oracle of Mul Daya']);
      expect(names('mul oracle')).toEqual(['Oracle of Mul Daya']);
      expect(names('palegracle')).toEqual([]);
    });

    it('ignores case, diacritics, ligatures, apostrophes and punctuation', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(
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
      const first = (query: string): string | undefined =>
        repos.cardIndex.searchCardsInDeck(deck.id, query).at(0)?.name;

      expect(first('lorien')).toBe('Lórien Revealed');
      expect(first('LÓRIEN rev')).toBe('Lórien Revealed');
      expect(first('thassas oracle')).toBe("Thassa's Oracle");
      expect(first('Thassa’s')).toBe("Thassa's Oracle");
      expect(first('fire//ice')).toBe('Fire // Ice');
      expect(first('aether')).toBe('Æther Vial');
      expect(first('Æther')).toBe('Æther Vial');
      expect(first('kraum opus')).toBe("Kraum, Ludevic's Opus");
      expect(first('limdul')).toBe('Lim-Dûl the Necromancer');
      expect(first('lim dul')).toBe('Lim-Dûl the Necromancer');
    });

    it('reports presence across versions, the latest name and the working state', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol ring', 'Mana Crypt'] }));
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol Ring'], considering: ['Mana Crypt'] }));
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['SOL RING'] }));
      observeTestSnapshot(repos, deck, deckState({ mainboard: ['Sol Ring', 'Mana Vault'] }));

      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'sol ring')).toEqual([
        { key: 'sol ring', name: 'Sol Ring', versionsPresent: 3, lastSeenSequence: 3, inWorkingState: true },
      ]);
      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'mana')).toEqual([
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

    it('uses the newest name among committed versions when the card is not in the working state', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol ring'] }));
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Sol Ring'] }));
      observeTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }));

      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'sol')).toEqual([
        { key: 'sol ring', name: 'Sol Ring', versionsPresent: 2, lastSeenSequence: 2, inWorkingState: false },
      ]);
    });

    it('searches the working state of decks without versions', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'island')).toEqual([]);

      observeTestSnapshot(repos, deck, deckState({ mainboard: ['Island'] }), {
        fetchedAt: '2026-01-01T00:00:00.000Z',
      });
      observeTestSnapshot(repos, deck, deckState({ mainboard: ['Tropical Island'] }), {
        fetchedAt: '2026-01-02T00:00:00.000Z',
      });

      // Only the latest observation counts as the working state.
      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'island').map((h) => h.name)).toEqual([
        'Tropical Island',
      ]);
    });

    it('only searches the given deck', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const other = createTestDeck(repos);
      commitTestSnapshot(repos, other, deckState({ mainboard: ['Island'] }));
      observeTestSnapshot(repos, other, deckState({ mainboard: ['Island'] }));
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Swamp'] }));

      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'island')).toEqual([]);
    });

    it('applies the limit after ranking and validates it', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      const many = Array.from({ length: 30 }, (_, i) => `Island ${String(i).padStart(2, '0')}`);
      commitTestSnapshot(repos, deck, deckState({ mainboard: [...many, 'Island'] }));

      const defaultLimit = repos.cardIndex.searchCardsInDeck(deck.id, 'island');
      expect(defaultLimit).toHaveLength(20);
      expect(defaultLimit[0]?.name).toBe('Island');
      expect(repos.cardIndex.searchCardsInDeck(deck.id, 'island', 3).map((h) => h.name)).toEqual([
        'Island',
        'Island 00',
        'Island 01',
      ]);
      expectRepositoryError(() => repos.cardIndex.searchCardsInDeck(deck.id, 'island', 0), 'invalid-input');
      expectRepositoryError(() => repos.cardIndex.searchCardsInDeck(deck.id, 'island', 2.5), 'invalid-input');
    });

    it('matches nothing for empty or punctuation-only queries', () => {
      const { repos } = createTestRepositories();
      const deck = createTestDeck(repos);
      commitTestSnapshot(repos, deck, deckState({ mainboard: ['Fire // Ice'] }));
      for (const query of ['', '   ', '//', "'", ',.']) {
        expect(repos.cardIndex.searchCardsInDeck(deck.id, query)).toEqual([]);
      }
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
