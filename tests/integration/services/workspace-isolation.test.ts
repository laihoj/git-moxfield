/**
 * Owner scope (ADR 0007): deck services bound to one user's workspace treat every deck,
 * version and observation of another workspace as nonexistent, for every method, and
 * two users can track the same Moxfield deck independently.
 */
import { describe, expect, it } from 'vitest';

import type { DeckServices } from '@/server/services';
import { expectServiceError } from '@tests/support/auth';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import {
  BLUE_FARM_URL,
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  publishAndRefresh,
  trackDeck,
  withDressDownCut,
  type HarnessUser,
  type ServiceHarness,
} from '@tests/support/services';

/** Alice tracks Blue Farm with one version (tagged, with a note) and uncommitted changes. */
async function aliceWithHistory(harness: ServiceHarness): Promise<{ alice: HarnessUser; deckId: string }> {
  const alice = await harness.createUser('Alice');
  const deckId = await trackDeck(harness, blueFarmSpec(), alice.services);
  committed(await commitReviewed(harness, deckId, 'First list', ['tournament'], alice.services));
  await alice.services.setNote(deckId, 1, 'Top 4 at the local');
  await publishAndRefresh(harness, deckId, withDressDownCut(), alice.services);
  return { alice, deckId };
}

describe('deck services: workspace isolation', () => {
  it('treats another workspace’s deck as nonexistent in every read', async () => {
    const harness = await createServiceHarness();
    const { deckId } = await aliceWithHistory(harness);
    const bob = (await harness.createUser('Bob')).services;

    expect(await bob.listDecks()).toEqual([]);
    expect(await bob.getOverview(deckId)).toBeNull();
    expect(await bob.listVersions(deckId)).toEqual([]);
    expect(await bob.listVersions(deckId, { tag: 'tournament' })).toEqual([]);
    expect(await bob.getVersion(deckId, 1)).toBeNull();
    expect(await bob.compare(deckId, 'v1', 'working')).toBeNull();
    expect(await bob.compare(deckId, 'empty', 'head')).toBeNull();
    expect(await bob.searchCards(deckId, 'dress')).toEqual([]);
    expect(await bob.cardHistory(deckId, 'Dress Down')).toBeNull();
    expect(await bob.restoreExport(deckId, 1)).toBeNull();
    expect(await bob.listTags(deckId)).toEqual([]);
  });

  it('refuses every write to another workspace’s deck and leaves it untouched', async () => {
    const harness = await createServiceHarness();
    const { alice, deckId } = await aliceWithHistory(harness);
    const bob = (await harness.createUser('Bob')).services;
    const before = defined(await alice.services.getOverview(deckId));
    const working = defined(before.working);

    await expectServiceError(bob.refresh(deckId), 'not-found');
    await expectServiceError(
      bob.commit(deckId, {
        message: 'Hijack',
        expectedObservationId: working.id,
        expectedHeadCommitId: before.head?.commitId ?? null,
      }),
      'not-found',
    );
    expect(await bob.addTag(deckId, 1, 'stolen')).toEqual({
      ok: false,
      message: 'Version v1 does not exist.',
    });
    expect(await bob.removeTag(deckId, 1, 'tournament')).toEqual({
      ok: false,
      message: 'Version v1 does not exist.',
    });
    await expectServiceError(bob.setNote(deckId, 1, 'Overwritten'), 'not-found');
    await bob.untrackDeck(deckId);

    const after = defined(await alice.services.getOverview(deckId));
    expect(after).toEqual(before);
    expect((await alice.services.listVersions(deckId)).map((version) => version.tags)).toEqual([
      ['tournament'],
    ]);
    expect(defined(await alice.services.getVersion(deckId, 1)).notes).toEqual([
      expect.objectContaining({ data: { text: 'Top 4 at the local' } }),
    ]);
  });

  it('cannot commit another workspace’s reviewed observation on its own deck', async () => {
    const harness = await createServiceHarness();
    const { alice, deckId } = await aliceWithHistory(harness);
    const bob = await harness.createUser('Bob');
    const bobDeck = await bob.services.trackDeck(BLUE_FARM_URL);
    if (!bobDeck.ok) throw new Error(bobDeck.reason);
    const alicesObservation = defined(defined(await alice.services.getOverview(deckId)).working);
    // Bob's deck has a working state of its own, so the only problem is the foreign id.
    expect(defined(await bob.services.getOverview(bobDeck.deckId)).working).not.toBeNull();

    const outcome = await bob.services.commit(bobDeck.deckId, {
      message: 'Borrowed review',
      expectedObservationId: alicesObservation.id,
      expectedHeadCommitId: null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale' });
    expect(await bob.services.listVersions(bobDeck.deckId)).toEqual([]);
  });

  it('lets two users track and capture the same Moxfield deck independently', async () => {
    const harness = await createServiceHarness();
    const { alice, deckId } = await aliceWithHistory(harness);
    const bob = (await harness.createUser('Bob')).services;
    const envelope = buildCaptureEnvelope(withDressDownCut());

    // Alice tracks it; for Bob it is untracked.
    expect(
      await bob.ingestCapture({ data: envelope, method: 'browser-capture', track: false }),
    ).toMatchObject({
      status: 'untracked',
    });
    const captured = await bob.ingestCapture({ data: envelope, method: 'browser-capture', track: true });
    if (captured.status !== 'ingested') throw new Error('not ingested');
    expect(captured.deckId).not.toBe(deckId);

    const tracked = await bob.trackDeck(BLUE_FARM_URL);
    expect(tracked).toMatchObject({ ok: true, deckId: captured.deckId, alreadyTracked: true });
    expect((await bob.listDecks()).map((deck) => deck.id)).toEqual([captured.deckId]);
    expect((await alice.services.listDecks()).map((deck) => deck.id)).toEqual([deckId]);

    // Bob's history starts at v1, Alice's continues at v2.
    harness.clock.advance(5);
    expect(
      committed(await commitReviewed(harness, captured.deckId, 'My take', undefined, bob)).sequence,
    ).toBe(1);
    expect(
      committed(await commitReviewed(harness, deckId, 'Moved Dress Down', undefined, alice.services))
        .sequence,
    ).toBe(2);
    expect(await alice.services.listVersions(deckId)).toHaveLength(2);
    expect(await bob.listVersions(captured.deckId)).toHaveLength(1);
  });

  it('keeps the card facts a workspace captures to itself, so a crafted paste changes nobody else’s view', async () => {
    const harness = await createServiceHarness();
    const { alice, deckId } = await aliceWithHistory(harness);
    const solRingFacts = async () => {
      const version = defined(await alice.services.getVersion(deckId, 1));
      const key = defined(Object.keys(version.catalog).find((k) => version.catalog[k]?.name === 'Sol Ring'));
      return {
        key,
        version: version.catalog[key],
        overview: defined(await alice.services.getOverview(deckId)).catalog[key],
        compare: defined(await alice.services.compare(deckId, 'empty', '1')).catalog[key],
        search: (await alice.services.searchCards(deckId, 'sol ring')).find((hit) => hit.key === key)?.facts,
        history: defined(await alice.services.cardHistory(deckId, 'Sol Ring')).facts,
      };
    };
    const before = await solRingFacts();
    expect(before.version).toMatchObject({ typeLine: 'Artifact', primaryType: 'Artifact', manaCost: '{1}' });
    expect(before.history).toEqual(before.version);
    expect(before.search).toEqual(before.version);

    // Eve, in her own workspace, pastes a deck with a crafted Sol Ring, then untracks it.
    const eve = (await harness.createUser('Eve')).services;
    const crafted = blueFarmSpec({
      publicId: 'EvilFarmTestDeck000001',
      name: 'Evil Farm',
      mainboard: [
        {
          name: 'Sol Ring',
          typeLine: 'Basic Land — Swamp',
          manaCost: '{B}{B}{B}{B}{B}{B}{B}',
          set: 'evl',
          collectorNumber: '666',
        },
      ],
    });
    const pasted = await eve.ingestCapture({
      data: buildCaptureEnvelope(crafted),
      method: 'manual-paste',
      track: true,
    });
    if (pasted.status !== 'ingested') throw new Error('not ingested');
    const evesView = defined(await eve.getOverview(pasted.deckId));
    expect(evesView.catalog[before.key]).toMatchObject({ primaryType: 'Land', cmc: 7 });
    await eve.untrackDeck(pasted.deckId);

    expect(await solRingFacts()).toEqual(before);
  });

  it('survives two users committing identical first versions in the same millisecond', async () => {
    // Commit ids are content-addressed by Moxfield deck, snapshot, parent, time and
    // message, so this one collision is possible across users. It is reported like a
    // concurrent commit, and committing again (a new time) succeeds.
    const harness = await createServiceHarness();
    harness.api.setDeck(blueFarmSpec());
    const alice = (await harness.createUser('Alice')).services;
    const bob = (await harness.createUser('Bob')).services;
    const a = await alice.trackDeck(BLUE_FARM_URL);
    const b = await bob.trackDeck(BLUE_FARM_URL);
    if (!a.ok || !b.ok) throw new Error('not tracked');
    const review = async (services: DeckServices, deckId: string) =>
      defined(defined(await services.getOverview(deckId)).working).id;
    const input = async (services: DeckServices, deckId: string) => ({
      message: 'Initial version',
      expectedObservationId: await review(services, deckId),
      expectedHeadCommitId: null,
    });
    const aliceInput = await input(alice, a.deckId);
    const bobInput = await input(bob, b.deckId);

    expect(await alice.commit(a.deckId, aliceInput)).toMatchObject({ ok: true });
    expect(await bob.commit(b.deckId, bobInput)).toMatchObject({ ok: false, reason: 'head-moved' });
    harness.clock.advance(1);
    expect(await bob.commit(b.deckId, bobInput)).toMatchObject({ ok: true, version: { sequence: 1 } });
  });
});
