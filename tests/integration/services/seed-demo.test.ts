import { describe, expect, it } from 'vitest';

import { createServices } from '@/server/services';
import { createServiceHarness, defined } from '@tests/support/services';

import { DEMO_PUBLIC_ID, DemoClock, seedDemoDeck } from '../../../scripts/seed-demo';

describe('demo seed', () => {
  it('creates eight versions over ten weeks with tags, notes and uncommitted changes', async () => {
    const end = Date.parse('2026-10-09T19:00:00.000Z');
    const clock = new DemoClock(end);
    // Like the script: server fetching is off, so seeding never contacts Moxfield.
    const { db, sources, config, logger, api } = createServiceHarness({
      env: { MOXFIELD_SERVER_FETCH: 'off' },
    });
    const services = createServices({ db, sources, config, now: clock.now, logger });

    const deckId = await seedDemoDeck(services, clock, end);
    expect(api.requests).toEqual([]);

    const overview = defined(await services.getOverview(deckId));
    expect(overview).toMatchObject({
      name: 'Blue Farm (demo)',
      externalId: DEMO_PUBLIC_ID,
      status: 'uncommitted',
      versionCount: 8,
      commanders: ["Kraum, Ludevic's Opus", 'Tymna the Weaver'],
      warnings: [],
      working: { method: 'browser-capture', fetchedAt: '2026-10-09T17:00:00.000Z' },
    });
    expect(overview.diff?.changes.map((change) => [change.type, change.name])).toEqual([
      // Ordered by source zone: mainboard before considering.
      ['moved', 'Wheel of Fortune'],
      ['moved', 'Final Fortune'],
    ]);

    const versions = await services.listVersions(deckId);
    expect(versions.map((version) => version.playedCardCount)).toEqual(Array<number>(8).fill(100));
    expect(versions.at(-1)?.createdAt.slice(0, 10)).toBe('2026-07-31');
    expect(new Set(versions.map((version) => version.ingestMethod))).toEqual(
      new Set(['browser-capture', 'manual-paste']),
    );
    expect(versions.find((version) => version.message === 'Foil Force of Will')?.stats.printingChanges).toBe(
      1,
    );
    expect(await services.listTags(deckId)).toEqual([
      { name: 'stable', count: 2 },
      { name: 'testing', count: 1 },
      { name: 'tournament', count: 2 },
    ]);

    const tournament = defined(await services.getVersion(deckId, 3));
    expect(tournament.notes).toEqual([
      expect.objectContaining({ kind: 'note', data: { text: expect.stringContaining('3-1-1') as unknown } }),
    ]);

    const dressDown = defined(await services.cardHistory(deckId, 'Dress Down'));
    expect(dressDown.history.summary).toMatchObject({ timesCut: 1, timesRestored: 1 });
  });
});
