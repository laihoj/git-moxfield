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

const KNOWN_TYPES: Record<string, { typeLine: string; manaCost: string }> = {
  island: { typeLine: 'Basic Land — Island', manaCost: '' },
  swamp: { typeLine: 'Basic Land — Swamp', manaCost: '' },
  plains: { typeLine: 'Basic Land — Plains', manaCost: '' },
  mountain: { typeLine: 'Basic Land — Mountain', manaCost: '' },
  forest: { typeLine: 'Basic Land — Forest', manaCost: '' },
  'command tower': { typeLine: 'Land', manaCost: '' },
  'sol ring': { typeLine: 'Artifact', manaCost: '{1}' },
  'tymna the weaver': { typeLine: 'Legendary Creature — Human Cleric', manaCost: '{1}{W}{B}' },
  "kraum, ludevic's opus": { typeLine: 'Legendary Creature — Zombie Horror', manaCost: '{3}{U}{R}' },
  'tana, the bloodsower': { typeLine: 'Legendary Creature — Elf Druid', manaCost: '{2}{R}{G}' },
  "thassa's oracle": { typeLine: 'Creature — Merfolk Wizard', manaCost: '{U}{U}' },
  'orcish bowmasters': { typeLine: 'Creature — Orc Archer', manaCost: '{1}{B}' },
  'dress down': { typeLine: 'Enchantment', manaCost: '{1}{U}' },
  'underworld breach': { typeLine: 'Enchantment', manaCost: '{1}{R}' },
  'rhystic study': { typeLine: 'Enchantment', manaCost: '{2}{U}' },
  'mnemonic betrayal': { typeLine: 'Sorcery', manaCost: '{1}{U}{B}' },
  'demonic tutor': { typeLine: 'Sorcery', manaCost: '{1}{B}' },
  'beseech the mirror': { typeLine: 'Sorcery', manaCost: '{1}{B}{B}{B}' },
  'final fortune': { typeLine: 'Instant', manaCost: '{R}{R}' },
  'peer into the abyss': { typeLine: 'Sorcery', manaCost: '{4}{B}{B}{B}' },
  'force of will': { typeLine: 'Instant', manaCost: '{3}{U}{U}' },
  'mana vault': { typeLine: 'Artifact', manaCost: '{1}' },
  'birgi, god of storytelling // harnfel, horn of bounty': {
    typeLine: 'Legendary Creature — God // Legendary Artifact',
    manaCost: '',
  },
};

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
  const s: Exclude<MoxCardSpec, string> = typeof spec === 'string' ? parseString(spec) : spec;
  const known = KNOWN_TYPES[s.name.toLowerCase()];
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

function parseString(spec: string): { name: string; quantity: number } {
  const match = /^(\d+)\s+(.+)$/.exec(spec.trim());
  if (!match) return { name: spec.trim(), quantity: 1 };
  const [, quantity = '1', name = ''] = match;
  return { name, quantity: Number(quantity) };
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

/** Builds a `GET /v3/decks/all/{publicId}` response body. */
export function buildMoxfieldDeck(spec: MoxDeckSpec): Record<string, unknown> {
  const user = { userName: 'fixture-user', displayName: 'Fixture User', badges: [] };
  const commanderBoard = board('commanders', spec.commanders);
  // Moxfield marks the second partner with boardType 'partners'.
  Object.values(commanderBoard.cards).forEach((entry, index) => {
    if (index > 0) (entry as { boardType: string }).boardType = 'partners';
  });
  const boards: Record<string, unknown> = {
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
    name: spec.name ?? 'Fixture Deck',
    description: spec.description ?? '',
    format: spec.format ?? 'commander',
    visibility: 'public',
    publicUrl: `https://moxfield.com/decks/${spec.publicId}`,
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
    lastUpdatedAtUtc: spec.lastUpdatedAtUtc ?? '2026-10-01T12:00:00.000Z',
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
    lastUpdatedAtUtc: spec.lastUpdatedAtUtc ?? '2026-10-01T12:00:00.000Z',
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
    pageUrl: `https://moxfield.com/decks/${spec.publicId}`,
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
  mode: 'ok' | 'blocked' | 'rate-limited' | 'down' | 'primer-down' = 'ok';
  readonly requests: string[] = [];

  constructor(readonly apiBaseUrl = 'https://api2.moxfield.test') {}

  setDeck(spec: MoxDeckSpec): void {
    this.decks.set(spec.publicId, spec);
  }

  readonly fetch: typeof fetch = (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.requests.push(url.pathname);
    return Promise.resolve(this.respond(url));
  };

  private respond(url: URL): Response {
    if (this.mode === 'blocked') {
      return new Response(
        '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>Sorry, you have been blocked',
        {
          status: 403,
          headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-ray': 'test-ray' },
        },
      );
    }
    if (this.mode === 'rate-limited') {
      return new Response('{}', {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      });
    }
    if (this.mode === 'down') return new Response('upstream error', { status: 502 });

    const deckMatch = /^\/v3\/decks\/all\/([^/]+)$/.exec(url.pathname);
    if (deckMatch?.[1]) {
      const spec = this.decks.get(decodeURIComponent(deckMatch[1]));
      return spec ? json(buildMoxfieldDeck(spec)) : new Response('', { status: 404 });
    }
    const primerMatch = /^\/v1\/decks\/([^/]+)\/primer$/.exec(url.pathname);
    if (primerMatch?.[1]) {
      if (this.mode === 'primer-down') return new Response('upstream error', { status: 503 });
      const id = decodeURIComponent(primerMatch[1]);
      const spec = [...this.decks.values()].find((d) => moxfieldInternalId(d) === id);
      return spec ? json(buildMoxfieldPrimer(spec)) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
