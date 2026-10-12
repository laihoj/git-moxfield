import { describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '@/server/repositories';
import { KeyedMutex, type DeckServices } from '@/server/services';
import { createDeckServices } from '@/server/services/deck-services';
import { countRows } from '@tests/support/db';
import { buildCaptureEnvelope, type MoxDeckSpec } from '@tests/support/moxfield-deck-builder';
import {
  BLUE_FARM_PRIMER,
  blueFarmSpec,
  captureNext,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
} from '@tests/support/services';

describe('deck services: commit', () => {
  it('rejects empty and overlong messages and invalid tags without touching anything', async () => {
    const harness = await createServiceHarness();
    const { services, api, db } = harness;
    const deckId = await trackDeck(harness);
    const overview = defined(await services.getOverview(deckId));
    const base = { expectedObservationId: defined(overview.working).id, expectedHeadCommitId: null };
    const requests = api.requests.length;

    expect(await services.commit(deckId, { ...base, message: ' \n\t ' })).toEqual({
      ok: false,
      reason: 'invalid-message',
      message: 'Write a commit message.',
    });
    expect(await services.commit(deckId, { ...base, message: 'x'.repeat(2001) })).toMatchObject({
      ok: false,
      reason: 'invalid-message',
      message: expect.stringContaining('2000') as unknown,
    });
    expect(await services.commit(deckId, { ...base, message: 'Fine', tags: ['ok', '#!?'] })).toMatchObject({
      ok: false,
      reason: 'invalid-message',
      message: expect.stringContaining('"#!?"') as unknown,
    });
    expect(api.requests).toHaveLength(requests);
    expect(await countRows(db, 'commits')).toBe(0);

    // Exactly 2000 characters is fine.
    expect(committed(await services.commit(deckId, { ...base, message: 'y'.repeat(2000) })).sequence).toBe(1);
  });

  it('refuses to commit before any Moxfield state is known', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const deckId = await trackDeck(harness);
    expect(
      await harness.services.commit(deckId, {
        message: 'v1',
        expectedObservationId: 'none',
        expectedHeadCommitId: null,
      }),
    ).toMatchObject({ ok: false, reason: 'no-working-state' });
  });

  it('refuses a stale review when fetch-on-commit finds new changes on Moxfield', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const reviewed = defined(await services.getOverview(deckId));

    // The deck is edited on Moxfield after the user reviewed it.
    api.setDeck(moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'));
    clock.advance(2); // well within the refresh cooldown: fetch on commit ignores it
    const outcome = await services.commit(deckId, {
      message: 'Initial version',
      expectedObservationId: defined(reviewed.working).id,
      expectedHeadCommitId: null,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'stale',
      message: expect.stringContaining('Review the new changes') as unknown,
    });

    // The fresh state is now the working state; committing it works.
    const again = defined(await services.getOverview(deckId));
    expect(again.working?.id).not.toBe(reviewed.working?.id);
    expect(again.working?.sourceVersion).toBe(2);
    expect(again.diff?.changes.find((change) => change.key === 'dress down')).toMatchObject({
      type: 'added',
      zone: 'considering',
    });
    expect(committed(await commitReviewed(harness, deckId, 'Initial version')).sourceVersion).toBe(2);
  });

  it('refuses a stale review when a newer capture differs from it', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, clock } = harness;
    const capture = (spec = blueFarmSpec()) =>
      services.ingestCapture({ data: buildCaptureEnvelope(spec), method: 'browser-capture', track: true });
    const first = await capture();
    if (first.status !== 'ingested') throw new Error('not ingested');
    const reviewed = defined(await services.getOverview(first.deckId));

    clock.advance(30);
    await capture(blueFarmSpec({ version: 2, considering: ['Mnemonic Betrayal'] }));
    expect(
      await services.commit(first.deckId, {
        message: 'v1',
        expectedObservationId: defined(reviewed.working).id,
        expectedHeadCommitId: null,
      }),
    ).toMatchObject({ ok: false, reason: 'stale' });

    // An unknown observation id is stale too.
    expect(
      await services.commit(first.deckId, {
        message: 'v1',
        expectedObservationId: 'does-not-exist',
        expectedHeadCommitId: null,
      }),
    ).toMatchObject({ ok: false, reason: 'stale' });
  });

  it('refuses a primer-less review once fetch-on-commit gets the primer, then versions primer edits', async () => {
    const harness = await createServiceHarness();
    const { services, api } = harness;
    // Tracked while the primer endpoint fails: the working state has no primer.
    api.mode = 'primer-down';
    const deckId = await trackDeck(harness);
    expect(defined(await services.getOverview(deckId)).diff?.primer).toEqual({ status: 'unknown' });

    // The primer is back when committing: committing the reviewed (primer-less) state
    // would drop the primer the server just fetched, so the review is stale.
    api.mode = 'ok';
    expect(await commitReviewed(harness, deckId, 'Initial version')).toMatchObject({
      ok: false,
      reason: 'stale',
      message: expect.stringContaining('primer') as unknown,
    });
    const reviewed = defined(await services.getOverview(deckId));
    expect(reviewed.warnings).toEqual([]);
    expect(committed(await commitReviewed(harness, deckId, 'Initial version')).sequence).toBe(1);
    expect(defined(await services.getVersion(deckId, 1)).snapshot.primer).toContain('# Blue Farm');

    // Later primer-only edits on Moxfield are uncommitted changes and can be committed.
    for (const [version, primer] of [
      [2, `${BLUE_FARM_PRIMER}\n\nP2`],
      [3, `${BLUE_FARM_PRIMER}\n\nP3`],
    ] as const) {
      await publishAndRefresh(harness, deckId, blueFarmSpec({ version, primer }));
      const overview = defined(await services.getOverview(deckId));
      expect(overview.status).toBe('uncommitted');
      expect(overview.diff?.primer).toMatchObject({ status: 'changed' });
      expect(committed(await commitReviewed(harness, deckId, `Primer ${version}`)).sequence).toBe(version);
    }
  });

  it('versions a primer captured after a version that has none', async () => {
    const harness = await createServiceHarness();
    const { services, api } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));

    // v2 cuts a card while the primer endpoint is down: v2 has no primer.
    api.mode = 'primer-down';
    const cut = blueFarmSpec({ version: 2, sideboard: [] });
    await publishAndRefresh(harness, deckId, cut);
    expect(committed(await commitReviewed(harness, deckId, 'Cut Pyroclasm')).sequence).toBe(2);
    expect(defined(await services.getVersion(deckId, 2)).snapshot.primer).toBeNull();

    // The primer was edited meanwhile and is available again; no card changed.
    api.mode = 'ok';
    const edited = `${BLUE_FARM_PRIMER}\n\nPost-ban update.`;
    await publishAndRefresh(harness, deckId, { ...cut, version: 3, primer: edited });
    const overview = defined(await services.getOverview(deckId));
    expect(overview.status).toBe('uncommitted');
    expect(overview.diff?.primer).toEqual({ status: 'captured' });
    expect(overview.diff?.changes).toEqual([]);
    expect(overview.suggestedMessage).toBe('Capture primer');

    const v3 = committed(await commitReviewed(harness, deckId, 'Primer update'));
    expect(v3.sequence).toBe(3);
    expect(defined(await services.getVersion(deckId, 3)).snapshot.primer).toContain('Post-ban update.');
    expect(defined(await services.getOverview(deckId)).status).toBe('clean');
  });

  it('commits the reviewed observation when newer observations are semantically identical', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const deckId = await trackDeck(harness);
    const reviewed = defined(defined(await services.getOverview(deckId)).working);

    // Same cards, but Moxfield bumped its revision counter and timestamps.
    expect(await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 7 }))).toMatchObject({
      ok: true,
      changedSinceLastObservation: false,
    });
    const version = committed(
      await services.commit(deckId, {
        message: 'Initial version',
        expectedObservationId: reviewed.id,
        expectedHeadCommitId: null,
      }),
    );
    expect(version.sourceVersion).toBe(1);
    expect(defined(await services.getOverview(deckId)).status).toBe('clean');
  });

  it('refuses when HEAD moved since the review, and when there is nothing to commit', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock, db } = harness;
    const deckId = await trackDeck(harness);
    const reviewed = defined(defined(await services.getOverview(deckId)).working);
    const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));

    // Both refusals are decided without asking Moxfield (and without starting the
    // refresh cooldown).
    clock.advance(60);
    const requests = api.requests.length;
    const observations = await countRows(db, 'observations');
    expect(
      await services.commit(deckId, {
        message: 'Again',
        expectedObservationId: reviewed.id,
        expectedHeadCommitId: null,
      }),
    ).toMatchObject({ ok: false, reason: 'head-moved' });
    expect(
      await services.commit(deckId, {
        message: 'Again',
        expectedObservationId: reviewed.id,
        expectedHeadCommitId: v1.commitId,
      }),
    ).toEqual({
      ok: false,
      reason: 'nothing-to-commit',
      message: 'The deck on Moxfield matches v1. There is nothing to commit.',
    });
    expect(await services.listVersions(deckId)).toHaveLength(1);
    expect(api.requests).toHaveLength(requests);
    expect(await countRows(db, 'observations')).toBe(observations);
    expect(await services.refresh(deckId)).toMatchObject({ ok: true });
  });

  it('refuses a commit from a stale second tab without asking Moxfield', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));
    await publishAndRefresh(
      harness,
      deckId,
      moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'),
    );
    // Two tabs render the same review; the first one commits.
    const tab = defined(await services.getOverview(deckId));
    committed(await commitReviewed(harness, deckId, 'Dress Down to Considering'));

    clock.advance(30);
    const requests = api.requests.length;
    expect(
      await services.commit(deckId, {
        message: 'Dress Down to Considering',
        expectedObservationId: defined(tab.working).id,
        expectedHeadCommitId: tab.head?.commitId ?? null,
      }),
    ).toMatchObject({ ok: false, reason: 'head-moved' });
    expect(api.requests).toHaveLength(requests);
  });

  it('reports printing-only changes as cosmetic and still allows committing them', async () => {
    const harness = await createServiceHarness();
    const { services } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));

    const reprinted = blueFarmSpec({ version: 2 });
    reprinted.mainboard = (reprinted.mainboard ?? []).map((card) =>
      card === 'Sol Ring'
        ? { name: 'Sol Ring', set: 'cmm', collectorNumber: '410', finish: 'foil' as const }
        : card,
    );
    await publishAndRefresh(harness, deckId, reprinted);

    const overview = defined(await services.getOverview(deckId));
    expect(overview.status).toBe('cosmetic-only');
    expect(overview.diff?.changes).toEqual([
      expect.objectContaining({
        type: 'printing',
        key: 'sol ring',
        zone: 'mainboard',
        after: [expect.objectContaining({ set: 'cmm', collectorNumber: '410', finish: 'foil' })],
      }),
    ]);
    expect(overview.suggestedMessage).toBe('Change printings');
    expect(overview.workingStats).toMatchObject({ printingChanges: 1, zones: [] });

    expect(committed(await commitReviewed(harness, deckId, 'Foil Sol Ring')).sequence).toBe(2);
    expect(defined(await services.getOverview(deckId)).status).toBe('clean');
  });

  it('commits the reviewed state when fetch-on-commit fails, and records the failure', async () => {
    const harness = await createServiceHarness();
    const { services, api } = harness;
    const deckId = await trackDeck(harness);
    api.mode = 'down';

    expect(committed(await commitReviewed(harness, deckId, 'Initial version')).sequence).toBe(1);
    expect(defined(await services.getOverview(deckId)).lastFetchError).toMatchObject({
      code: 'unavailable',
      message: 'Moxfield answered HTTP 502.',
    });
  });

  it('lets exactly one of two racing commits win', async () => {
    const harness = await createServiceHarness();
    const deckId = await trackDeck(harness);
    const overview = defined(await harness.services.getOverview(deckId));
    const input = {
      message: 'Initial version',
      expectedObservationId: defined(overview.working).id,
      expectedHeadCommitId: null,
    };

    // Two service instances (e.g. two module graphs) share the process-wide locks.
    const outcomes = await Promise.all([
      harness.services.commit(deckId, input),
      harness.sibling().commit(deckId, { ...input, message: 'Racing version' }),
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: 'head-moved' }),
    ]);
    expect(await harness.services.listVersions(deckId)).toHaveLength(1);
  });

  it('refuses a review that another instance pruned while the commit was underway', async () => {
    // As on Netlify: decks arrive by capture, and every function instance has its own
    // deck locks, so only the database orders an instance's commit and another's captures.
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, db, config, sources, clock, logger } = harness;
    const capture = (instance: DeckServices, spec: MoxDeckSpec): Promise<string> =>
      captureNext(harness, instance, spec);
    const deckId = await capture(services, blueFarmSpec());
    const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));
    await capture(services, moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'));
    const reviewed = defined(defined(await services.getOverview(deckId)).working);

    // Another instance captures twice more after this commit's checks, before its
    // transaction: pruning drops the reviewed observation and its snapshot.
    const otherInstance = harness.otherInstance();
    const repos = createRepositories(db, { now: clock.now });
    let interfere = true;
    const racedRepos: Repositories = {
      ...repos,
      transaction: async (fn, options) => {
        if (interfere) {
          interfere = false;
          await capture(
            otherInstance,
            blueFarmSpec({ version: 3, sideboard: ['Pyroclasm', 'Fire Covenant'] }),
          );
          await capture(otherInstance, blueFarmSpec({ version: 4, sideboard: [] }));
        }
        return repos.transaction(fn, options);
      },
    };
    const committing = createDeckServices({
      repos: racedRepos,
      sources,
      config,
      now: clock.now,
      logger,
      locks: new KeyedMutex(),
    });

    expect(
      await committing.commit(deckId, {
        message: 'Moved Dress Down',
        expectedObservationId: reviewed.id,
        expectedHeadCommitId: v1.commitId,
      }),
    ).toEqual({
      ok: false,
      reason: 'stale',
      message: 'The changes you reviewed are out of date. Review them again before committing.',
    });
    expect(interfere).toBe(false);
    expect(await services.listVersions(deckId)).toHaveLength(1);
  });

  it('serializes a refresh and a commit of the same deck', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const overview = defined(await services.getOverview(deckId));

    api.setDeck(moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'));
    clock.advance(60);
    const requests = api.requests.length;
    const [refreshed, outcome] = await Promise.all([
      services.refresh(deckId),
      services.commit(deckId, {
        message: 'Initial version',
        expectedObservationId: defined(overview.working).id,
        expectedHeadCommitId: null,
      }),
    ]);
    // The refresh ran first; the commit then saw the new state and refused before
    // fetching (interleaved, the commit would have fetched the deck itself).
    expect(refreshed).toMatchObject({ ok: true, changedSinceLastObservation: true });
    expect(outcome).toMatchObject({ ok: false, reason: 'stale' });
    expect(api.requests).toHaveLength(requests + 2);
  });

  it('throws a not-found service error for an unknown deck', async () => {
    const { services } = await createServiceHarness();
    await expect(
      services.commit('missing', { message: 'v1', expectedObservationId: 'x', expectedHeadCommitId: null }),
    ).rejects.toMatchObject({ name: 'ServiceError', code: 'not-found' });
    await expect(services.refresh('missing')).rejects.toMatchObject({ code: 'not-found' });
  });
});
