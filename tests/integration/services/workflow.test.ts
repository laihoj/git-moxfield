import { describe, expect, it } from 'vitest';

import { suggestCommitMessage, summarizeDiff } from '@/core/diff';
import { moxfieldInternalId } from '@tests/support/moxfield-deck-builder';
import {
  BLUE_FARM_PRIMER,
  BLUE_FARM_PUBLIC_ID,
  BLUE_FARM_URL,
  blueFarmSpec,
  committed,
  createServiceHarness,
  defined,
  moveCard,
  publishAndRefresh,
} from '@tests/support/services';

const DECK_PATH = `/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`;
const PRIMER_PATH = `/v1/decks/${moxfieldInternalId(blueFarmSpec())}/primer`;

/** v2 of the deck: Dress Down cut to Considering, two new cards, a second Bowmasters, a primer edit. */
function editedSpec() {
  const moved = moveCard(blueFarmSpec(), 'Dress Down', 'mainboard', 'considering');
  return {
    ...moved,
    version: 2,
    lastUpdatedAtUtc: '2026-10-09T12:00:30.000Z',
    mainboard: [
      ...(moved.mainboard ?? []).filter((card) => card !== 'Orcish Bowmasters'),
      '2 Orcish Bowmasters',
      'Beseech the Mirror',
      'Final Fortune',
    ],
    primer: `${BLUE_FARM_PRIMER}\n\nCut [[Dress Down]] for speed.`,
  };
}

describe('deck services: the core workflow', () => {
  it('tracks a deck, commits v1, detects Moxfield edits and commits v2', async () => {
    const harness = createServiceHarness();
    const { services, api, clock } = harness;
    api.setDeck(blueFarmSpec());

    // Track: the deck is created and fetched server-side right away.
    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    expect(tracked).toMatchObject({
      alreadyTracked: false,
      fetch: { ok: true, changedSinceLastObservation: true },
    });
    expect(api.requests).toEqual([DECK_PATH, PRIMER_PATH]);
    const { deckId } = tracked;

    expect(await services.trackDeck(BLUE_FARM_PUBLIC_ID)).toEqual({
      ok: true,
      deckId,
      alreadyTracked: true,
      fetch: null,
    });
    expect(api.requests).toHaveLength(2);

    // Not committed yet: the diff is the whole deck, without deck-info noise.
    const initial = defined(await services.getOverview(deckId));
    expect(initial).toMatchObject({
      status: 'no-versions',
      name: 'Blue Farm',
      format: 'commander',
      url: BLUE_FARM_URL,
      commanders: ["Kraum, Ludevic's Opus", 'Tymna the Weaver'],
      head: null,
      workingStats: null,
      versionCount: 0,
      lastFetchError: null,
      warnings: [],
      recentVersions: [],
      serverFetch: { state: 'available' },
      autoRefreshSuggested: false,
      suggestedMessage: 'Initial version',
    });
    const initialWorking = defined(initial.working);
    expect(initialWorking).toMatchObject({ method: 'server', sourceVersion: 1, fetchedAt: clock.iso() });
    const initialDiff = defined(initial.diff);
    expect(initialDiff.deck).toEqual([]);
    expect(initialDiff.stats.zones).toEqual([
      { zone: 'commanders', added: 2, removed: 0, movedIn: 0, movedOut: 0 },
      { zone: 'mainboard', added: 13, removed: 0, movedIn: 0, movedOut: 0 },
      { zone: 'sideboard', added: 1, removed: 0, movedIn: 0, movedOut: 0 },
      { zone: 'considering', added: 2, removed: 0, movedIn: 0, movedOut: 0 },
    ]);
    expect(initialDiff.primer).toEqual({ status: 'changed', addedLines: 7, removedLines: 0 });
    expect(initial.catalog['dress down']).toMatchObject({ name: 'Dress Down', typeLine: 'Enchantment' });
    expect(initial.catalog['tymna the weaver']).toMatchObject({ manaCost: '{1}{W}{B}' });

    // v1, with a tag.
    clock.advance(5);
    const v1 = committed(
      await services.commit(deckId, {
        message: '  Initial version\r\n',
        expectedObservationId: initialWorking.id,
        expectedHeadCommitId: null,
        tags: ['Stable'],
      }),
    );
    expect(v1).toMatchObject({ sequence: 1, message: 'Initial version', sourceVersion: 1 });
    expect(v1.shortId).toBe(v1.commitId.slice(0, 7));
    expect(v1.createdAt).toBe(clock.iso());
    // Fetch on commit checked Moxfield once more.
    expect(api.requests).toHaveLength(4);

    const clean = defined(await services.getOverview(deckId));
    expect(clean).toMatchObject({ status: 'clean', head: v1, versionCount: 1, suggestedMessage: '' });
    expect(clean.workingStats).toEqual({ zones: [], moves: [], printingChanges: 0, tagChanges: 0 });
    expect(clean.recentVersions.map((version) => version.sequence)).toEqual([1]);

    // Edit the deck on Moxfield and refresh.
    const refreshed = await publishAndRefresh(harness, deckId, editedSpec());
    expect(refreshed).toMatchObject({ ok: true, changedSinceLastObservation: true });

    const dirty = defined(await services.getOverview(deckId));
    expect(dirty.status).toBe('uncommitted');
    const diff = defined(dirty.diff);
    expect(diff.changes).toEqual([
      {
        type: 'moved',
        key: 'dress down',
        name: 'Dress Down',
        from: 'mainboard',
        to: 'considering',
        quantity: 1,
      },
      {
        type: 'added',
        key: 'beseech the mirror',
        name: 'Beseech the Mirror',
        zone: 'mainboard',
        quantity: 1,
      },
      { type: 'added', key: 'final fortune', name: 'Final Fortune', zone: 'mainboard', quantity: 1 },
      {
        type: 'quantity',
        key: 'orcish bowmasters',
        name: 'Orcish Bowmasters',
        zone: 'mainboard',
        from: 1,
        to: 2,
      },
    ]);
    expect(diff.deck).toEqual([]);
    expect(diff.primer).toEqual({ status: 'changed', addedLines: 2, removedLines: 0 });
    expect(summarizeDiff(diff).map((chip) => chip.label)).toEqual([
      '+3 Mainboard',
      '1 moved to Considering',
      'Primer +2 / −0 lines',
    ]);
    expect(dirty.workingStats).toEqual(diff.stats);
    expect(dirty.suggestedMessage).toBe(suggestCommitMessage(diff));
    expect(dirty.suggestedMessage).toBe('Add Beseech the Mirror +2 more; move Dress Down to Considering');
    expect(dirty.working).toMatchObject({ sourceVersion: 2, sourceUpdatedAt: '2026-10-09T12:00:30.000Z' });
    expect(Object.keys(dirty.catalog).sort()).toEqual([
      'beseech the mirror',
      'dress down',
      'final fortune',
      "kraum, ludevic's opus",
      'orcish bowmasters',
      'tymna the weaver',
    ]);
    expect(dirty.catalog['beseech the mirror']).toMatchObject({ manaCost: '{1}{B}{B}{B}' });

    // v2.
    const v2 = committed(
      await services.commit(deckId, {
        message: dirty.suggestedMessage,
        expectedObservationId: defined(dirty.working).id,
        expectedHeadCommitId: v1.commitId,
      }),
    );
    expect(v2).toMatchObject({ sequence: 2, sourceVersion: 2 });
    expect(defined(await services.getOverview(deckId))).toMatchObject({ status: 'clean', head: v2 });

    // The version list: newest first, stats relative to the parent.
    const versions = await services.listVersions(deckId);
    expect(versions.map((version) => version.sequence)).toEqual([2, 1]);
    const [second, first] = versions;
    expect(second).toMatchObject({
      ...v2,
      parentSequence: 1,
      tags: [],
      stats: diff.stats,
      primer: diff.primer,
      commanders: ["Kraum, Ludevic's Opus", 'Tymna the Weaver'],
      playedCardCount: 17,
      ingestMethod: 'server',
    });
    expect(first).toMatchObject({
      ...v1,
      parentSequence: null,
      tags: ['stable'],
      stats: initialDiff.stats,
      primer: { status: 'changed', addedLines: 7, removedLines: 0 },
      playedCardCount: 15,
    });

    // The deck list summarizes the same state.
    expect(await services.listDecks()).toEqual([
      expect.objectContaining({ id: deckId, status: 'clean', name: 'Blue Farm', versionCount: 2, head: v2 }),
    ]);
  });

  it('rejects input that is not a Moxfield deck', async () => {
    const { services, api } = createServiceHarness();
    const outcome = await services.trackDeck('https://example.com/decks/abc');
    expect(outcome).toEqual({ ok: false, reason: expect.stringContaining('moxfield.com') as unknown });
    expect(await services.listDecks()).toEqual([]);
    expect(api.requests).toEqual([]);
  });

  it('suggests a background refresh only when the deck was last checked long enough ago', async () => {
    const { services, api, clock } = createServiceHarness();
    api.setDeck(blueFarmSpec());
    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);

    expect((await services.getOverview(tracked.deckId))?.autoRefreshSuggested).toBe(false);
    clock.advance(299);
    expect((await services.getOverview(tracked.deckId))?.autoRefreshSuggested).toBe(false);
    clock.advance(1);
    expect((await services.getOverview(tracked.deckId))?.autoRefreshSuggested).toBe(true);

    // A failed attempt counts as a check: no retry on every page load.
    api.mode = 'down';
    expect(await services.refresh(tracked.deckId, 'auto')).toMatchObject({ ok: false });
    clock.advance(60);
    expect((await services.getOverview(tracked.deckId))?.autoRefreshSuggested).toBe(false);
  });

  it('exposes setup information without the User-Agent value', () => {
    const { services } = createServiceHarness({ env: { MOXFIELD_USER_AGENT: 'secret-agent/1.0' } });
    const setup = services.getSetupInfo();
    expect(setup).toEqual({
      serverFetch: { state: 'available' },
      userAgentConfigured: true,
      captureAllowedOrigins: ['https://moxfield.com'],
      moxfieldSiteOrigin: 'https://moxfield.com',
      moxfieldApiBaseUrl: 'https://api2.moxfield.test',
    });
    expect(JSON.stringify(setup)).not.toContain('secret-agent');
  });

  it('converts primer markup through the deck source', () => {
    const { services } = createServiceHarness();
    const markdown = services.primerToMarkdown(
      'moxfield',
      '===panel: Combo\nUse [[Underworld Breach]].\n===endpanel',
    );
    expect(markdown).not.toContain('===panel');
    expect(markdown).toContain('Underworld Breach');
    expect(services.primerToMarkdown('unknown-source', '# Plain')).toBe('# Plain');
  });
});
