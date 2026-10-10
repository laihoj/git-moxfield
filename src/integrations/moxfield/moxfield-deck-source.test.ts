import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '@tests/support/builders';

import { DeckSourceError, type DeckRef, type DeckSource, type RawSourcePayload } from '../deck-source';

import { MOXFIELD_PAYLOAD_MEDIA_TYPE } from './constants';
import { MoxfieldDeckSource, type MoxfieldDeckSourceOptions } from './moxfield-deck-source';
import { moxfieldPrimerToMarkdown } from './primer-markup';
import { moxfieldRestoreExport } from './restore-text';
import { cloudflareBlockResponse, fakeFetch, jsonResponse, v1Primer, v3Deck } from './test-fixtures';

const REF: DeckRef = { source: 'moxfield', externalId: 'FixtureDeckId_00000001' };
const DECK_PATH = '/v3/decks/all/FixtureDeckId_00000001';
const PRIMER_PATH = '/v1/decks/Fx001/primer';
const START = Date.parse('2026-10-09T12:00:00.000Z');

type Route = () => Response;

function setup(routes: Record<string, Route> = {}, options: MoxfieldDeckSourceOptions = {}) {
  let now = START;
  const table: Record<string, Route> = {
    [DECK_PATH]: () => jsonResponse(v3Deck()),
    [PRIMER_PATH]: () => jsonResponse(v1Primer()),
    ...routes,
  };
  const fetchImpl = fakeFetch((url) => {
    const route = table[new URL(url).pathname];
    return route ? route() : jsonResponse({ title: 'Not Found' }, 404);
  });
  const source = new MoxfieldDeckSource({
    fetchImpl,
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    ...options,
  });
  return {
    source,
    paths: () => fetchImpl.calls.map((call) => new URL(call.url).pathname),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<DeckSourceError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DeckSourceError);
  return error as DeckSourceError;
}

describe('MoxfieldDeckSource', () => {
  it('implements the DeckSource contract', () => {
    const source: DeckSource = new MoxfieldDeckSource();
    expect(source.id).toBe('moxfield');
    expect(source.displayName).toBe('Moxfield');
    expect(source.serverFetchStatus()).toEqual({ state: 'available' });
  });

  it('parses deck URLs and builds deck URLs for the configured site', () => {
    const { source } = setup({}, { siteOrigin: 'http://localhost:4010' });
    expect(source.parseDeckUrl('http://localhost:4010/decks/FixtureDeckId_00000001/primer')).toEqual({
      ok: true,
      ref: REF,
      canonicalUrl: 'http://localhost:4010/decks/FixtureDeckId_00000001',
    });
    expect(source.parseDeckUrl('https://moxfield.com/decks/FixtureDeckId_00000001').ok).toBe(false);
    expect(source.deckUrl(REF)).toBe('http://localhost:4010/decks/FixtureDeckId_00000001');
  });

  it('fetches deck and primer and normalizes them end to end', async () => {
    const { source, paths } = setup();
    const raw = await source.getDeck(REF);
    expect(paths()).toEqual([DECK_PATH, PRIMER_PATH]);
    expect(raw).toEqual({
      source: 'moxfield',
      mediaType: MOXFIELD_PAYLOAD_MEDIA_TYPE,
      data: { deck: v3Deck(), primer: v1Primer() },
    });

    const stored = JSON.parse(JSON.stringify(raw)) as RawSourcePayload;
    const normalized = source.normalizeDeck(stored);
    expect(normalized.warnings).toEqual([]);
    expect(Object.keys(normalized.snapshot.zones)).toEqual(['commanders', 'mainboard', 'considering']);
    expect(normalized.metadata).toMatchObject({
      externalId: REF.externalId,
      internalId: 'Fx001',
      version: 2,
    });
    expect(normalized.snapshot.primer).toContain('===panel: Introduction');
  });

  it('produces the same snapshot from a browser capture as from a server fetch', async () => {
    const { source } = setup();
    const fromServer = source.normalizeDeck(await source.getDeck(REF));
    const captured = source.parseCapturedPayload({
      kind: 'git-moxfield/capture',
      version: 1,
      source: 'moxfield',
      pageUrl: 'https://moxfield.com/decks/FixtureDeckId_00000001',
      capturedAt: '2026-10-09T12:00:00.000Z',
      deck: v3Deck(),
      primer: v1Primer(),
      primerError: null,
    });
    expect(captured.mediaType).toBe(MOXFIELD_PAYLOAD_MEDIA_TYPE);
    expect(source.normalizeDeck(captured)).toEqual(fromServer);
  });

  it('keeps the deck when the primer request fails', async () => {
    const { source, paths } = setup({ [PRIMER_PATH]: () => new Response(null, { status: 500 }) });
    const raw = await source.getDeck(REF);
    expect(paths()).toEqual([DECK_PATH, PRIMER_PATH, PRIMER_PATH]);
    expect(raw.data).toEqual({
      deck: v3Deck(),
      primer: null,
      primerError: 'unavailable: Moxfield answered HTTP 500.',
    });
    const normalized = source.normalizeDeck(raw);
    expect(normalized.snapshot.primer).toBeNull();
    expect(normalized.warnings.map((w) => w.code)).toEqual(['primer-unavailable']);
  });

  it('skips the primer request when the deck has no internal id', async () => {
    const { id: _id, ...deck } = v3Deck();
    const { source, paths } = setup({ [DECK_PATH]: () => jsonResponse(deck) });
    const raw = await source.getDeck(REF);
    expect(paths()).toEqual([DECK_PATH]);
    expect(raw.data).toMatchObject({
      primer: null,
      primerError: expect.stringContaining('no internal id') as unknown,
    });
  });

  it('propagates deck errors', async () => {
    const { source } = setup({ [DECK_PATH]: () => jsonResponse({ title: 'Not Found' }, 404) });
    expect((await failure(source.getDeck(REF))).code).toBe('not-found');
  });

  it('rejects references that are not Moxfield deck ids without a request', async () => {
    const { source, paths } = setup();
    expect((await failure(source.getDeck({ source: 'archidekt', externalId: '123456' }))).code).toBe(
      'invalid-ref',
    );
    expect((await failure(source.getDeck({ source: 'moxfield', externalId: '../x' }))).code).toBe(
      'invalid-ref',
    );
    expect(paths()).toEqual([]);
  });

  it('pauses server fetches after a block and reports it', async () => {
    let blocked = true;
    const { source, paths, advance } = setup({
      [DECK_PATH]: () => (blocked ? cloudflareBlockResponse() : jsonResponse(v3Deck())),
    });
    expect((await failure(source.getDeck(REF))).code).toBe('blocked');
    expect(source.serverFetchStatus()).toEqual({
      state: 'blocked',
      reason: expect.stringContaining('bot protection') as unknown,
      retryAt: '2026-10-09T13:00:00.000Z',
    });

    advance(60_000);
    const shortCircuit = await failure(source.getDeck(REF));
    expect(shortCircuit).toMatchObject({ code: 'blocked', retryAfterSeconds: 3_540 });
    expect(paths()).toEqual([DECK_PATH]);

    blocked = false;
    advance(3_540_000);
    expect(source.serverFetchStatus()).toEqual({ state: 'available' });
    await expect(source.getDeck(REF)).resolves.toMatchObject({ source: 'moxfield' });
  });

  it('resumes server fetches on request, before the block backoff has passed', async () => {
    let blocked = true;
    const { source, paths } = setup({
      [DECK_PATH]: () => (blocked ? cloudflareBlockResponse() : jsonResponse(v3Deck())),
    });
    expect((await failure(source.getDeck(REF))).code).toBe('blocked');
    expect(source.serverFetchStatus().state).toBe('blocked');

    blocked = false;
    source.resumeServerFetch();
    expect(source.serverFetchStatus()).toEqual({ state: 'available' });
    await expect(source.getDeck(REF)).resolves.toMatchObject({ source: 'moxfield' });
    expect(paths().filter((path) => path === DECK_PATH)).toHaveLength(2);
  });

  it('keeps the deck when only the primer request is blocked', async () => {
    const { source } = setup({ [PRIMER_PATH]: () => cloudflareBlockResponse() });
    const raw = await source.getDeck(REF);
    expect(raw.data).toMatchObject({
      primer: null,
      primerError: expect.stringMatching(/^blocked: /) as unknown,
    });
    expect(source.serverFetchStatus().state).toBe('blocked');
  });

  it('never fetches when server fetching is off', async () => {
    const { source, paths } = setup({}, { serverFetch: 'off' });
    expect(source.serverFetchStatus()).toEqual({
      state: 'disabled',
      reason: expect.stringContaining('turned off') as unknown,
    });
    expect((await failure(source.getDeck(REF))).code).toBe('blocked');
    expect((await failure(source.getDeckMetadata(REF))).code).toBe('blocked');
    expect(paths()).toEqual([]);
  });

  it('derives metadata via getDeck', async () => {
    const { source } = setup();
    await expect(source.getDeckMetadata(REF)).resolves.toMatchObject({
      source: 'moxfield',
      externalId: REF.externalId,
      url: 'https://moxfield.com/decks/FixtureDeckId_00000001',
      version: 2,
      reportedCounts: { commanders: 2, mainboard: 4, considering: 2 },
    });
  });

  it('rejects payloads of other sources, media types or malformed wrappers', () => {
    const { source } = setup();
    const data = { deck: v3Deck(), primer: null };
    expect(() =>
      source.normalizeDeck({ source: 'other', mediaType: MOXFIELD_PAYLOAD_MEDIA_TYPE, data }),
    ).toThrow(DeckSourceError);
    expect(() => source.normalizeDeck({ source: 'moxfield', mediaType: 'application/json', data })).toThrow(
      /Unsupported payload/,
    );
    expect(() =>
      source.normalizeDeck({ source: 'moxfield', mediaType: MOXFIELD_PAYLOAD_MEDIA_TYPE, data: 'x' }),
    ).toThrow(/malformed/);
  });

  it('rejects unusable captures with a schema error', () => {
    const { source } = setup();
    expect(() => source.parseCapturedPayload('garbage')).toThrow(DeckSourceError);
  });

  it('delegates restore export and primer conversion', () => {
    const { source } = setup();
    const snapshot = buildSnapshot({ zones: { mainboard: ['Island'] } });
    expect(source.exportForRestore(snapshot)).toEqual(moxfieldRestoreExport(snapshot));
    expect(source.primerToMarkdown('[[Sol Ring]]')).toBe(moxfieldPrimerToMarkdown('[[Sol Ring]]'));
  });
});
