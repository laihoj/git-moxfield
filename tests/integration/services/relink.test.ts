/**
 * "Change Moxfield deck" and "Continue an existing deck's history": a deck the user deleted
 * on Moxfield and made again (under a new public id) keeps its history and continues with
 * the new Moxfield deck. Commit ids of earlier versions stay valid: a commit object's
 * `deck` header records the deck reference at commit time.
 */
import { describe, expect, it } from 'vitest';

import { commitId } from '@/core/hash';
import { isServiceError } from '@/server/services';
import { countRows } from '@tests/support/db';
import { buildCaptureEnvelope } from '@tests/support/moxfield-deck-builder';
import {
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

const LOST = blueFarmSpec({ publicId: 'LostDeckOriginal000001', name: 'Lost deck' });
/** The same deck made again on Moxfield: same cards, a new public (and internal) id. */
const RECREATED = blueFarmSpec({ publicId: 'LostDeckRecreated00002', name: 'Lost deck' });
const RECREATED_URL = `https://moxfield.com/decks/${RECREATED.publicId}`;

/** Tracks the Lost deck, commits v1, then deletes the deck on Moxfield and makes it again. */
async function lostDeck(harness: ServiceHarness): Promise<{ deckId: string; v1: string }> {
  const deckId = await trackDeck(harness, LOST);
  const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));
  harness.api.decks.delete(LOST.publicId);
  harness.api.setDeck(RECREATED);
  harness.clock.advance(60);
  return { deckId, v1: v1.commitId };
}

function serviceErrorMatching(code: 'not-found' | 'invalid-input', message?: RegExp) {
  return (error: unknown): boolean =>
    isServiceError(error, code) && (message === undefined || message.test(error.message));
}

describe('deck services: changing the Moxfield deck', () => {
  it('continues a deck deleted on Moxfield with its new copy, keeping every version', async () => {
    const harness = await createServiceHarness();
    const { services, repos, clock } = harness;
    const { deckId, v1 } = await lostDeck(harness);
    // The old deck is gone: fetching it fails.
    const missing = await services.refresh(deckId);
    expect(missing).toMatchObject({ ok: false, error: { code: 'not-found' } });
    clock.advance(60);

    const relinkedAt = clock.iso();
    const outcome = await services.relinkDeck(deckId, RECREATED_URL);
    expect(outcome).toEqual({
      ok: true,
      externalId: RECREATED.publicId,
      url: RECREATED_URL,
      // Server fetch is available, so the new deck is fetched right away, as when tracking.
      fetch: { ok: true, observationId: expect.any(String) as unknown, changedSinceLastObservation: true },
    });

    const overview = defined(await services.getOverview(deckId));
    expect(overview).toMatchObject({
      id: deckId,
      externalId: RECREATED.publicId,
      url: RECREATED_URL,
      name: 'Lost deck',
      // The new copy has the same cards as v1.
      status: 'clean',
      head: { commitId: v1, sequence: 1 },
      versionCount: 1,
      lastFetchError: null,
      relinks: [
        {
          previousExternalId: LOST.publicId,
          previousUrl: `https://moxfield.com/decks/${LOST.publicId}`,
          externalId: RECREATED.publicId,
          url: RECREATED_URL,
          at: relinkedAt,
        },
      ],
    });
    expect(harness.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'Deck relinked',
        context: {
          deckId,
          source: 'moxfield',
          previousExternalId: LOST.publicId,
          externalId: RECREATED.publicId,
        },
      }),
    );

    // New versions are committed under the new reference, on top of the old history.
    await publishAndRefresh(
      harness,
      deckId,
      moveCard({ ...RECREATED, version: 2 }, 'Dress Down', 'mainboard', 'considering'),
    );
    const v2 = committed(await commitReviewed(harness, deckId, 'Cut Dress Down'));
    const stored = defined(await repos.commits.getById(v2.commitId));
    expect(stored).toMatchObject({ sequence: 2, parentId: v1 });
    expect(stored.id).toBe(
      commitId({
        deck: `moxfield:${RECREATED.publicId}`,
        snapshotHash: stored.snapshotHash,
        parentId: v1,
        createdAt: stored.createdAt,
        sourceVersion: stored.sourceVersion,
        message: 'Cut Dress Down',
      }),
    );
    // v1 still hashes the reference it was committed under.
    const first = defined(await repos.commits.getById(v1));
    expect(first.id).toBe(
      commitId({
        deck: `moxfield:${LOST.publicId}`,
        snapshotHash: first.snapshotHash,
        parentId: null,
        createdAt: first.createdAt,
        sourceVersion: first.sourceVersion,
        message: first.message,
      }),
    );
    const compare = defined(await services.compare(deckId, 'v1', 'v2'));
    expect(compare.diff.changes).toEqual([
      expect.objectContaining({ type: 'moved', name: 'Dress Down', from: 'mainboard', to: 'considering' }),
    ]);
    const history = defined(await services.cardHistory(deckId, 'Dress Down', { includeWorking: false }));
    // The card's history spans both Moxfield decks.
    expect(history.history.entries.map((entry) => [entry.sequence, entry.transition])).toEqual([
      [1, 'first-seen'],
      [2, 'moved'],
    ]);
  });

  it('drops the old Moxfield deck’s working state when the new one cannot be fetched', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, db } = harness;
    const deckId = defined(
      await services.ingestCapture({
        data: buildCaptureEnvelope(LOST),
        method: 'browser-capture',
        track: true,
      }),
    );
    if (deckId.status !== 'ingested') throw new Error('not ingested');
    committed(await commitReviewed(harness, deckId.deckId, 'Initial version'));
    // A later capture of the old deck that was never committed.
    await services.ingestCapture({
      data: buildCaptureEnvelope(moveCard({ ...LOST, version: 2 }, 'Dress Down', 'mainboard', 'considering')),
      method: 'browser-capture',
      track: false,
    });
    expect(defined(await services.getOverview(deckId.deckId)).status).toBe('uncommitted');
    const snapshotsBefore = await countRows(db, 'snapshots');

    const outcome = await services.relinkDeck(deckId.deckId, RECREATED.publicId);
    expect(outcome).toEqual({ ok: true, externalId: RECREATED.publicId, url: RECREATED_URL, fetch: null });
    const overview = defined(await services.getOverview(deckId.deckId));
    // The old deck's captures must never be committed as the new deck's.
    expect(overview).toMatchObject({ status: 'never-fetched', working: null, diff: null, versionCount: 1 });
    expect(await countRows(db, 'observations')).toBe(0);
    // Only v1's snapshot is left: the uncommitted capture's went with its observation.
    expect(await countRows(db, 'snapshots')).toBe(snapshotsBefore - 1);
    const commit = await services.commit(deckId.deckId, {
      message: 'Too early',
      expectedObservationId: 'anything',
      expectedHeadCommitId: overview.head?.commitId ?? null,
    });
    expect(commit).toMatchObject({ ok: false, reason: 'no-working-state' });
  });

  it('refuses an invalid reference and the deck’s own Moxfield deck', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const { deckId } = await lostDeck(harness);
    expect(await services.relinkDeck(deckId, 'https://example.com/decks/abc')).toMatchObject({
      ok: false,
      reason: 'invalid-ref',
    });
    expect(await services.relinkDeck(deckId, `https://moxfield.com/decks/${LOST.publicId}`)).toEqual({
      ok: false,
      reason: 'unchanged',
      message: 'This deck already follows that Moxfield deck.',
    });
    expect(defined(await services.getOverview(deckId)).relinks).toEqual([]);
  });

  it('refuses a Moxfield deck that another deck of the workspace tracks, saying how to proceed', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const { deckId } = await lostDeck(harness);
    // The new copy was tracked as a deck of its own (e.g. by the same-tab bookmarklet).
    const copyId = await trackDeck(harness, RECREATED);

    const outcome = await services.relinkDeck(deckId, RECREATED_URL);
    expect(outcome).toEqual({
      ok: false,
      reason: 'already-tracked',
      message:
        'Your deck “Lost deck” already tracks that Moxfield deck. To continue this deck’s history with ' +
        'it instead, stop tracking “Lost deck” first (it has no versions, so nothing is lost), then try again.',
      trackedBy: { deckId: copyId, name: 'Lost deck', versionCount: 0 },
    });
    expect(defined(await services.getOverview(deckId)).externalId).toBe(LOST.publicId);

    // Following the advice works.
    await services.untrackDeck(copyId);
    expect(await services.relinkDeck(deckId, RECREATED_URL)).toMatchObject({ ok: true });
  });

  it('works within the workspace only', async () => {
    const harness = await createServiceHarness();
    const { deckId } = await lostDeck(harness);
    const mikko = await harness.createUser('Mikko');
    // Another user's deck is not found…
    await expect(mikko.services.relinkDeck(deckId, RECREATED_URL)).rejects.toSatisfy(
      serviceErrorMatching('not-found'),
    );
    // …and another user tracking the new Moxfield deck does not matter.
    harness.api.setDeck(RECREATED);
    expect(await mikko.services.trackDeck(RECREATED_URL)).toMatchObject({ ok: true });
    expect(await harness.services.relinkDeck(deckId, RECREATED_URL)).toMatchObject({ ok: true });
  });

  it('forgets the record of changes when the deck is untracked', async () => {
    const harness = await createServiceHarness();
    const { deckId } = await lostDeck(harness);
    expect(await harness.services.relinkDeck(deckId, RECREATED_URL)).toMatchObject({ ok: true });
    expect(await countRows(harness.db, 'deck_relinks')).toBe(1);
    await harness.services.untrackDeck(deckId);
    expect(await countRows(harness.db, 'deck_relinks')).toBe(0);
  });
});

describe('deck services: continuing a deck’s history with a captured deck', () => {
  it('offers the workspace’s decks for an untracked capture and continues the chosen one', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, clock } = harness;
    const tracked = await services.ingestCapture({
      data: buildCaptureEnvelope(LOST),
      method: 'browser-capture',
      track: true,
    });
    if (tracked.status !== 'ingested') throw new Error('not ingested');
    const { deckId } = tracked;
    const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));
    clock.advance(60);

    const recreated = buildCaptureEnvelope(moveCard(RECREATED, 'Dress Down', 'mainboard', 'considering'));
    const untracked = await services.ingestCapture({
      data: recreated,
      method: 'browser-capture',
      track: false,
    });
    expect(untracked).toEqual({
      status: 'untracked',
      source: 'moxfield',
      externalId: RECREATED.publicId,
      name: 'Lost deck',
      decks: [
        {
          id: deckId,
          name: 'Lost deck',
          externalId: LOST.publicId,
          format: 'commander',
          versionCount: 1,
          updatedAt: expect.any(String) as unknown,
        },
      ],
    });

    const continued = await services.ingestCapture({
      data: recreated,
      method: 'browser-capture',
      track: false,
      relinkDeckId: deckId,
    });
    expect(continued).toEqual({ status: 'ingested', deckId, changedSinceLastObservation: true });
    const overview = defined(await services.getOverview(deckId));
    expect(overview).toMatchObject({
      externalId: RECREATED.publicId,
      url: RECREATED_URL,
      status: 'uncommitted',
      head: { commitId: v1.commitId },
      working: { method: 'browser-capture' },
      relinks: [{ previousExternalId: LOST.publicId, externalId: RECREATED.publicId }],
    });
    expect(defined(overview.diff).changes).toEqual([
      expect.objectContaining({ type: 'moved', name: 'Dress Down' }),
    ]);
    // No second deck was tracked.
    expect((await services.listDecks()).map((deck) => deck.id)).toEqual([deckId]);
    const v2 = committed(await commitReviewed(harness, deckId, 'Recreated on Moxfield'));
    expect(v2.sequence).toBe(2);

    // Later captures of the new deck are ordinary captures of the deck.
    const again = await services.ingestCapture({ data: recreated, method: 'browser-capture', track: false });
    expect(again).toEqual({ status: 'ingested', deckId, changedSinceLastObservation: false });
    // Continuing a deck with the Moxfield deck it already follows just ingests.
    expect(
      await services.ingestCapture({
        data: recreated,
        method: 'browser-capture',
        track: false,
        relinkDeckId: deckId,
      }),
    ).toEqual({ status: 'ingested', deckId, changedSinceLastObservation: false });
    expect(defined(await services.getOverview(deckId)).relinks).toHaveLength(1);
  });

  it('refuses to continue a deck with a Moxfield deck another deck tracks, changing nothing', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, db } = harness;
    const capture = async (spec: typeof LOST) => {
      const outcome = await services.ingestCapture({
        data: buildCaptureEnvelope(spec),
        method: 'browser-capture',
        track: true,
      });
      if (outcome.status !== 'ingested') throw new Error('not ingested');
      return outcome.deckId;
    };
    const lostId = await capture(LOST);
    const copyId = await capture(RECREATED);
    const observations = await countRows(db, 'observations');

    await expect(
      services.ingestCapture({
        data: buildCaptureEnvelope(RECREATED),
        method: 'browser-capture',
        track: false,
        relinkDeckId: lostId,
      }),
    ).rejects.toSatisfy(serviceErrorMatching('invalid-input', /already tracks that Moxfield deck/));
    expect(defined(await services.getOverview(lostId)).externalId).toBe(LOST.publicId);
    expect(defined(await services.getOverview(copyId)).externalId).toBe(RECREATED.publicId);
    expect(await countRows(db, 'observations')).toBe(observations);
    expect(await countRows(db, 'deck_relinks')).toBe(0);
  });

  it('refuses to continue a deck that is not the workspace’s', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const mikko = await harness.createUser('Mikko');
    const theirs = await mikko.services.ingestCapture({
      data: buildCaptureEnvelope(LOST),
      method: 'browser-capture',
      track: true,
    });
    if (theirs.status !== 'ingested') throw new Error('not ingested');
    for (const relinkDeckId of [theirs.deckId, 'no-such-deck']) {
      await expect(
        harness.services.ingestCapture({
          data: buildCaptureEnvelope(RECREATED),
          method: 'browser-capture',
          track: false,
          relinkDeckId,
        }),
      ).rejects.toSatisfy(serviceErrorMatching('not-found'));
    }
    expect(await harness.services.listDecks()).toEqual([]);
    expect(defined(await mikko.services.getOverview(theirs.deckId)).externalId).toBe(LOST.publicId);
  });
});
