import { sql } from 'drizzle-orm';
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
  it('pauses server fetches after a Cloudflare block until resumed, and keeps browser capture working', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    api.setDeck(blueFarmSpec());
    api.mode = 'blocked';

    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    expect(tracked.fetch).toEqual({
      ok: false,
      error: {
        code: 'blocked',
        message: expect.stringContaining('paused for everyone until an admin resumes it') as unknown,
        at: clock.iso(),
        retryAfterSeconds: null,
      },
    });
    expect(api.requests).toHaveLength(1);
    const { deckId } = tracked;

    const blocked = defined(await services.getOverview(deckId));
    expect(blocked).toMatchObject({
      status: 'never-fetched',
      diff: null,
      working: null,
      lastFetchError: { code: 'blocked', retryAfterSeconds: null },
      serverFetch: {
        state: 'paused',
        reason: expect.stringContaining("Moxfield's bot protection answered a request (HTTP 403") as unknown,
        pausedAt: expect.any(String) as unknown,
      },
      suggestedMessage: '',
    });
    expect(harness.logger.entries).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        message: 'Fetching the deck failed',
        context: expect.objectContaining({ code: 'blocked', status: 403 }) as unknown,
      }),
    );

    // While paused, refreshing answers without any request, however much later.
    clock.advance(86_400);
    expect(await services.refresh(deckId)).toEqual({
      ok: false,
      error: {
        code: 'blocked',
        message: expect.stringMatching(/bot protection.*until an admin resumes it.*bookmarklet/) as unknown,
        at: clock.iso(),
        retryAfterSeconds: null,
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
      // The workspace's decks it could continue instead ("Continue an existing deck's history").
      decks: [
        {
          id: deckId,
          name: 'Blue Farm',
          externalId: BLUE_FARM_PUBLIC_ID,
          format: 'commander',
          versionCount: 1,
          updatedAt: expect.any(String) as unknown,
        },
      ],
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

    // Once an admin resumes, server fetches run again and a success clears the stored error.
    api.mode = 'ok';
    expect((await services.getSetupInfo()).serverFetch).toMatchObject({ state: 'paused' });
    expect(await harness.moxfieldLimiter.resume()).toBe(true);
    expect((await services.getSetupInfo()).serverFetch).toEqual({ state: 'available' });
    expect(await services.refresh(deckId)).toMatchObject({
      ok: true,
      changedSinceLastObservation: false,
    });
    expect(defined(await services.getOverview(deckId))).toMatchObject({
      status: 'clean',
      lastFetchError: null,
    });
  });

  it('never fetches when server fetching is turned off', async () => {
    const harness = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });
    const { services, api } = harness;
    api.setDeck(blueFarmSpec());

    const tracked = await services.trackDeck(BLUE_FARM_URL);
    expect(tracked).toMatchObject({ ok: true, alreadyTracked: false, fetch: null });
    if (!tracked.ok) return;
    expect(await services.refresh(tracked.deckId)).toMatchObject({
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
    });
    expect(await services.getSetupInfo()).toMatchObject({
      serverFetch: { state: 'disabled' },
      userAgentConfigured: false,
    });
    expect(api.requests).toEqual([]);
  });

  it('surfaces Moxfield rate limiting with its Retry-After', async () => {
    const harness = await createServiceHarness();
    const deckId = await trackDeck(harness);
    harness.api.mode = 'rate-limited';
    harness.clock.advance(60);

    const outcome = await harness.services.refresh(deckId);
    expect(outcome).toEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: expect.stringContaining('slow down (HTTP 429)') as unknown,
        at: harness.clock.iso(),
        retryAfterSeconds: 30,
      },
    });
    expect(defined(await harness.services.getOverview(deckId)).lastFetchError).toMatchObject({
      code: 'rate-limited',
      retryAfterSeconds: 30,
    });
  });

  it('sends nothing to Moxfield while its Retry-After lasts, for any deck or commit', async () => {
    // The services compare their clock with the limiter's database time here, so it stays
    // at the real time (no cooldown to wait out).
    const harness = await createServiceHarness({
      clockStart: Date.now(),
      env: { REFRESH_COOLDOWN_SECONDS: '0' },
    });
    const { services, api } = harness;
    const deckA = await trackDeck(harness);
    const deckB = await trackDeck(harness, OTHER_DECK);
    const reviewed = defined(await services.getOverview(deckA));
    api.mode = 'rate-limited'; // 429 with Retry-After: 30
    expect(await services.refresh(deckA)).toMatchObject({
      ok: false,
      error: { code: 'rate-limited', retryAfterSeconds: 30 },
    });
    const requests = api.requests.length;
    expect(defined(await services.getOverview(deckB)).serverFetch).toMatchObject({
      state: 'rate-limited',
      reason: expect.stringContaining('HTTP 429') as unknown,
    });

    // Within the window: a refresh of the same deck, of another deck, and a commit's
    // fetch-on-commit all answer without a request.
    expect(await services.refresh(deckA)).toMatchObject({ ok: false, error: { code: 'rate-limited' } });
    const other = await services.refresh(deckB);
    expect(other).toMatchObject({ ok: false, error: { code: 'rate-limited' } });
    // The database's 30 s, seen from the services' (here: the real) clock.
    expect(other.ok ? null : other.error.retryAfterSeconds).toBeGreaterThanOrEqual(28);
    expect(other.ok ? null : other.error.retryAfterSeconds).toBeLessThanOrEqual(31);
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
  });

  it('enforces the per-deck refresh cooldown without network requests', async () => {
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const requests = api.requests.length;

    clock.advance(2);
    expect(await services.refresh(deckId)).toEqual({
      ok: false,
      error: {
        code: 'rate-limited',
        message: 'Checked Moxfield moments ago. Try again in 8 s.',
        at: clock.iso(),
        retryAfterSeconds: 8,
      },
    });
    clock.advance(7.5);
    expect(await services.refresh(deckId)).toMatchObject({
      ok: false,
      error: { message: 'Checked Moxfield moments ago. Try again in 1 s.', retryAfterSeconds: 1 },
    });
    expect(api.requests).toHaveLength(requests);
    // The cooldown is not a fetch failure.
    expect(defined(await services.getOverview(deckId)).lastFetchError).toBeNull();

    clock.advance(0.5);
    expect(await services.refresh(deckId)).toMatchObject({ ok: true });
    expect(api.requests).toHaveLength(requests + 2);
  });

  it('ingests the deck without its primer when the primer request fails', async () => {
    const harness = await createServiceHarness();
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
    const harness = await createServiceHarness();
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
    const harness = await createServiceHarness();
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
    const harness = await createServiceHarness();
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
    const commits = await countRows(db, 'commits');
    expect(await countRows(db, 'observations')).toBeLessThanOrEqual(2);
    expect(await countRows(db, 'raw_blobs')).toBeLessThanOrEqual(commits + 2);
    expect(await countRows(db, 'snapshots')).toBeLessThanOrEqual(commits + 2);

    // The history is intact and committing keeps working.
    await publishAndRefresh(
      harness,
      deckId,
      moveCard(blueFarmSpec({ version: 50 }), 'Dress Down', 'mainboard', 'considering'),
    );
    expect(committed(await commitReviewed(harness, deckId, 'Dress Down to Considering')).sequence).toBe(2);
    const dangling = await db.all<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM commits
          WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE hash = commits.snapshot_hash)
             OR NOT EXISTS (SELECT 1 FROM raw_blobs WHERE hash = commits.raw_blob_hash)`,
    );
    expect(dangling).toEqual([{ n: 0 }]);
    expect(await db.all(sql`PRAGMA foreign_key_check`)).toEqual([]);
    expect(defined(await services.getVersion(deckId, 1)).snapshot.zones.mainboard).toBeDefined();
    expect(defined(await services.getOverview(deckId)).status).toBe('clean');
  });

  it('commits a review rendered just before a refresh, and asks for a new review after more', async () => {
    const harness = await createServiceHarness();
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
    const harness = await createServiceHarness();
    const { services, api, clock } = harness;
    const deckId = await trackDeck(harness);
    const requests = api.requests.length;

    api.mode = 'down';
    clock.advance(60);
    expect(await services.refresh(deckId)).toMatchObject({
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
    const harness = await createServiceHarness({
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
    const { services } = await createServiceHarness();
    for (const data of ['', 'not json', { content: '# just a primer' }, { publicId: 'x', boards: 7 }]) {
      await expect(services.ingestCapture({ data, method: 'manual-paste', track: true })).rejects.toSatisfy(
        (error: unknown) => error instanceof DeckSourceError && error.code === 'schema',
      );
    }
    expect(await services.listDecks()).toEqual([]);
  });

  it('removes a deck with its entire history when untracked', async () => {
    const harness = await createServiceHarness();
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
      expect(await countRows(db, table)).toBe(0);
    }
    // Untracking twice is harmless.
    await services.untrackDeck(deckId);
  });
});
