import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { zoneCount } from '@/core/canonical';
import { DeckSourceError } from '@/integrations/deck-source';
import { MoxfieldDeckSource } from '@/integrations/moxfield';
import { expectRejection } from '@tests/support/errors';
import { moxfieldInternalId, type MoxDeckSpec } from '@tests/support/moxfield-deck-builder';

import {
  BLUE_FARM_PUBLIC_ID,
  BLUE_FARM_VERSION,
  blueFarmDeck,
  SECOND_DECK_PUBLIC_ID,
} from '../mock-moxfield/scenarios';
import { startMockMoxfield, type RunningMockMoxfield } from '../mock-moxfield/server';
import { applyEditOps, MockRequestError, type EditOp, type MockStateSnapshot } from '../mock-moxfield/state';

const NOW = new Date('2026-10-09T15:30:00.000Z');
/** Headers a browser sends on the bookmarklet's same-origin fetch. */
const BROWSER = {
  'user-agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
};

let mock: RunningMockMoxfield;
const logLines: string[] = [];

beforeAll(async () => {
  mock = await startMockMoxfield({
    port: 0,
    now: () => NOW,
    log: (line) => {
      logLines.push(line);
    },
  });
});

afterAll(async () => {
  await mock.close();
});

afterEach(() => {
  mock.state.reset();
  logLines.length = 0;
});

function url(path: string): string {
  return `${mock.url}${path}`;
}

async function getJson(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url(path), { headers });
  return { status: response.status, body: await response.json() };
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url(path), {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function controlState(): Promise<MockStateSnapshot> {
  return (await getJson('/__control/state')).body as MockStateSnapshot;
}

async function edit(publicId: string, ops: unknown): Promise<{ status: number; body: unknown }> {
  return send('POST', `/__control/decks/${publicId}/edit`, ops);
}

function adapter(): MoxfieldDeckSource {
  return new MoxfieldDeckSource({
    apiBaseUrl: mock.url,
    siteOrigin: mock.url,
    minRequestIntervalMs: 0,
    sleep: () => Promise.resolve(),
  });
}

async function fetchThroughAdapter(publicId = BLUE_FARM_PUBLIC_ID) {
  const source = adapter();
  return source.normalizeDeck(await source.getDeck({ source: 'moxfield', externalId: publicId }));
}

function adapterError(publicId = BLUE_FARM_PUBLIC_ID): Promise<DeckSourceError> {
  return expectRejection(adapter().getDeck({ source: 'moxfield', externalId: publicId }), DeckSourceError);
}

describe('mock Moxfield API', () => {
  it('serves the seeded Blue Farm deck in exactly the shape the real adapter expects', async () => {
    const normalized = await fetchThroughAdapter();
    const { snapshot, metadata, catalog, warnings } = normalized;

    expect(warnings).toEqual([]);
    expect(snapshot.deck).toMatchObject({ name: 'Blue Farm', format: 'commander', tags: ['Turbo', 'cEDH'] });
    expect(zoneCount(snapshot, 'commanders')).toBe(2);
    expect(zoneCount(snapshot, 'mainboard')).toBe(98);
    expect(zoneCount(snapshot, 'considering')).toBe(12);
    expect(zoneCount(snapshot, 'sideboard')).toBe(2);
    expect(snapshot.zones.commanders?.map((card) => card.name)).toEqual([
      "Kraum, Ludevic's Opus",
      'Tymna the Weaver',
    ]);
    expect(snapshot.zones.mainboard?.find((card) => card.key === 'island')?.quantity).toBe(2);
    expect(snapshot.cardTags["thassa's oracle"]).toEqual(['win-con']);
    expect(snapshot.primer).toContain('===panel: Underworld Breach + Brain Freeze');
    expect(snapshot.primer).toContain('[[Thassa');

    expect(metadata).toMatchObject({
      externalId: BLUE_FARM_PUBLIC_ID,
      url: `${mock.url}/decks/${BLUE_FARM_PUBLIC_ID}`,
      version: BLUE_FARM_VERSION,
      lastUpdatedAt: '2026-10-01T12:00:00.000Z',
    });
    const facts = new Map(catalog.map((card) => [card.key, card]));
    expect(facts.get('sol ring')).toMatchObject({
      typeLine: 'Artifact',
      manaCost: '{1}',
      primaryType: 'Artifact',
    });
    expect(facts.get('orcish bowmasters')).toMatchObject({ primaryType: 'Creature', manaCost: '{1}{B}' });
    expect(facts.get('mnemonic betrayal')).toMatchObject({ primaryType: 'Sorcery' });
  });

  it('gives every seeded card a plausible printing: a collector number from 1 to 400', async () => {
    const { snapshot } = await fetchThroughAdapter();
    const numbers = Object.values(snapshot.zones)
      .flatMap((cards) => cards ?? [])
      .flatMap((card) => card.printings.map((printing) => printing.collectorNumber));
    expect(numbers.length).toBeGreaterThan(100);
    for (const number of numbers) {
      expect(number).toMatch(/^[1-9]\d*$/);
      expect(Number(number)).toBeLessThanOrEqual(400);
    }
  });

  it('serves the second deck with an empty primer', async () => {
    const { snapshot, warnings } = await fetchThroughAdapter(SECOND_DECK_PUBLIC_ID);
    expect(warnings).toEqual([]);
    expect(snapshot.deck.name).toBe('Tana Tokens');
    expect(snapshot.primer).toBe('');
  });

  it('answers 404 for unknown decks and primers', async () => {
    expect((await getJson('/v3/decks/all/UnknownDeck00000000000')).status).toBe(404);
    expect((await getJson('/v1/decks/nope1/primer')).status).toBe(404);
    expect((await adapterError('UnknownDeck00000000000')).code).toBe('not-found');
  });

  it('serves the primer by internal deck id', async () => {
    const { status, body } = await getJson(`/v1/decks/${moxfieldInternalId(blueFarmDeck())}/primer`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ content: expect.stringContaining('===center') as unknown });
  });

  it('blocks server clients but not browsers in blocked mode, like Cloudflare', async () => {
    expect(await send('POST', '/__control/mode', { mode: 'blocked' })).toEqual({
      status: 200,
      body: { mode: 'blocked' },
    });

    const blocked = await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`));
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('content-type')).toMatch(/^text\/html/);
    expect(blocked.headers.get('cf-ray')).toMatch(/\S/);
    expect(await blocked.text()).toContain('Sorry, you have been blocked');
    expect((await adapterError()).code).toBe('blocked');

    expect((await getJson(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`, BROWSER)).status).toBe(200);

    const { requests } = await controlState();
    expect(requests.map((request) => [request.status, request.client])).toEqual([
      [403, 'server'],
      [403, 'server'],
      [200, 'browser'],
    ]);
  });

  it('rate limits everyone with Retry-After in rate-limited mode', async () => {
    await send('POST', '/__control/mode', { mode: 'rate-limited' });
    const response = await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`), { headers: BROWSER });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    const error = await adapterError();
    expect(error.code).toBe('rate-limited');
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('answers 502 in down mode', async () => {
    await send('POST', '/__control/mode', { mode: 'down' });
    expect((await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`))).status).toBe(502);
    expect((await adapterError()).code).toBe('unavailable');
  });

  it('fails only the primer in primer-down mode, so the deck is still ingested', async () => {
    await send('POST', '/__control/mode', { mode: 'primer-down' });
    const { snapshot, warnings } = await fetchThroughAdapter();
    expect(zoneCount(snapshot, 'mainboard')).toBe(98);
    expect(snapshot.primer).toBeNull();
    expect(warnings.map((warning) => warning.code)).toContain('primer-unavailable');
  });

  it('rejects unknown modes', async () => {
    const { status, body } = await send('POST', '/__control/mode', { mode: 'sideways' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: expect.stringContaining('mode') as unknown });
    expect((await controlState()).mode).toBe('ok');
  });
});

describe('mock Moxfield deck page', () => {
  it('renders a Moxfield-like page for the bookmarklet to run on, without COOP', async () => {
    const response = await fetch(url(`/decks/${BLUE_FARM_PUBLIC_ID}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cross-origin-opener-policy')).toBeNull();
    // Makes browsers post the same-tab bookmarklet's form with `Origin: null`, as from the
    // real https://moxfield.com to an http:// git-moxfield.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    expect(html).toContain('<title>Blue Farm // Commander deck list mtg // Moxfield</title>');
    expect(html).toContain('Mock Moxfield deck page');
    expect(html).toContain('Tymna the Weaver');

    // Subpages such as /primer show the same deck, as the bookmarklet accepts them.
    expect((await fetch(url(`/decks/${BLUE_FARM_PUBLIC_ID}/primer`))).status).toBe(200);
  });

  it('escapes deck content and answers 404 for unknown decks', async () => {
    await send('PUT', '/__control/decks/HostileDeck00000000001', {
      name: '<script>alert(1)</script>',
      mainboard: ['<img src=x onerror=alert(1)>'],
    });
    const html = await (await fetch(url('/decks/HostileDeck00000000001'))).text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).toContain('&#60;script&#62;');

    expect((await fetch(url('/decks/UnknownDeck00000000000'))).status).toBe(404);
  });
});

describe('mock Moxfield control API', () => {
  it('lists the seeded decks with their zone counts', async () => {
    const state = await controlState();
    expect(state.mode).toBe('ok');
    expect(state.decks).toEqual([
      {
        publicId: BLUE_FARM_PUBLIC_ID,
        internalId: moxfieldInternalId(blueFarmDeck()),
        name: 'Blue Farm',
        version: BLUE_FARM_VERSION,
        lastUpdatedAtUtc: '2026-10-01T12:00:00.000Z',
        counts: { commanders: 2, companions: 0, mainboard: 98, sideboard: 2, considering: 12 },
      },
      expect.objectContaining({ publicId: SECOND_DECK_PUBLIC_ID, name: 'Tana Tokens' }),
    ]);
  });

  it('applies an edit atomically, bumping the version once and stamping the time', async () => {
    const ops: EditOp[] = [
      { op: 'move', card: 'Dress Down', from: 'mainboard', to: 'considering' },
      { op: 'move', card: 'mnemonic betrayal', from: 'considering', to: 'mainboard' },
      {
        op: 'add',
        zone: 'mainboard',
        card: { name: 'Final Fortune', typeLine: 'Instant', manaCost: '{R}{R}' },
      },
      { op: 'remove', zone: 'mainboard', card: 'Windfall' },
      { op: 'setQuantity', zone: 'mainboard', card: 'Island', quantity: 3 },
      {
        op: 'setPrinting',
        zone: 'mainboard',
        card: 'Sol Ring',
        set: 'cmm',
        collectorNumber: '400',
        finish: 'foil',
      },
      { op: 'primer', text: '# New primer\n' },
      { op: 'rename', name: 'Blue Farm (Breach)' },
    ];
    const { status } = await edit(BLUE_FARM_PUBLIC_ID, ops);
    expect(status).toBe(200);

    const { snapshot, metadata } = await fetchThroughAdapter();
    expect(metadata.version).toBe(BLUE_FARM_VERSION + 1);
    expect(metadata.lastUpdatedAt).toBe(NOW.toISOString());
    expect(snapshot.deck.name).toBe('Blue Farm (Breach)');
    expect(snapshot.primer).toBe('# New primer\n');
    const mainboard = new Map(snapshot.zones.mainboard?.map((card) => [card.key, card]));
    expect(mainboard.has('dress down')).toBe(false);
    expect(mainboard.has('windfall')).toBe(false);
    expect(mainboard.get('mnemonic betrayal')?.quantity).toBe(1);
    expect(mainboard.get('final fortune')?.quantity).toBe(1);
    expect(mainboard.get('island')?.quantity).toBe(3);
    expect(mainboard.get('sol ring')?.printings).toEqual([
      expect.objectContaining({ set: 'cmm', collectorNumber: '400', finish: 'foil', quantity: 1 }),
    ]);
    expect(snapshot.zones.considering?.map((card) => card.key)).toContain('dress down');
    expect(zoneCount(snapshot, 'mainboard')).toBe(98 + 1 - 1 + 1);
  });

  it('rejects an edit with a failing operation and applies none of it', async () => {
    const { status, body } = await edit(BLUE_FARM_PUBLIC_ID, [
      { op: 'rename', name: 'Renamed' },
      { op: 'remove', zone: 'mainboard', card: 'Black Lotus' },
    ]);
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Operation 2 (remove) failed: Black Lotus is not in mainboard' });
    const [deck] = (await controlState()).decks;
    expect(deck).toMatchObject({ name: 'Blue Farm', version: BLUE_FARM_VERSION });
  });

  it.each([
    ['not an array', { op: 'rename', name: 'x' }],
    ['empty', []],
    ['unknown op', [{ op: 'shuffle' }]],
    ['unknown zone', [{ op: 'remove', zone: 'graveyard', card: 'Sol Ring' }]],
    ['extra field', [{ op: 'rename', name: 'x', extra: true }]],
    ['zero quantity', [{ op: 'move', card: 'Sol Ring', from: 'mainboard', to: 'sideboard', quantity: 0 }]],
  ])('validates edit operations (%s)', async (_label, ops) => {
    const { status, body } = await edit(BLUE_FARM_PUBLIC_ID, ops);
    expect(status).toBe(400);
    expect(body).toEqual({ error: expect.stringMatching(/^Invalid edit operations: /) as unknown });
  });

  it('answers 404 when editing an unknown deck, 400 for malformed JSON and 405 for wrong methods', async () => {
    expect((await edit('UnknownDeck00000000000', [{ op: 'rename', name: 'x' }])).status).toBe(404);
    expect(await send('POST', '/__control/mode', '{not json')).toEqual({
      status: 400,
      body: { error: 'Request body is not valid JSON' },
    });
    expect((await send('DELETE', '/__control/state')).status).toBe(405);
    expect((await send('POST', `/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`)).status).toBe(405);
  });

  it('creates, replaces, reads and deletes decks', async () => {
    const spec: Omit<MoxDeckSpec, 'publicId'> = {
      name: 'Kinnan Turbo',
      commanders: ['Kinnan, Bonder Prodigy'],
      mainboard: ['Basalt Monolith', '2 Forest'],
      primer: 'Fast.',
    };
    const created = await send('PUT', '/__control/decks/MockKinnanDeck00000003', spec);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      deck: { ...spec, publicId: 'MockKinnanDeck00000003', version: 1, lastUpdatedAtUtc: NOW.toISOString() },
    });

    const replaced = await send('PUT', '/__control/decks/MockKinnanDeck00000003', {
      ...spec,
      name: 'Kinnan',
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ deck: { name: 'Kinnan', version: 2 } });
    expect((await getJson('/__control/decks/MockKinnanDeck00000003')).body).toMatchObject({
      deck: { name: 'Kinnan' },
    });
    const { snapshot } = await fetchThroughAdapter('MockKinnanDeck00000003');
    expect(zoneCount(snapshot, 'mainboard')).toBe(3);

    expect((await send('DELETE', '/__control/decks/MockKinnanDeck00000003')).status).toBe(200);
    expect((await getJson('/v3/decks/all/MockKinnanDeck00000003')).status).toBe(404);
    expect((await send('DELETE', '/__control/decks/MockKinnanDeck00000003')).status).toBe(404);
  });

  it.each([
    ['an invalid deck id', '/__control/decks/bad!', {}],
    [
      'a contradicting publicId',
      '/__control/decks/MockKinnanDeck00000003',
      { publicId: 'OtherDeck0000000000000' },
    ],
    ['an unknown field', '/__control/decks/MockKinnanDeck00000003', { maybeboard: [] }],
    ['an invalid card', '/__control/decks/MockKinnanDeck00000003', { mainboard: ['0 Sol Ring'] }],
    [
      'a builder board as extra board',
      '/__control/decks/MockKinnanDeck00000003',
      { extraBoards: { mainboard: [] } },
    ],
  ])('rejects a deck with %s', async (_label, path, body) => {
    const { status, body: response } = await send('PUT', path, body);
    expect(status).toBe(400);
    expect(response).toEqual({ error: expect.any(String) as unknown });
  });

  it('rejects a deck whose internal id is taken by another deck', async () => {
    const { status } = await send('PUT', '/__control/decks/MockKinnanDeck00000003', {
      id: moxfieldInternalId(blueFarmDeck()),
    });
    expect(status).toBe(409);
  });

  it('resets decks, mode and request log', async () => {
    await edit(BLUE_FARM_PUBLIC_ID, [{ op: 'rename', name: 'Changed' }]);
    await send('DELETE', `/__control/decks/${SECOND_DECK_PUBLIC_ID}`);
    await send('POST', '/__control/mode', { mode: 'down' });
    await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`));

    const { status, body } = await send('POST', '/__control/reset');
    expect(status).toBe(200);
    const state = body as MockStateSnapshot;
    expect(state.mode).toBe('ok');
    expect(state.requests).toEqual([]);
    expect(state.decks.map((deck) => [deck.name, deck.version])).toEqual([
      ['Blue Farm', BLUE_FARM_VERSION],
      ['Tana Tokens', 7],
    ]);
  });

  it('logs one line per request', async () => {
    await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`));
    await send('POST', '/__control/mode', { mode: 'down' });
    await fetch(url(`/v3/decks/all/${BLUE_FARM_PUBLIC_ID}`), { headers: BROWSER });
    // Lines are written when a response finishes, which can trail the client by a tick.
    await vi.waitFor(() => {
      expect(logLines).toHaveLength(3);
    });
    expect(logLines).toEqual([
      expect.stringMatching(
        /^\[mock-moxfield\] GET \/v3\/decks\/all\/MockBlueFarm0000000001 200 \d+ms server$/,
      ),
      expect.stringMatching(/^\[mock-moxfield\] POST \/__control\/mode 200 \d+ms server \[down\]$/),
      expect.stringMatching(/ 502 \d+ms browser \[down\]$/),
    ]);
  });
});

describe('applyEditOps', () => {
  const base: MoxDeckSpec = {
    publicId: 'PureDeck00000000000001',
    version: 4,
    mainboard: [
      '2 Island',
      { name: 'Island', quantity: 3, set: 'unf', collectorNumber: '235' },
      { name: 'Sol Ring', set: 'c21', collectorNumber: '263', finish: 'etched' },
    ],
    sideboard: ['Island'],
  };

  it('takes copies across printings and keeps each printing when moving', () => {
    const edited = applyEditOps(
      base,
      [{ op: 'move', card: 'island', from: 'mainboard', to: 'sideboard', quantity: 4 }],
      NOW,
    );
    expect(edited.mainboard).toEqual([
      { name: 'Island', quantity: 1, set: 'unf', collectorNumber: '235' },
      { name: 'Sol Ring', set: 'c21', collectorNumber: '263', finish: 'etched' },
    ]);
    // The default printing merges with the sideboard's default-printing Island.
    expect(edited.sideboard).toEqual([
      { name: 'Island', quantity: 3 },
      { name: 'Island', quantity: 2, set: 'unf', collectorNumber: '235' },
    ]);
    expect(edited).toMatchObject({ version: 5, lastUpdatedAtUtc: NOW.toISOString() });
    expect(base.mainboard).toHaveLength(3);
  });

  it('collapses all copies into one printing and keeps the finish unless given', () => {
    const edited = applyEditOps(
      base,
      [
        { op: 'setPrinting', zone: 'mainboard', card: 'Island', set: 'sld', collectorNumber: '63' },
        { op: 'setPrinting', zone: 'mainboard', card: 'Sol Ring', set: 'cmm', collectorNumber: '1' },
      ],
      NOW,
    );
    expect(edited.mainboard).toEqual([
      { name: 'Island', quantity: 5, set: 'sld', collectorNumber: '63', finish: 'nonFoil' },
      { name: 'Sol Ring', quantity: 1, set: 'cmm', collectorNumber: '1', finish: 'etched' },
    ]);
  });

  it('raises and lowers quantities and refuses to set a card that is absent', () => {
    const raised = applyEditOps(
      base,
      [{ op: 'setQuantity', zone: 'mainboard', card: 'Island', quantity: 7 }],
      NOW,
    );
    expect(raised.mainboard?.slice(0, 2)).toEqual([
      { name: 'Island', quantity: 4 },
      { name: 'Island', quantity: 3, set: 'unf', collectorNumber: '235' },
    ]);
    const lowered = applyEditOps(
      base,
      [{ op: 'setQuantity', zone: 'mainboard', card: 'Island', quantity: 0 }],
      NOW,
    );
    expect(lowered.mainboard).toEqual([
      { name: 'Sol Ring', set: 'c21', collectorNumber: '263', finish: 'etched' },
    ]);
    expect(() =>
      applyEditOps(base, [{ op: 'setQuantity', zone: 'considering', card: 'Island', quantity: 1 }], NOW),
    ).toThrow(MockRequestError);
  });

  it('refuses to take more copies than there are, or to move within one zone', () => {
    expect(() =>
      applyEditOps(base, [{ op: 'remove', zone: 'mainboard', card: 'Island', quantity: 6 }], NOW),
    ).toThrow('Operation 1 (remove) failed: cannot take 6 Island from mainboard: there are only 5');
    expect(() =>
      applyEditOps(base, [{ op: 'move', card: 'Island', from: 'mainboard', to: 'mainboard' }], NOW),
    ).toThrow('"from" and "to" must be different zones');
  });
});
