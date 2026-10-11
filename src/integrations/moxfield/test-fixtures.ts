/**
 * Test-only helpers for the Moxfield adapter: cloned fixtures and builders for
 * synthetic payloads. Not imported by production code.
 */
import { expect } from 'vitest';

import v1PrimerJson from '@tests/fixtures/moxfield/v1-primer.json';
import v2DeckJson from '@tests/fixtures/moxfield/v2-deck.json';
import v3DeckJson from '@tests/fixtures/moxfield/v3-deck.json';
import { requestUrl } from '@tests/support/moxfield-api';

import { DeckSourceError } from '../deck-source';
import { CAPTURE_ENVELOPE_KIND, CAPTURE_PROTOCOL_VERSION } from './capture-protocol';

export type JsonObject = Record<string, unknown>;

/** A fresh, mutable copy of the sanitized v3 deck fixture. */
export function v3Deck(): typeof v3DeckJson {
  return structuredClone(v3DeckJson);
}

/** A fresh, mutable copy of the synthetic legacy v2 deck fixture. */
export function v2Deck(): typeof v2DeckJson {
  return structuredClone(v2DeckJson);
}

/** A fresh, mutable copy of the primer fixture. */
export function v1Primer(): typeof v1PrimerJson {
  return structuredClone(v1PrimerJson);
}

export interface EntrySpec {
  name: string;
  quantity?: unknown;
  set?: string;
  cn?: string;
  finish?: string;
  isFoil?: boolean;
  isAlter?: boolean;
  isProxy?: boolean;
  lang?: string;
  /** Moxfield printing id. */
  id?: string;
  uniqueCardId?: string;
  scryfallId?: string;
  typeLine?: string;
  manaCost?: string;
  layout?: string;
}

/** A synthetic v3 board entry. */
export function moxfieldEntry(spec: EntrySpec): JsonObject {
  return {
    quantity: 'quantity' in spec ? spec.quantity : 1,
    boardType: 'mainboard',
    finish: spec.finish ?? 'nonFoil',
    isFoil: spec.isFoil ?? spec.finish === 'foil',
    isAlter: spec.isAlter ?? false,
    isProxy: spec.isProxy ?? false,
    card: {
      id: spec.id ?? `p-${spec.name}`,
      uniqueCardId: spec.uniqueCardId ?? `u-${spec.name}`,
      scryfall_id: spec.scryfallId ?? `s-${spec.name}`,
      set: spec.set ?? 'tst',
      cn: spec.cn ?? '1',
      lang: spec.lang ?? 'en',
      name: spec.name,
      layout: spec.layout ?? 'normal',
      type_line: spec.typeLine ?? 'Artifact',
      mana_cost: spec.manaCost ?? '{1}',
      cmc: 1,
      color_identity: [],
    },
  };
}

/** A v3 board whose `count` defaults to the sum of numeric entry quantities. */
export function moxfieldBoard(entries: Record<string, JsonObject>, count?: number): JsonObject {
  const total = Object.values(entries).reduce(
    (n, entry) => n + (typeof entry.quantity === 'number' ? entry.quantity : 0),
    0,
  );
  return { count: count ?? total, cards: entries };
}

/** A minimal synthetic v3 deck with the given boards (an empty mainboard is added when missing). */
export function syntheticDeck(boards: Record<string, JsonObject>, extra: JsonObject = {}): JsonObject {
  return {
    id: 'Syn01',
    publicId: 'SyntheticDeckId_000001',
    name: 'Synthetic',
    format: 'commander',
    boards: { mainboard: moxfieldBoard({}), ...boards },
    ...extra,
  };
}

/** A `fetch` stand-in that answers from a route table and records requests. */
export function fakeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): typeof fetch & { calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return Object.assign(impl, { calls });
}

/** A JSON response. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** A Cloudflare-style block page. */
export function cloudflareBlockResponse(status = 403): Response {
  return new Response(
    '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked',
    {
      status,
      headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': '0123456789abcdef-AMS' },
    },
  );
}

/**
 * The capture envelope the bookmarklet sends for the fixture deck and primer; `overrides`
 * replace fields (also with invalid values, for the tests of what is refused).
 */
export function fixtureCaptureEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: CAPTURE_ENVELOPE_KIND,
    version: CAPTURE_PROTOCOL_VERSION,
    source: 'moxfield',
    pageUrl: 'https://moxfield.com/decks/FixtureDeckId_00000001',
    capturedAt: '2026-10-09T12:00:00.000Z',
    deck: v3Deck(),
    primer: v1Primer(),
    primerError: null,
    ...overrides,
  };
}

/**
 * Asserts that `fn` throws a `schema` {@link DeckSourceError} whose message contains every
 * `fragment`; returns the error.
 */
export function expectDeckSourceSchemaError(fn: () => unknown, ...fragments: string[]): DeckSourceError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeckSourceError);
  const error = caught as DeckSourceError;
  expect(error.code).toBe('schema');
  for (const fragment of fragments) expect(error.message).toContain(fragment);
  return error;
}
