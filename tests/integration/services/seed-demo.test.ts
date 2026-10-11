import { describe, expect, it } from 'vitest';

import { LOCAL_WORKSPACE_ID } from '@/server/db/client';
import { createServiceHarness, defined } from '@tests/support/services';

import { DEMO_PUBLIC_ID, DEMO_USER_NAME, ensureDemoUser, seedDemoDeck } from '../../../scripts/seed-demo';

describe('demo seed', () => {
  it('creates eight versions over ten weeks with tags, notes and uncommitted changes', async () => {
    const end = Date.parse('2026-10-09T19:00:00.000Z');
    // Like the script: server fetching is off, so seeding never contacts Moxfield.
    const { services, clock, api } = await createServiceHarness({ env: { MOXFIELD_SERVER_FETCH: 'off' } });

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

describe('demo user', () => {
  it('creates an admin with a workspace of its own once, and reuses it afterwards', async () => {
    const { repos } = await createServiceHarness();
    const demo = await ensureDemoUser(repos);
    expect(demo).toMatchObject({ displayName: DEMO_USER_NAME, role: 'admin', disabledAt: null });
    // Never the `local` workspace: seeding a real database must not take over its history.
    expect(demo.workspaceId).not.toBe(LOCAL_WORKSPACE_ID);

    await repos.users.setDisabled(demo.id, true);
    expect(await ensureDemoUser(repos)).toMatchObject({ id: demo.id });
    expect((await repos.users.getById(demo.id))?.disabledAt).toBeNull();
    expect(await repos.users.count()).toBe(1);
  });
});
