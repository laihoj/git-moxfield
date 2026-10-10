/**
 * The viewer scope's guard (`confineToDeck`): within the deck's workspace, every deck id
 * must be the confined deck's, and commits, tags, notes and snapshots are reachable only
 * through the confined deck's own versions. Violations are refused loudly, never answered.
 */
import { describe, expect, it } from 'vitest';

import { DeckConfinementError } from '@/server/services';
import { confineToDeck } from '@/server/services/confined-history';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import {
  commitTestSnapshot,
  createTestDeck,
  createTestRepositories,
  observeTestSnapshot,
} from '@tests/support/db';

function setup() {
  const { repos } = createTestRepositories();
  const shared = createTestDeck(repos);
  const sibling = createTestDeck(repos);
  const v1 = commitTestSnapshot(repos, shared, buildSnapshot(baseDeckSpec()));
  const v2 = commitTestSnapshot(
    repos,
    shared,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Island', 'Sol Ring'] } }),
  );
  repos.tags.add(v1.id, 'tournament');
  repos.notes.upsert(v1.id, 'note', { text: 'Top 4' });
  const foreign = commitTestSnapshot(
    repos,
    sibling,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Lightning Bolt'] } }),
  );
  repos.notes.upsert(foreign.id, 'note', { text: 'Sibling secret' });
  const working = observeTestSnapshot(
    repos,
    shared,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Mystic Remnant'] } }),
  );
  return { repos, shared, sibling, v1, v2, foreign, working, view: confineToDeck(repos, shared.id) };
}

describe('confineToDeck', () => {
  it('answers for the confined deck exactly like the repositories', () => {
    const { repos, shared, view } = setup();
    expect(view.commits.listForDeck(shared.id)).toEqual(repos.commits.listForDeck(shared.id));
    expect(view.commits.head(shared.id)).toEqual(repos.commits.head(shared.id));
    expect(view.commits.lineage(shared.id)).toEqual(repos.commits.lineage(shared.id));
    expect(view.tags.listForDeck(shared.id)).toEqual(repos.tags.listForDeck(shared.id));
    expect(view.decks.getById(shared.id)).toEqual(repos.decks.getById(shared.id));
  });

  it('refuses every other deck id', () => {
    const { sibling, view } = setup();
    const calls: (() => unknown)[] = [
      () => view.decks.getById(sibling.id),
      () => view.commits.getBySequence(sibling.id, 1),
      () => view.commits.findByIdPrefix(sibling.id, 'abcd'),
      () => view.commits.head(sibling.id),
      () => view.commits.lineage(sibling.id),
      () => view.commits.listForDeck(sibling.id),
      () => view.commits.count(sibling.id),
      () => view.tags.listForDeck(sibling.id),
      () => view.tags.commitsWithTag(sibling.id, 'tournament'),
      () => view.cardIndex.versionsContainingCard(sibling.id, 'island'),
      () => view.cardIndex.searchCardsInDeck(sibling.id, 'island'),
    ];
    for (const call of calls) expect(call).toThrow(DeckConfinementError);
  });

  it('refuses another deck’s commit, also when looked up by id', () => {
    const { foreign, view } = setup();
    expect(() => view.commits.getById(foreign.id)).toThrow(DeckConfinementError);
  });

  it('reaches tags, notes and snapshots only through the deck’s versions it returned', () => {
    const { shared, v1, foreign, working, view } = setup();
    // Not yet returned by the view: refused, even for the deck's own commit.
    expect(() => view.notes.listForCommit(v1.id)).toThrow(DeckConfinementError);
    expect(() => view.snapshots.get(v1.snapshotHash)).toThrow(DeckConfinementError);

    view.commits.listForDeck(shared.id);
    expect(view.tags.listForCommit(v1.id)).toEqual(['tournament']);
    expect(view.tags.listForCommits([v1.id]).get(v1.id)).toEqual(['tournament']);
    expect(view.notes.listForCommit(v1.id)).toHaveLength(1);
    expect(view.snapshots.get(v1.snapshotHash)).not.toBeNull();
    expect(view.commits.lineage(shared.id, v1.id)).toHaveLength(1);

    // Another deck's version and the working state stay out of reach.
    expect(() => view.notes.listForCommit(foreign.id)).toThrow(DeckConfinementError);
    expect(() => view.tags.listForCommits([v1.id, foreign.id])).toThrow(DeckConfinementError);
    expect(() => view.commits.lineage(shared.id, foreign.id)).toThrow(DeckConfinementError);
    expect(() => view.snapshots.get(foreign.snapshotHash)).toThrow(DeckConfinementError);
    expect(() => view.snapshots.getMany([v1.snapshotHash, working.snapshotHash])).toThrow(
      DeckConfinementError,
    );
  });

  it('searches committed cards only, whatever the caller asks for', () => {
    const { repos, shared, view } = setup();
    expect(repos.cardIndex.searchCardsInDeck(shared.id, 'mystic', 5, { includeWorking: true })).toHaveLength(
      1,
    );
    expect(view.cardIndex.searchCardsInDeck(shared.id, 'mystic', 5, { includeWorking: true })).toEqual([]);
    expect(view.cardIndex.searchCardsInDeck(shared.id, 'sol ring')).toHaveLength(1);
  });
});
