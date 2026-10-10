/**
 * The viewer scope's guard (`confineToDeck`): within the deck's workspace, every deck id
 * must be the confined deck's, and commits, tags, notes and snapshots are reachable only
 * through the confined deck's own versions. Violations are refused loudly (the call
 * rejects), never answered.
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

async function setup() {
  const { repos } = await createTestRepositories();
  const shared = await createTestDeck(repos);
  const sibling = await createTestDeck(repos);
  const v1 = await commitTestSnapshot(repos, shared, buildSnapshot(baseDeckSpec()));
  const v2 = await commitTestSnapshot(
    repos,
    shared,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Island', 'Sol Ring'] } }),
  );
  await repos.tags.add(v1.id, 'tournament');
  await repos.notes.upsert(v1.id, 'note', { text: 'Top 4' });
  const foreign = await commitTestSnapshot(
    repos,
    sibling,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Lightning Bolt'] } }),
  );
  await repos.notes.upsert(foreign.id, 'note', { text: 'Sibling secret' });
  const working = await observeTestSnapshot(
    repos,
    shared,
    buildSnapshot({ ...baseDeckSpec(), zones: { mainboard: ['Mystic Remnant'] } }),
  );
  return { repos, shared, sibling, v1, v2, foreign, working, view: confineToDeck(repos, shared.id) };
}

describe('confineToDeck', () => {
  it('answers for the confined deck exactly like the repositories', async () => {
    const { repos, shared, view } = await setup();
    expect(await view.commits.listForDeck(shared.id)).toEqual(await repos.commits.listForDeck(shared.id));
    expect(await view.commits.head(shared.id)).toEqual(await repos.commits.head(shared.id));
    expect(await view.commits.lineage(shared.id)).toEqual(await repos.commits.lineage(shared.id));
    expect(await view.tags.listForDeck(shared.id)).toEqual(await repos.tags.listForDeck(shared.id));
    expect(await view.decks.getById(shared.id)).toEqual(await repos.decks.getById(shared.id));
  });

  it('refuses every other deck id', async () => {
    const { sibling, view } = await setup();
    const calls: (() => Promise<unknown>)[] = [
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
    for (const call of calls) await expect(call()).rejects.toThrow(DeckConfinementError);
  });

  it('refuses another deck’s commit, also when looked up by id', async () => {
    const { foreign, view } = await setup();
    await expect(view.commits.getById(foreign.id)).rejects.toThrow(DeckConfinementError);
  });

  it('reaches tags, notes and snapshots only through the deck’s versions it returned', async () => {
    const { shared, v1, foreign, working, view } = await setup();
    // Not yet returned by the view: refused, even for the deck's own commit.
    await expect(view.notes.listForCommit(v1.id)).rejects.toThrow(DeckConfinementError);
    await expect(view.snapshots.get(v1.snapshotHash)).rejects.toThrow(DeckConfinementError);

    await view.commits.listForDeck(shared.id);
    expect(await view.tags.listForCommit(v1.id)).toEqual(['tournament']);
    expect((await view.tags.listForCommits([v1.id])).get(v1.id)).toEqual(['tournament']);
    expect(await view.notes.listForCommit(v1.id)).toHaveLength(1);
    expect(await view.snapshots.get(v1.snapshotHash)).not.toBeNull();
    expect(await view.commits.lineage(shared.id, v1.id)).toHaveLength(1);

    // Another deck's version and the working state stay out of reach.
    await expect(view.notes.listForCommit(foreign.id)).rejects.toThrow(DeckConfinementError);
    await expect(view.tags.listForCommits([v1.id, foreign.id])).rejects.toThrow(DeckConfinementError);
    await expect(view.commits.lineage(shared.id, foreign.id)).rejects.toThrow(DeckConfinementError);
    await expect(view.snapshots.get(foreign.snapshotHash)).rejects.toThrow(DeckConfinementError);
    await expect(view.snapshots.getMany([v1.snapshotHash, working.snapshotHash])).rejects.toThrow(
      DeckConfinementError,
    );
  });

  it('searches committed cards only, whatever the caller asks for', async () => {
    const { repos, shared, view } = await setup();
    expect(
      await repos.cardIndex.searchCardsInDeck(shared.id, 'mystic', 5, { includeWorking: true }),
    ).toHaveLength(1);
    expect(await view.cardIndex.searchCardsInDeck(shared.id, 'mystic', 5, { includeWorking: true })).toEqual(
      [],
    );
    expect(await view.cardIndex.searchCardsInDeck(shared.id, 'sol ring')).toHaveLength(1);
  });
});
