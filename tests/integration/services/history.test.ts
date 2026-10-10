import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { allCards } from '@/core/canonical';
import { diffSnapshots } from '@/core/diff';
import type { VersionRefDTO } from '@/server/services';
import { buildCaptureEnvelope, type MoxDeckSpec } from '@tests/support/moxfield-deck-builder';
import {
  BLUE_FARM_PRIMER,
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
  type ServiceHarness,
} from '@tests/support/services';

/**
 * History used by every test:
 *   v1  base deck (Dress Down in the mainboard)
 *   v2  Dress Down → Considering, primer edit
 *   v3  + Final Fortune (Dress Down stays in Considering)
 *   v4  Dress Down back to the mainboard (restored), Final Fortune cut
 *   working (uncommitted): Dress Down → Sideboard, + Grim Tutor
 */
async function buildHistory(harness: ServiceHarness): Promise<{ deckId: string; versions: VersionRefDTO[] }> {
  const deckId = await trackDeck(harness);
  const versions = [committed(await commitReviewed(harness, deckId, 'Initial version', ['tournament']))];

  const v2 = {
    ...moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'),
    primer: BLUE_FARM_PRIMER.replace('Keep fast mana and a tutor.', 'Keep any hand with a tutor.'),
  };
  await publishAndRefresh(harness, deckId, v2);
  versions.push(committed(await commitReviewed(harness, deckId, 'Cut Dress Down')));

  const v3 = { ...v2, version: 3, mainboard: [...(v2.mainboard ?? []), 'Final Fortune'] };
  await publishAndRefresh(harness, deckId, v3);
  versions.push(committed(await commitReviewed(harness, deckId, 'Add Final Fortune', ['testing'])));

  const v4 = {
    ...moveCard(v3, 'Dress Down', 'considering', 'mainboard'),
    version: 4,
  };
  v4.mainboard = (v4.mainboard ?? []).filter((card) => card !== 'Final Fortune');
  await publishAndRefresh(harness, deckId, v4);
  versions.push(committed(await commitReviewed(harness, deckId, 'Dress Down back in', ['tournament'])));

  const working = { ...moveCard(v4, 'Dress Down', 'mainboard', 'sideboard'), version: 5 };
  working.mainboard = [...(working.mainboard ?? []), 'Grim Tutor'];
  await publishAndRefresh(harness, deckId, working);
  return { deckId, versions };
}

describe('deck services: history', () => {
  let harness: ServiceHarness;
  let deckId: string;
  let versions: VersionRefDTO[];

  beforeEach(async () => {
    harness = await createServiceHarness();
    ({ deckId, versions } = await buildHistory(harness));
  });

  describe('listVersions', () => {
    it('lists versions newest first with stats relative to the parent', async () => {
      const list = await harness.services.listVersions(deckId);
      expect(list.map((item) => [item.sequence, item.parentSequence, item.message])).toEqual([
        [4, 3, 'Dress Down back in'],
        [3, 2, 'Add Final Fortune'],
        [2, 1, 'Cut Dress Down'],
        [1, null, 'Initial version'],
      ]);
      const [v4, v3, v2] = list;
      expect(v4?.stats).toMatchObject({
        zones: [
          { zone: 'mainboard', added: 0, removed: 1, movedIn: 1, movedOut: 0 },
          { zone: 'considering', added: 0, removed: 0, movedIn: 0, movedOut: 1 },
        ],
        moves: [{ from: 'considering', to: 'mainboard', quantity: 1, cards: 1 }],
      });
      expect(v3?.primer).toEqual({ status: 'unchanged' });
      expect(v2?.primer).toEqual({ status: 'changed', addedLines: 1, removedLines: 1 });
      expect(list.map((item) => item.tags)).toEqual([['tournament'], ['testing'], [], ['tournament']]);
    });

    it('filters by normalized tag', async () => {
      const tagged = await harness.services.listVersions(deckId, { tag: ' Tournament ' });
      expect(tagged.map((item) => item.sequence)).toEqual([4, 1]);
      // Parent stats are still relative to the real parent, not the previous match.
      expect(tagged[0]?.parentSequence).toBe(3);
      expect(await harness.services.listVersions(deckId, { tag: 'nope' })).toEqual([]);
      expect(await harness.services.listVersions(deckId, { tag: '' })).toHaveLength(4);
    });
  });

  describe('getVersion', () => {
    it('returns a version with its snapshot, diff, primer diff, catalog and neighbours', async () => {
      const detail = defined(await harness.services.getVersion(deckId, 2));
      expect(detail.version).toMatchObject({ sequence: 2, parentSequence: 1, message: 'Cut Dress Down' });
      expect(detail.previous).toEqual(versions[0]);
      expect(detail.next).toEqual(versions[2]);
      expect(detail.sourceMetadata).toMatchObject({ source: 'moxfield', version: 2 });
      expect(detail.snapshot.zones.considering?.map((card) => card.name)).toContain('Dress Down');
      expect(detail.diff.changes).toEqual([
        expect.objectContaining({ type: 'moved', key: 'dress down', from: 'mainboard', to: 'considering' }),
      ]);
      expect(detail.primerDiff).toMatchObject({ addedLines: 1, removedLines: 1, unknown: false });
      expect(detail.primerDiff.hunks[0]?.lines).toContainEqual(
        expect.objectContaining({ type: 'add', text: 'Keep any hand with a tutor.' }),
      );
      expect(detail.notes).toEqual([]);
      expect(detail.deck).toMatchObject({ id: deckId, status: 'uncommitted', versionCount: 4 });
      for (const card of allCards(detail.snapshot)) {
        expect(detail.catalog[card.key]?.name).toBe(card.name);
      }
    });

    it('diffs the first version against the empty deck and the last one has no next', async () => {
      const first = defined(await harness.services.getVersion(deckId, 1));
      expect(first.previous).toBeNull();
      expect(first.diff.deck).toEqual([]);
      expect(first.diff.changes.every((change) => change.type === 'added')).toBe(true);
      expect(first.primerDiff).toMatchObject({ addedLines: 7, removedLines: 0 });

      const last = defined(await harness.services.getVersion(deckId, 4));
      expect(last.next).toBeNull();
      // A card removed by the version is in the catalog too.
      expect(last.catalog['final fortune']).toMatchObject({ name: 'Final Fortune' });

      expect(await harness.services.getVersion(deckId, 5)).toBeNull();
      expect(await harness.services.getVersion('missing', 1)).toBeNull();
    });
  });

  describe('compare', () => {
    it('compares two versions by any accepted reference', async () => {
      const result = defined(await harness.services.compare(deckId, 'v1', 'V2'));
      const v2 = defined(await harness.services.getVersion(deckId, 2));
      expect(result.from).toEqual({ kind: 'version', version: versions[0] });
      expect(result.to).toEqual({ kind: 'version', version: versions[1] });
      expect(result.diff).toEqual(v2.diff);
      expect(result.primerDiff).toEqual(v2.primerDiff);
      expect(result.versions.map((version) => version.sequence)).toEqual([4, 3, 2, 1]);
      expect(result.hasWorking).toBe(true);
      expect(result.catalog['dress down']).toBeDefined();

      const v1 = defined(versions[0]);
      expect((await harness.services.compare(deckId, ' 1 ', v1.shortId.toUpperCase()))?.diff.isEmpty).toBe(
        true,
      );
      expect((await harness.services.compare(deckId, v1.commitId, 'v2'))?.diff).toEqual(v2.diff);
    });

    it('compares versions with the working state', async () => {
      const overview = defined(await harness.services.getOverview(deckId));
      const headToWorking = defined(await harness.services.compare(deckId, 'head', 'working'));
      expect(headToWorking.from).toEqual({ kind: 'version', version: versions[3] });
      expect(headToWorking.to).toEqual({ kind: 'working', observation: overview.working });
      expect(headToWorking.diff).toEqual(overview.diff);

      const v1ToWorking = defined(await harness.services.compare(deckId, 'v1', 'working'));
      expect(v1ToWorking.diff.changes).toEqual([
        expect.objectContaining({ type: 'moved', key: 'dress down', from: 'mainboard', to: 'sideboard' }),
        expect.objectContaining({ type: 'added', key: 'grim tutor', zone: 'mainboard' }),
      ]);
      expect(v1ToWorking.diff.primer).toEqual({ status: 'changed', addedLines: 1, removedLines: 1 });
    });

    it('compares with the empty deck without deck-info noise', async () => {
      const fromEmpty = defined(await harness.services.compare(deckId, 'empty', 'v1'));
      expect(fromEmpty.from).toEqual({ kind: 'empty' });
      expect(fromEmpty.diff.deck).toEqual([]);
      expect(fromEmpty.diff).toEqual(defined(await harness.services.getVersion(deckId, 1)).diff);

      const toEmpty = defined(await harness.services.compare(deckId, 'v1', 'empty'));
      expect(toEmpty.diff.deck).toEqual([]);
      expect(toEmpty.diff.changes.every((change) => change.type === 'removed')).toBe(true);

      expect(defined(await harness.services.compare(deckId, 'empty', 'empty')).diff.isEmpty).toBe(true);
    });

    it('returns null for references that do not resolve', async () => {
      for (const ref of ['v99', '0', 'v0', 'nope', 'abc', '', 'ffffffff']) {
        expect(await harness.services.compare(deckId, ref, 'head')).toBeNull();
      }
      expect(await harness.services.compare('missing', 'v1', 'v2')).toBeNull();

      // A deck without observations has no working state.
      const fresh = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
      const freshDeck = await trackDeck(fresh);
      expect(await fresh.services.compare(freshDeck, 'empty', 'working')).toBeNull();
      expect(await fresh.services.compare(freshDeck, 'empty', 'head')).toBeNull();
    });
  });

  describe('cardHistory', () => {
    it('derives the history of Dress Down across versions and the working state', async () => {
      const result = defined(await harness.services.cardHistory(deckId, 'Dress Down'));
      const { history } = result;
      expect(history.key).toBe('dress down');
      expect(history.name).toBe('Dress Down');
      expect(history.entries.map((entry) => [entry.sequence, entry.transition, entry.zones])).toEqual([
        [1, 'first-seen', [{ zone: 'mainboard', quantity: 1 }]],
        [2, 'moved', [{ zone: 'considering', quantity: 1 }]],
        [3, 'unchanged', [{ zone: 'considering', quantity: 1 }]],
        [4, 'restored', [{ zone: 'mainboard', quantity: 1 }]],
        [null, 'moved', [{ zone: 'sideboard', quantity: 1 }]],
      ]);
      expect(history.entries[3]?.restoredFrom).toEqual([{ zone: 'mainboard', lastSequence: 1 }]);
      expect(history.entries[4]).toMatchObject({ commitId: null, message: 'Current Moxfield deck' });
      expect(history.summary).toEqual({
        firstSeenSequence: 1,
        lastSeenSequence: 4,
        currentZones: [{ zone: 'sideboard', quantity: 1 }],
        versionsInPlayedZones: 2,
        timesCut: 2,
        timesRestored: 1,
      });
      expect(result.facts).toMatchObject({ typeLine: 'Enchantment', manaCost: '{1}{U}' });
      expect(result.deck.id).toBe(deckId);

      // Card keys work as well as names.
      expect((await harness.services.cardHistory(deckId, 'dress down'))?.history).toEqual(history);
    });

    it('can leave out the working state', async () => {
      const result = defined(
        await harness.services.cardHistory(deckId, 'Dress Down', { includeWorking: false }),
      );
      expect(result.history.entries.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4]);
      expect(result.history.summary.currentZones).toEqual([{ zone: 'mainboard', quantity: 1 }]);
    });

    it('covers cards that exist only in the working state, and returns null for unknown cards', async () => {
      const grim = defined(await harness.services.cardHistory(deckId, 'Grim Tutor'));
      expect(grim.history.entries.map((entry) => entry.transition)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
        'unchanged',
        'added',
      ]);
      expect(await harness.services.cardHistory(deckId, 'Grim Tutor', { includeWorking: false })).toBeNull();
      expect(await harness.services.cardHistory(deckId, 'Black Lotus')).toBeNull();
      expect(await harness.services.cardHistory(deckId, '   ')).toBeNull();
      expect(await harness.services.cardHistory('missing', 'Dress Down')).toBeNull();
    });
  });

  describe('searchCards', () => {
    it('finds cards across versions and the working state with their zones in HEAD', async () => {
      expect(await harness.services.searchCards(deckId, 'dress')).toEqual([
        {
          key: 'dress down',
          name: 'Dress Down',
          headZones: [{ zone: 'mainboard', quantity: 1 }],
          versionsPresent: 4,
          lastSeenSequence: 4,
          facts: expect.objectContaining({
            key: 'dress down',
            name: 'Dress Down',
            typeLine: 'Enchantment',
            manaCost: '{1}{U}',
          }) as unknown,
        },
      ]);
      expect(await harness.services.searchCards(deckId, 'final fort')).toEqual([
        {
          key: 'final fortune',
          name: 'Final Fortune',
          headZones: [],
          versionsPresent: 1,
          lastSeenSequence: 3,
          facts: expect.objectContaining({ typeLine: 'Instant', manaCost: '{R}{R}' }) as unknown,
        },
      ]);
      expect(await harness.services.searchCards(deckId, 'grim')).toEqual([
        {
          key: 'grim tutor',
          name: 'Grim Tutor',
          headZones: [],
          versionsPresent: 0,
          lastSeenSequence: null,
          facts: expect.objectContaining({ name: 'Grim Tutor' }) as unknown,
        },
      ]);
      expect(await harness.services.searchCards(deckId, 'tutor', 1)).toHaveLength(1);
      expect(await harness.services.searchCards(deckId, '')).toEqual([]);
      expect(await harness.services.searchCards('missing', 'dress')).toEqual([]);
    });

    it('reports null facts for cards missing from the catalog', async () => {
      await harness.db.run(sql`DELETE FROM card_catalog WHERE key = ${'grim tutor'}`);
      const [grimTutor] = await harness.services.searchCards(deckId, 'grim');
      expect(grimTutor).toMatchObject({ key: 'grim tutor', facts: null });
    });
  });

  describe('restoreExport', () => {
    it('exports a version as Moxfield bulk edit sections', async () => {
      const restore = defined(await harness.services.restoreExport(deckId, 2));
      expect(restore.version).toEqual(versions[1]);
      expect(restore.deck.id).toBe(deckId);
      expect(restore.export.source).toBe('moxfield');
      const sections = new Map(restore.export.sections.map((section) => [section.zone, section]));
      expect([...sections.keys()]).toEqual(['commanders', 'mainboard', 'sideboard', 'considering']);
      expect(sections.get('mainboard')?.cardCount).toBe(12);
      expect(sections.get('mainboard')?.text).not.toContain('Dress Down');
      expect(sections.get('considering')?.text).toMatch(/^1 Dress Down \(TST\) \S+$/m);
      expect(sections.get('commanders')?.text).toContain('Tymna the Weaver');
      expect(restore.export.instructions.length).toBeGreaterThan(0);
      expect(await harness.services.restoreExport(deckId, 9)).toBeNull();
    });
  });

  it('agrees with the core diff for every consecutive pair of versions', async () => {
    for (let sequence = 2; sequence <= 4; sequence++) {
      const before = defined(await harness.services.getVersion(deckId, sequence - 1)).snapshot;
      const after = defined(await harness.services.getVersion(deckId, sequence));
      expect(after.diff).toEqual(diffSnapshots(before, after.snapshot));
    }
  });
});

describe('deck services: card history across renames', () => {
  type CardEntries = Record<string, { card: { name: string; uniqueCardId: string } }>;

  /** Board entries of a capture envelope's deck payload. */
  function boardEntries(
    envelope: Record<string, unknown>,
  ): { card: { name: string; uniqueCardId: string } }[] {
    const deck = envelope.deck as { boards: Record<string, { cards: CardEntries }> };
    return Object.values(deck.boards).flatMap((board) => Object.values(board.cards));
  }

  /**
   * v1 Æther Vial in the mainboard, v2 + Grim Tutor, v3 the oracle rename to Aether Vial
   * (same Moxfield card id), working state: Aether Vial moved to the sideboard.
   */
  async function renameHistory(harness: ServiceHarness): Promise<string> {
    // Same printing under both names, so the rename is the only change to the card.
    const oldVial = { name: 'Æther Vial', collectorNumber: '42' };
    const newVial = { name: 'Aether Vial', collectorNumber: '42' };
    const base = blueFarmSpec();
    const v1: MoxDeckSpec = { ...base, mainboard: [...(base.mainboard ?? []), oldVial] };
    const vialId = boardEntries(buildCaptureEnvelope(v1)).find((entry) => entry.card.name === 'Æther Vial')
      ?.card.uniqueCardId;
    const capture = async (spec: MoxDeckSpec): Promise<string> => {
      const envelope = buildCaptureEnvelope(spec);
      for (const entry of boardEntries(envelope)) {
        if (entry.card.name === 'Aether Vial') entry.card.uniqueCardId = defined(vialId, 'vial id');
      }
      harness.clock.advance(60);
      const outcome = await harness.services.ingestCapture({
        data: envelope,
        method: 'browser-capture',
        track: true,
      });
      if (outcome.status !== 'ingested') throw new Error(`Capture failed: ${outcome.status}`);
      return outcome.deckId;
    };

    const deckId = await capture(v1);
    committed(await commitReviewed(harness, deckId, 'Initial version'));
    const v2 = { ...v1, version: 2, mainboard: [...(v1.mainboard ?? []), 'Grim Tutor'] };
    await capture(v2);
    committed(await commitReviewed(harness, deckId, 'Add Grim Tutor'));
    const v3 = {
      ...v2,
      version: 3,
      mainboard: v2.mainboard.map((c) => (c === oldVial ? newVial : c)),
    };
    await capture(v3);
    committed(await commitReviewed(harness, deckId, 'Oracle update'));
    await capture({ ...moveCard(v3, 'Aether Vial', 'mainboard', 'sideboard'), version: 4 });
    return deckId;
  }

  it('follows a renamed card with one history under either name, as the diff does', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const deckId = await renameHistory(harness);
    expect(
      defined(await harness.services.getVersion(deckId, 3)).diff.changes.filter((c) =>
        c.key.includes('vial'),
      ),
    ).toEqual([expect.objectContaining({ type: 'renamed', key: 'aether vial', previousName: 'Æther Vial' })]);

    const byNewName = defined(await harness.services.cardHistory(deckId, 'Aether Vial')).history;
    const byOldName = defined(await harness.services.cardHistory(deckId, 'Æther Vial')).history;
    expect(byOldName).toEqual(byNewName);
    expect(byNewName.key).toBe('aether vial');
    expect(byNewName.name).toBe('Aether Vial');
    expect(
      byNewName.entries.map((entry) => [entry.sequence, entry.transition, entry.zones, entry.renamedFrom]),
    ).toEqual([
      [1, 'first-seen', [{ zone: 'mainboard', quantity: 1 }], undefined],
      [2, 'unchanged', [{ zone: 'mainboard', quantity: 1 }], undefined],
      [3, 'unchanged', [{ zone: 'mainboard', quantity: 1 }], { key: 'æther vial', name: 'Æther Vial' }],
      [null, 'moved', [{ zone: 'sideboard', quantity: 1 }], undefined],
    ]);
    expect(byNewName.changes.map((entry) => entry.sequence)).toEqual([1, 3, null]);
    expect(byNewName.summary).toEqual({
      firstSeenSequence: 1,
      lastSeenSequence: 3,
      currentZones: [{ zone: 'sideboard', quantity: 1 }],
      versionsInPlayedZones: 3,
      timesCut: 1,
      timesRestored: 0,
    });
  });

  it('keeps an ambiguous rename a removal and an addition, like the diff', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const base = blueFarmSpec();
    const envelope = (spec: MoxDeckSpec, sharedIdFrom?: string): Record<string, unknown> => {
      const built = buildCaptureEnvelope(spec);
      if (sharedIdFrom !== undefined) {
        const entries = boardEntries(built);
        const id = defined(entries.find((entry) => entry.card.name === sharedIdFrom)).card.uniqueCardId;
        for (const entry of entries)
          if (entry.card.name.startsWith('Aether Vial')) entry.card.uniqueCardId = id;
      }
      return built;
    };
    const v1: MoxDeckSpec = { ...base, mainboard: [...(base.mainboard ?? []), 'Æther Vial'] };
    const first = await harness.services.ingestCapture({
      data: envelope(v1),
      method: 'browser-capture',
      track: true,
    });
    if (first.status !== 'ingested') throw new Error('not ingested');
    committed(await commitReviewed(harness, first.deckId, 'Initial version'));
    // Two cards now share Æther Vial's id: the diff cannot tell which one it became.
    const v2: MoxDeckSpec = {
      ...base,
      version: 2,
      mainboard: [...(base.mainboard ?? []), 'Æther Vial', 'Aether Vial', 'Aether Vial Token'],
    };
    const shared = envelope(v2, 'Æther Vial');
    const sharedEntries = boardEntries(shared).filter((entry) => entry.card.name !== 'Æther Vial');
    const withoutOld = { ...v2, mainboard: (v2.mainboard ?? []).filter((c) => c !== 'Æther Vial') };
    const data = envelope(withoutOld);
    for (const entry of boardEntries(data)) {
      const match = sharedEntries.find((candidate) => candidate.card.name === entry.card.name);
      if (match) entry.card.uniqueCardId = match.card.uniqueCardId;
    }
    harness.clock.advance(60);
    await harness.services.ingestCapture({ data, method: 'browser-capture', track: false });

    const old = defined(await harness.services.cardHistory(first.deckId, 'Æther Vial')).history;
    expect(old.entries.map((entry) => entry.transition)).toEqual(['first-seen', 'removed']);
    const renamed = defined(await harness.services.cardHistory(first.deckId, 'Aether Vial')).history;
    expect(renamed.entries.map((entry) => entry.transition)).toEqual(['unchanged', 'added']);
  });
});
