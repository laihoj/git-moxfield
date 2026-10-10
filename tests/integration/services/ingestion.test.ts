import { describe, expect, it } from 'vitest';

import { DeckSourceError, type DeckSource } from '@/integrations/deck-source';
import { createStaticDeckSourceRegistry } from '@/server/sources';
import { countRows } from '@tests/support/db';
import { buildCaptureEnvelope, buildMoxfieldDeck } from '@tests/support/moxfield-deck-builder';
import {
  BLUE_FARM_PUBLIC_ID,
  BLUE_FARM_URL,
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
  trackDeck,
} from '@tests/support/services';

const OTHER_DECK = blueFarmSpec({ publicId: 'OtherDeckForCapture0001', name: 'Other Deck' });

describe('deck services: server fetch failures', () => {
  it('pauses server fetches after a Cloudflare block and keeps browser capture working', async () => {
    const harness = createServiceHarness();
    const { services, api, clock } = harness;
    api.setDeck(blueFarmSpec());
    api.mode = 'blocked';

    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    expect(tracked.fetch).toEqual({
      ok: false,
      error: {
        code: 'blocked',
        message: expect.stringContaining('blocking server-side requests') as unknown,
        at: clock.iso(),
        retryAfterSeconds: 3600,
      },
    });
    expect(api.requests).toHaveLength(1);
    const { deckId } = tracked;

    const blocked = defined(await services.getOverview(deckId));
    expect(blocked).toMatchObject({
      status: 'never-fetched',
      diff: null,
      working: null,
      lastFetchError: { code: 'blocked', retryAfterSeconds: 3600 },
      serverFetch: { state: 'blocked', retryAt: new Date(clock.epochMs() + 3_600_000).toISOString() },
      autoRefreshSuggested: false,
      suggestedMessage: '',
    });
    expect(harness.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Fetching the deck failed',
        context: expect.objectContaining({ code: 'blocked', status: 403 }) as unknown,
      }),
    );

    // During the backoff, refreshing answers without any request.
    clock.advance(20);
    expect(await services.refresh(deckId, 'manual')).toEqual({
      ok: false,
      error: {
        code: 'blocked',
        message: expect.stringContaining('bookmarklet') as unknown,
        at: clock.iso(),
        retryAfterSeconds: 3580,
      },
    });
    expect(api.requests).toHaveLength(1);

    // The bookmarklet still works for the tracked deck.
    const captured = await services.ingestCapture({
      data: buildCaptureEnvelope(blueFarmSpec()),
      method: 'browser-capture',
      track: false,
    });
    expect(captured).toEqual({ status: 'ingested', deckId, changedSinceLastObservation: true });
    const afterCapture = defined(await services.getOverview(deckId));
    expect(afterCapture).toMatchObject({
      status: 'no-versions',
      name: 'Blue Farm',
      working: { method: 'browser-capture', sourceVersion: 1 },
      // The server-side problem is still reported; capture is a different channel.
      lastFetchError: { code: 'blocked' },
    });

    // Committing skips fetch-on-commit while blocked.
    const v1 = committed(await commitReviewed(harness, deckId, 'Initial version'));
    expect(v1.sequence).toBe(1);
    expect(api.requests).toHaveLength(1);
    expect((await services.listVersions(deckId))[0]?.ingestMethod).toBe('browser-capture');

    // Captures of untracked decks need an explicit "track".
    expect(
      await services.ingestCapture({
        data: buildCaptureEnvelope(OTHER_DECK),
        method: 'browser-capture',
        track: false,
      }),
    ).toEqual({
      status: 'untracked',
      source: 'moxfield',
      externalId: OTHER_DECK.publicId,
      name: 'Other Deck',
    });
    expect(await services.listDecks()).toHaveLength(1);

    const pasted = await services.ingestCapture({
      data: JSON.stringify(buildMoxfieldDeck(OTHER_DECK)),
      method: 'manual-paste',
      track: true,
    });
    if (pasted.status !== 'ingested') throw new Error('not ingested');
    const other = defined(await services.getOverview(pasted.deckId));
    expect(other).toMatchObject({
      name: 'Other Deck',
      externalId: OTHER_DECK.publicId,
      url: `https://moxfield.com/decks/${OTHER_DECK.publicId}`,
      working: { method: 'manual-paste' },
    });
    // A bare deck paste has no primer: warned about, never treated as a deletion.
    expect(other.warnings).toContainEqual(expect.objectContaining({ code: 'primer-unavailable' }));
    expect(other.diff?.primer).toEqual({ status: 'unknown' });
    expect(await services.listDecks()).toHaveLength(2);
    expect(api.requests).toHaveLength(1);

    // After the backoff, server fetches resume and a success clears the stored error.
    clock.advance(3600);
    api.mode = 'ok';
    expect(services.getSetupInfo().serverFetch).toEqual({ state: 'available' });
    expect(await services.refresh(deckId, 'manual')).toMatchObject({
      ok: true,
      changedSinceLastObservation: false,
    });
    expect(defined(await services.getOverview(deckId))).toMatchObject({
      status: 'clean',
      lastFetchError: null,
    });
  });

  it('never fetches when server fetching is turned off', async () => {
    const harness = createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, api } = harness;
    api.setDeck(blueFarmSpec());

    const tracked = await services.trackDeck(BLUE_FARM_URL);
    expect(tracked).toMatchObject({ ok: true, alreadyTracked: false, fetch: null });
    if (!tracked.ok) return;
    expect(await services.refresh(tracked.deckId, 'manual')).toMatchObject({
      ok: false,
      error: {
        code: 'blocked',
        message: expect.stringMatching(/turned off.*bookmarklet/) as unknown,
        retryAfterSeconds: null,
      },
    });
    const overview = defined(await services.getOverview(tracked.deckId));
    expect(overview).toMatchObject({
      status: 'never-fetched',
      // Not a failure of this deck: nothing is stored.
      lastFetchError: null,
      name: BLUE_FARM_PUBLIC_ID,
      serverFetch: { state: 'disabled' },
      autoRefreshSuggested: false,
    });
    expect(services.getSetupInfo()).toMatchObject({
      serverFetch: { state: 'disabled' },
      userAgentConfigured: false,
    });
    expect(api.requests).toEqual([]);
  });

  it('surfaces Moxfield rate limiting with its Retry-After', async () => {
    const harness = createServiceHarness();
    const deckId = await trackDeck(harness);
    harness.api.mode = 'rate-limited';
    harness.clock.advance(60);

    const outcome = await harness.services.refresh(deckId, 'manual');
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: expect.stringContaining('rate limiting') as unknown,
        at: harness.clock.iso(),
        retryAfterSeconds: 30,
      },
    });
    expect(defined(await harness.services.getOverview(deckId)).lastFetchError).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 30,
    });
  });

  it('sends nothing to Moxfield until its Retry-After has passed', async () => {
    const harness = createServiceHarness();
    const { services, api, clock } = harness;
    const deckA = await trackDeck(harness);
    const deckB = await trackDeck(harness, OTHER_DECK);
    const reviewed = defined(await services.getOverview(deckA));
    api.mode = 'rate-limited'; // 429 with Retry-After: 30
    clock.advance(60);
    expect(await services.refresh(deckA, 'manual')).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterSeconds: 30 },
    });
    const requests = api.requests.length;

    // Within the window: a refresh of the same deck (past its cooldown), of another
    // deck, and a commit's fetch-on-commit all answer without a request.
    clock.advance(11);
    expect(await services.refresh(deckA, 'manual')).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterSeconds: 19 },
    });
    expect(await services.refresh(deckB, 'auto')).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterSeconds: 19 },
    });
    expect(defined(await services.getOverview(deckA)).autoRefreshSuggested).toBe(false);
    expect(
      committed(
        await services.commit(deckA, {
          message: 'Initial version',
          expectedObservationId: defined(reviewed.working).id,
          expectedHeadCommitId: null,
        }),
      ).sequence,
    ).toBe(1);
    expect(api.requests).toHaveLength(requests);

    // Afterwards, Moxfield is asked again.
    clock.advance(20);
    api.mode = 'ok';
    expect(await services.refresh(deckB, 'manual')).toMatchObject({ ok: true });
    expect(api.requests).toHaveLength(requests + 2);
  });

  it('suggests no background refresh while Moxfield asked to wait', async () => {
    const harness = createServiceHarness({ env: { AUTO_REFRESH_AFTER_SECONDS: '15' } });
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    api.mode = 'rate-limited'; // Retry-After: 30
    clock.advance(60);
    await services.refresh(deckId, 'manual');
    // Due for a background refresh, but Moxfield's 30 s have not passed yet.
    clock.advance(20);
    expect(defined(await services.getOverview(deckId)).autoRefreshSuggested).toBe(false);
    clock.advance(10);
    expect(defined(await services.getOverview(deckId)).autoRefreshSuggested).toBe(true);
  });

  it('enforces the per-deck refresh cooldown without network requests', async () => {
    const harness = createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const requests = api.requests.length;

    clock.advance(2);
    expect(await services.refresh(deckId, 'manual')).toEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: 'Checked Moxfield moments ago. Try again in 8 s.',
        at: clock.iso(),
        retryAfterSeconds: 8,
      },
    });
    clock.advance(7.5);
    expect(await services.refresh(deckId, 'auto')).toMatchObject({
      ok: false,
      error: { message: 'Checked Moxfield moments ago. Try again in 1 s.', retryAfterSeconds: 1 },
    });
    expect(api.requests).toHaveLength(requests);
    // The cooldown is not a fetch failure.
    expect(defined(await services.getOverview(deckId)).lastFetchError).toBeNull();

    clock.advance(0.5);
    expect(await services.refresh(deckId, 'manual')).toMatchObject({ ok: true });
    expect(api.requests).toHaveLength(requests + 2);
  });

  it('ingests the deck without its primer when the primer request fails', async () => {
    const harness = createServiceHarness();
    const { services, api } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));

    api.mode = 'primer-down';
    expect(await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 2 }))).toMatchObject({
      ok: true,
    });

    const overview = defined(await services.getOverview(deckId));
    expect(overview.warnings).toEqual([
      expect.objectContaining({
        code: 'primer-unavailable',
        message: expect.stringContaining('503') as unknown,
      }),
    ]);
    expect(overview.diff?.primer).toEqual({ status: 'unknown' });
    // An unknown primer is no change: the deck is up to date.
    expect(overview.status).toBe('clean');
    expect(overview.lastFetchError).toBeNull();
    const compared = defined(await services.compare(deckId, 'head', 'working'));
    expect(compared.primerDiff).toEqual({ addedLines: 0, removedLines: 0, hunks: [], unknown: true });
  });

  it('reports a primer that arrives after a primer-less version as a change', async () => {
    const harness = createServiceHarness();
    const { services, api } = harness;
    // A bare deck paste has no primer; it is committed as v1.
    const pasted = await services.ingestCapture({
      data: JSON.stringify(buildMoxfieldDeck(blueFarmSpec())),
      method: 'manual-paste',
      track: true,
    });
    if (pasted.status !== 'ingested') throw new Error('not ingested');
    const { deckId } = pasted;
    api.mode = 'primer-down';
    api.setDeck(blueFarmSpec());
    committed(await commitReviewed(harness, deckId, 'Initial version'));
    expect(defined(await services.getVersion(deckId, 1)).snapshot.primer).toBeNull();

    // The full deck with its primer arrives (server fetch or bookmarklet).
    api.mode = 'ok';
    expect(await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 2 }))).toMatchObject({
      ok: true,
      changedSinceLastObservation: true,
    });
    const overview = defined(await services.getOverview(deckId));
    expect(overview.status).toBe('uncommitted');
    expect(overview.diff?.primer).toEqual({ status: 'captured' });
    // Head → working shows the same change as v1 → working.
    const fromHead = defined(await services.compare(deckId, 'head', 'working'));
    const fromV1 = defined(await services.compare(deckId, 'v1', 'working'));
    expect(fromHead.diff).toEqual(fromV1.diff);
    expect(fromHead.diff.isEmpty).toBe(false);
  });

  it('does not report an empty primer that arrives after a primer-less version', async () => {
    const harness = createServiceHarness();
    const { services, api } = harness;
    const noPrimer = blueFarmSpec({ primer: '' });
    api.mode = 'primer-down';
    const deckId = await trackDeck(harness, noPrimer);
    committed(await commitReviewed(harness, deckId, 'Initial version'));

    // The deck has no primer at all: learning that changes nothing worth a version.
    api.mode = 'ok';
    expect(await publishAndRefresh(harness, deckId, { ...noPrimer, version: 2 })).toMatchObject({
      ok: true,
      changedSinceLastObservation: false,
    });
    const overview = defined(await services.getOverview(deckId));
    expect(overview.warnings).toEqual([]);
    expect(overview.diff?.primer).toEqual({ status: 'unknown' });
    expect(overview.status).toBe('clean');
  });

  it('keeps a bounded number of observations however often the deck is checked', async () => {
    const harness = createServiceHarness();
    const { services, db } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));

    // The deck does not change, but every Moxfield payload differs (revision counter,
    // timestamps, view counts), so every raw payload is a new blob.
    for (let version = 2; version <= 40; version++) {
      expect(
        await publishAndRefresh(
          harness,
          deckId,
          blueFarmSpec({ version, lastUpdatedAtUtc: harness.clock.iso() }),
        ),
      ).toMatchObject({ ok: true, changedSinceLastObservation: false });
      await services.ingestCapture({
        data: buildCaptureEnvelope(blueFarmSpec({ version: version + 1000 })),
        method: 'browser-capture',
        track: false,
      });
    }
    expect(countRows(db, 'observations')).toBeLessThanOrEqual(2);
    expect(countRows(db, 'raw_blobs')).toBeLessThanOrEqual(countRows(db, 'commits') + 2);
    expect(countRows(db, 'snapshots')).toBeLessThanOrEqual(countRows(db, 'commits') + 2);

    // The history is intact and committing keeps working.
    await publishAndRefresh(
      harness,
      deckId,
      moveCard(blueFarmSpec({ version: 50 }), 'Dress Down', 'mainboard', 'considering'),
    );
    expect(committed(await commitReviewed(harness, deckId, 'Dress Down to Considering')).sequence).toBe(2);
    const dangling = db.$client
      .prepare(
        `SELECT COUNT(*) AS n FROM commits
         WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE hash = commits.snapshot_hash)
            OR NOT EXISTS (SELECT 1 FROM raw_blobs WHERE hash = commits.raw_blob_hash)`,
      )
      .get() as { n: number };
    expect(dangling.n).toBe(0);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    expect(defined(await services.getVersion(deckId, 1)).snapshot.zones.mainboard).toBeDefined();
    expect(defined(await services.getOverview(deckId)).status).toBe('clean');
  });

  it('commits a review rendered just before a refresh, and asks for a new review after more', async () => {
    const harness = createServiceHarness();
    const { services } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version'));
    const edited = moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering');
    await publishAndRefresh(harness, deckId, edited);
    const review = defined(await services.getOverview(deckId));
    const commitReview = () =>
      services.commit(deckId, {
        message: 'Dress Down to Considering',
        expectedObservationId: defined(review.working).id,
        expectedHeadCommitId: review.head?.commitId ?? null,
      });

    // One refresh (e.g. another tab) after the review: still committable.
    await publishAndRefresh(harness, deckId, { ...edited, version: 3 });
    const kept = await commitReview();
    expect(committed(kept).sourceVersion).toBe(2);

    // A review that several refreshes have superseded is gone: review again.
    await publishAndRefresh(
      harness,
      deckId,
      moveCard({ ...edited, version: 4 }, 'Pyroclasm', 'sideboard', 'considering'),
    );
    const second = defined(await services.getOverview(deckId));
    for (const version of [5, 6]) {
      await publishAndRefresh(
        harness,
        deckId,
        moveCard({ ...edited, version }, 'Pyroclasm', 'sideboard', 'considering'),
      );
    }
    expect(
      await services.commit(deckId, {
        message: 'Pyroclasm to Considering',
        expectedObservationId: defined(second.working).id,
        expectedHeadCommitId: second.head?.commitId ?? null,
      }),
    ).toMatchObject({ ok: false, reason: 'stale' });
    expect(committed(await commitReviewed(harness, deckId, 'Pyroclasm to Considering')).sequence).toBe(3);
  });

  it('reports Moxfield outages and missing decks', async () => {
    const harness = createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const requests = api.requests.length;

    api.mode = 'down';
    clock.advance(60);
    expect(await services.refresh(deckId, 'manual')).toMatchObject({
      ok: false,
      error: { code: 'unavailable', message: 'Moxfield answered HTTP 502.' },
    });
    // One retry for 5xx answers.
    expect(api.requests).toHaveLength(requests + 2);

    api.mode = 'ok';
    const missing = await services.trackDeck('https://moxfield.com/decks/DeckThatDoesNotExist01');
    expect(missing).toMatchObject({ ok: true, fetch: { ok: false, error: { code: 'not-found' } } });
  });

  it('hides unexpected errors behind a generic message and logs them', async () => {
    const harness = createServiceHarness({
      sources: (defaults) => {
        const moxfield = defaults.require('moxfield');
        const failing: DeckSource = Object.create(moxfield) as DeckSource;
        Object.defineProperty(failing, 'getDeck', {
          value: () => Promise.reject(new TypeError('internal detail: socket exploded')),
        });
        return createStaticDeckSourceRegistry([failing]);
      },
    });
    const tracked = await harness.services.trackDeck(BLUE_FARM_URL);
    expect(tracked).toMatchObject({
      ok: true,
      fetch: {
        ok: false,
        error: {
          code: 'unavailable',
          message: 'Something went wrong while checking Moxfield. Try again in a moment.',
        },
      },
    });
    expect(JSON.stringify(tracked)).not.toContain('socket exploded');
    expect(harness.logger.entries).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'Unexpected error while fetching the deck' }),
    );
  });

  it('rejects unusable captured data with a schema error', async () => {
    const { services } = createServiceHarness();
    for (const data of ['', 'not json', { content: '# just a primer' }, { publicId: 'x', boards: 7 }]) {
      await expect(services.ingestCapture({ data, method: 'manual-paste', track: true })).rejects.toSatisfy(
        (error: unknown) => error instanceof DeckSourceError && error.code === 'schema',
      );
    }
    expect(await services.listDecks()).toEqual([]);
  });

  it('removes a deck with its entire history when untracked', async () => {
    const harness = createServiceHarness();
    const { services, db } = harness;
    const deckId = await trackDeck(harness);
    committed(await commitReviewed(harness, deckId, 'Initial version', ['stable']));
    await publishAndRefresh(
      harness,
      deckId,
      moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering'),
    );
    await services.setNote(deckId, 1, 'Top 4 at locals');

    await services.untrackDeck(deckId);
    expect(await services.getOverview(deckId)).toBeNull();
    expect(await services.listVersions(deckId)).toEqual([]);
    expect(await services.listDecks()).toEqual([]);
    for (const table of [
      'decks',
      'commits',
      'observations',
      'snapshots',
      'raw_blobs',
      'version_tags',
      'commit_notes',
    ]) {
      expect(countRows(db, table)).toBe(0);
    }
    // Untracking twice is harmless.
    await services.untrackDeck(deckId);
  });
});
