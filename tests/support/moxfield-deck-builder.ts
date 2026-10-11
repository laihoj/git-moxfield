/**
 * Builds Moxfield-shaped API payloads (`GET /v3/decks/all/{publicId}` and
 * `GET /v1/decks/{id}/primer`) from simple card lists. Used by service integration
 * tests and by the mock Moxfield server, so both exercise the real adapter code.
 *
 * The shape mirrors tests/fixtures/moxfield/v3-deck.json (captured from the live API
 * and sanitized). Card ids are derived deterministically from card names so the same
 * card keeps the same `uniqueCardId` across builds, like on Moxfield.
 */
import { createHash } from 'node:crypto';

import { CAPTURE_ENVELOPE_KIND, CAPTURE_PROTOCOL_VERSION } from '@/integrations/moxfield/capture-protocol';
import { moxfieldDeckUrl } from '@/integrations/moxfield/url';

import { cardFacts } from './card-facts';
import { parseCardSpecString } from './card-spec';
import { answerMoxfieldApi, requestUrl, type MockMode } from './moxfield-api';

/** `'Island'`, `'3 Island'`, or an object for printing/finish control. */
export type MoxCardSpec =
  | string
  | {
      name: string;
      quantity?: number;
      set?: string;
      collectorNumber?: string;
      finish?: 'nonFoil' | 'foil' | 'etched';
      lang?: string;
      typeLine?: string;
      manaCost?: string;
      isProxy?: boolean;
      isAlter?: boolean;
    };

export interface MoxDeckSpec {
  publicId: string;
  /** Internal Moxfield deck id; used by the primer endpoint. Defaults to a derived id. */
  id?: string;
  name?: string;
  description?: string;
  format?: string;
  /** Moxfield's revision counter. */
  version?: number;
  lastUpdatedAtUtc?: string;
  commanders?: MoxCardSpec[];
  companions?: MoxCardSpec[];
  mainboard?: MoxCardSpec[];
  sideboard?: MoxCardSpec[];
  /** Moxfield `maybeboard`, shown as "Considering". */
  considering?: MoxCardSpec[];
  /** Extra boards by raw Moxfield board name (e.g. unknown future boards). */
  extraBoards?: Record<string, MoxCardSpec[]>;
  hubs?: string[];
  authorTags?: Record<string, string[]>;
  primer?: string;
}

interface NormalizedSpec {
  name: string;
  quantity: number;
  set: string;
  collectorNumber: string;
  finish: 'nonFoil' | 'foil' | 'etched';
  lang: string;
  typeLine: string;
  manaCost: string;
  isProxy: boolean;
  isAlter: boolean;
}

function shortHash(value: string, length: number): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, length);
}

/**
 * A synthetic collector number (1–400) derived from the card name, so every printing
 * looks like a real one (`(TST) 116`). Derived from hex: base64url digits are no base-36
 * number, and parsing them as one gave `NaN` or negative numbers for some names.
 */
function syntheticCollectorNumber(name: string): string {
  return String((createHash('sha256').update(name).digest().readUInt32BE(0) % 400) + 1);
}

function uuidFrom(value: string): string {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function normalizeSpec(spec: MoxCardSpec): NormalizedSpec {
  const s: Exclude<MoxCardSpec, string> = typeof spec === 'string' ? parseCardSpecString(spec) : spec;
  const known = cardFacts(s.name);
  return {
    name: s.name,
    quantity: s.quantity ?? 1,
    set: s.set ?? 'tst',
    collectorNumber: s.collectorNumber ?? syntheticCollectorNumber(s.name),
    finish: s.finish ?? 'nonFoil',
    lang: s.lang ?? 'en',
    typeLine: s.typeLine ?? known?.typeLine ?? 'Instant',
    manaCost: s.manaCost ?? known?.manaCost ?? '{1}',
    isProxy: s.isProxy ?? false,
    isAlter: s.isAlter ?? false,
  };
}

function colorIdentity(manaCost: string): string[] {
  const order = ['W', 'U', 'B', 'R', 'G'];
  return order.filter((c) => manaCost.includes(`{${c}}`));
}

/** A Moxfield `card` object. Ids are stable per name (oracle) and per printing. */
export function moxCard(spec: NormalizedSpec): Record<string, unknown> {
  const isDfc = spec.name.includes(' // ');
  const faces = isDfc ? spec.name.split(' // ') : [];
  const printingKey = `${spec.name}|${spec.set}|${spec.collectorNumber}`;
  return {
    id: shortHash(`printing:${printingKey}`, 5),
    uniqueCardId: shortHash(`oracle:${spec.name.toLowerCase()}`, 5),
    scryfall_id: uuidFrom(`scryfall:${printingKey}`),
    set: spec.set,
    set_name: `Set ${spec.set.toUpperCase()}`,
    name: spec.name,
    cn: spec.collectorNumber,
    layout: isDfc ? 'modal_dfc' : 'normal',
    cmc: (spec.manaCost.match(/\{[^}]+\}/g) ?? []).length,
    type: '0',
    type_line: spec.typeLine,
    mana_cost: isDfc ? '' : spec.manaCost,
    colors: colorIdentity(spec.manaCost),
    color_identity: colorIdentity(spec.manaCost),
    rarity: 'rare',
    lang: spec.lang,
    foil: true,
    nonfoil: true,
    etched: spec.finish === 'etched',
    released_at: '2020-01-01',
    isToken: false,
    defaultFinish: 'nonFoil',
    card_faces: faces.map((face, i) => ({
      name: face,
      mana_cost: i === 0 ? spec.manaCost : '',
      type_line: spec.typeLine.split(' // ')[i] ?? spec.typeLine,
    })),
  };
}

function board(
  boardType: string,
  specs: MoxCardSpec[] = [],
): { count: number; cards: Record<string, unknown> } {
  const cards: Record<string, unknown> = {};
  let count = 0;
  for (const raw of specs) {
    const spec = normalizeSpec(raw);
    const card = moxCard(spec);
    // Moxfield keys entries by uniqueCardId; a second printing of the same card gets
    // a distinct key (as with "enable multiple printings").
    let key = String(card.uniqueCardId);
    while (key in cards) key = `${key}_${String(card.id)}`;
    cards[key] = {
      quantity: spec.quantity,
      boardType,
      finish: spec.finish,
      isFoil: spec.finish === 'foil',
      isAlter: spec.isAlter,
      isProxy: spec.isProxy,
      card,
      useCmcOverride: false,
      useManaCostOverride: false,
      useColorIdentityOverride: false,
      usePrimaryTypeOverride: false,
      excludedFromColor: false,
    };
    count += spec.quantity;
  }
  return { count, cards };
}

export function moxfieldInternalId(spec: MoxDeckSpec): string {
  return spec.id ?? shortHash(`deck:${spec.publicId}`, 5);
}

/** What the builder fills in for a spec that leaves the deck's name or its last update out. */
export const BUILDER_DEFAULTS = {
  name: 'Fixture Deck',
  lastUpdatedAtUtc: '2026-10-01T12:00:00.000Z',
} as const;

/** The boards `buildMoxfieldDeck` always emits, which a spec's `extraBoards` must not override. */
export const BUILDER_BOARD_NAMES = [
  'mainboard',
  'sideboard',
  'maybeboard',
  'commanders',
  'companions',
  'signatureSpells',
  'attractions',
  'stickers',
  'contraptions',
  'planes',
  'schemes',
  'tokens',
] as const;

/** Builds a `GET /v3/decks/all/{publicId}` response body. */
export function buildMoxfieldDeck(spec: MoxDeckSpec): Record<string, unknown> {
  const user = { userName: 'fixture-user', displayName: 'Fixture User', badges: [] };
  const commanderBoard = board('commanders', spec.commanders);
  // Moxfield marks the second partner with boardType 'partners'.
  Object.values(commanderBoard.cards).forEach((entry, index) => {
    if (index > 0) (entry as { boardType: string }).boardType = 'partners';
  });
  const boards: Record<string, unknown> & Record<(typeof BUILDER_BOARD_NAMES)[number], unknown> = {
    mainboard: board('mainboard', spec.mainboard),
    sideboard: board('sideboard', spec.sideboard),
    maybeboard: board('maybeboard', spec.considering),
    commanders: commanderBoard,
    companions: board('companions', spec.companions),
    signatureSpells: board('signatureSpells'),
    attractions: board('attractions'),
    stickers: board('stickers'),
    contraptions: board('contraptions'),
    planes: board('planes'),
    schemes: board('schemes'),
    tokens: board('tokens'),
  };
  for (const [name, cards] of Object.entries(spec.extraBoards ?? {})) boards[name] = board(name, cards);
  return {
    id: moxfieldInternalId(spec),
    name: spec.name ?? BUILDER_DEFAULTS.name,
    description: spec.description ?? '',
    format: spec.format ?? 'commander',
    visibility: 'public',
    publicUrl: moxfieldDeckUrl(spec.publicId),
    publicId: spec.publicId,
    likeCount: 0,
    viewCount: 0,
    commentCount: 0,
    createdByUser: user,
    authors: [user],
    requestedAuthors: [],
    boards,
    version: spec.version ?? 1,
    tokens: [],
    hubs: (spec.hubs ?? []).map((name) => ({ name, description: '' })),
    createdAtUtc: '2026-01-01T00:00:00.000Z',
    lastUpdatedAtUtc: spec.lastUpdatedAtUtc ?? BUILDER_DEFAULTS.lastUpdatedAtUtc,
    exportId: uuidFrom(`export:${spec.publicId}`),
    authorTags: spec.authorTags ?? {},
    enableMultiplePrintings: false,
    media: [],
  };
}

/** Builds a `GET /v1/decks/{id}/primer` response body. */
export function buildMoxfieldPrimer(spec: MoxDeckSpec): Record<string, unknown> {
  return {
    content: spec.primer ?? '',
    lastUpdatedAtUtc: spec.lastUpdatedAtUtc ?? BUILDER_DEFAULTS.lastUpdatedAtUtc,
    lastUpdatedByUser: { userName: 'fixture-user', displayName: 'Fixture User', badges: [] },
  };
}

/** A capture envelope as the bookmarklet would post it. */
export function buildCaptureEnvelope(
  spec: MoxDeckSpec,
  capturedAt = '2026-10-09T12:00:00.000Z',
): Record<string, unknown> {
  return {
    kind: CAPTURE_ENVELOPE_KIND,
    version: CAPTURE_PROTOCOL_VERSION,
    source: 'moxfield',
    pageUrl: moxfieldDeckUrl(spec.publicId),
    capturedAt,
    deck: buildMoxfieldDeck(spec),
    primer: buildMoxfieldPrimer(spec),
    primerError: null,
  };
}

/**
 * A fake `fetch` serving decks from a mutable registry, for wiring the real
 * MoxfieldDeckSource in tests. Set `mode` to simulate failures.
 */
export class FakeMoxfieldApi {
  readonly decks = new Map<string, MoxDeckSpec>();
  mode: MockMode = 'ok';
  readonly requests: string[] = [];

  constructor(readonly apiBaseUrl = 'https://api2.moxfield.test') {}

  setDeck(spec: MoxDeckSpec): void {
    this.decks.set(spec.publicId, spec);
  }

  readonly fetch: typeof fetch = (input) => {
    const url = new URL(requestUrl(input));
    this.requests.push(url.pathname);
    return Promise.resolve(this.respond(url));
  };

  private respond(url: URL): Response {
    const answer = answerMoxfieldApi(url.pathname, {
      mode: this.mode,
      client: 'server',
      rayId: 'test-ray',
      deck: (publicId) => {
        const spec = this.decks.get(publicId);
        return spec && buildMoxfieldDeck(spec);
      },
      primer: (internalId) => {
        const spec = [...this.decks.values()].find((d) => moxfieldInternalId(d) === internalId);
        return spec && buildMoxfieldPrimer(spec);
      },
    });
    if (answer === null) return new Response('', { status: 404 });
    return new Response(answer.body, {
      status: answer.status,
      headers: { 'content-type': answer.contentType, ...answer.headers },
    });
  }
}
