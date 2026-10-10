/**
 * State of the mock Moxfield server: the decks it serves, its failure mode and a log of
 * the Moxfield-facing requests it answered.
 *
 * Decks are stored as {@link MoxDeckSpec}s and turned into API payloads by
 * `tests/support/moxfield-deck-builder.ts` on every request, so the mock serves exactly
 * the shapes the real adapter is tested against. Everything that arrives through the
 * control API is untrusted JSON and validated here; invalid input raises a
 * {@link MockRequestError} carrying the HTTP status the server answers with.
 *
 * The edit logic ({@link applyEditOps}) is pure, so it can be unit-tested without a server.
 */
import { z } from 'zod';

import { cardKey } from '@/core/card-key';
import { MOXFIELD_INTERNAL_ID_PATTERN, MOXFIELD_PUBLIC_ID_PATTERN } from '@/integrations/moxfield/constants';

import { moxfieldInternalId, type MoxCardSpec, type MoxDeckSpec } from '../support/moxfield-deck-builder';

/**
 * Failure modes of the mock API (the deck page and the control API always work):
 *
 * - `ok`: every request is answered normally.
 * - `blocked`: like Cloudflare's bot protection, requests that do not come from a browser
 *   get `403 text/html` with a `cf-ray` header. Browser requests (a `Mozilla/…` User-Agent
 *   plus the `Sec-Fetch-Site` header) still succeed, as on the real site, so the
 *   bookmarklet keeps working while server fetches are blocked.
 * - `rate-limited`: `429` with `Retry-After: 30` for everyone.
 * - `down`: `502` for everyone.
 * - `primer-down`: only the primer endpoint fails, with `503`.
 */
export const MOCK_MODES = ['ok', 'blocked', 'rate-limited', 'down', 'primer-down'] as const;
export type MockMode = (typeof MOCK_MODES)[number];

/** Deck zones the edit operations address (`considering` is Moxfield's `maybeboard`). */
export const MOCK_ZONES = ['commanders', 'companions', 'mainboard', 'sideboard', 'considering'] as const;
export type MockZone = (typeof MOCK_ZONES)[number];

/** The object form of a {@link MoxCardSpec}. */
export type MoxCardObject = Exclude<MoxCardSpec, string>;
export type MoxFinish = NonNullable<MoxCardObject['finish']>;

/**
 * One change to a deck, applied by `POST /__control/decks/:publicId/edit`. Cards are
 * matched by name, ignoring case, quote style and spacing (the app's `cardKey`).
 */
export type EditOp =
  /** Moves `quantity` copies (default: all) from one zone to another. */
  | { op: 'move'; card: string; from: MockZone; to: MockZone; quantity?: number }
  /** Adds copies; merges with an entry of the same card and printing. */
  | { op: 'add'; zone: MockZone; card: MoxCardSpec }
  /** Removes `quantity` copies (default: all). */
  | { op: 'remove'; zone: MockZone; card: string; quantity?: number }
  /** Sets the number of copies of a card that is in the zone; `0` removes it. */
  | { op: 'setQuantity'; zone: MockZone; card: string; quantity: number }
  /** Replaces the primer markup. */
  | { op: 'primer'; text: string }
  /** Renames the deck. */
  | { op: 'rename'; name: string }
  /** Switches every copy of a card in the zone to one printing (finish kept unless given). */
  | {
      op: 'setPrinting';
      zone: MockZone;
      card: string;
      set: string;
      collectorNumber: string;
      finish?: MoxFinish;
    };

/** Which kind of client sent a Moxfield-facing request. */
export type MockClientKind = 'browser' | 'server';

export interface MockRequestLogEntry {
  /** ISO timestamp. */
  at: string;
  method: string;
  /** Path including the query string. */
  path: string;
  status: number;
  client: MockClientKind;
}

export interface MockDeckSummary {
  publicId: string;
  /** Internal deck id used by the primer endpoint. */
  internalId: string;
  name: string;
  version: number;
  lastUpdatedAtUtc: string;
  /** Total copies per zone. */
  counts: Record<MockZone, number>;
}

/** Body of `GET /__control/state`. */
export interface MockStateSnapshot {
  mode: MockMode;
  decks: MockDeckSummary[];
  /** Moxfield-facing requests (API and deck pages), oldest first, at most {@link MAX_REQUEST_LOG_ENTRIES}. */
  requests: MockRequestLogEntry[];
}

/** A rejected control request; `status` is the HTTP status to answer with. */
export class MockRequestError extends Error {
  override readonly name = 'MockRequestError';

  constructor(
    readonly status: 400 | 404 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

/** Number of requests kept in the request log. */
export const MAX_REQUEST_LOG_ENTRIES = 500;

const MAX_QUANTITY = 999;
const MAX_PRIMER_LENGTH = 1_000_000;
const MAX_CARDS_PER_ZONE = 1_000;
const MAX_EDIT_OPS = 500;

/** Default `lastUpdatedAtUtc` of the deck builder, used when a stored spec has none. */
const BUILDER_DEFAULT_UPDATED_AT = '2026-10-01T12:00:00.000Z';

/** Boards the deck builder always emits; `extraBoards` must not override them. */
const BUILDER_BOARDS: ReadonlySet<string> = new Set([
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
]);

const FINISHES = ['nonFoil', 'foil', 'etched'] as const satisfies readonly MoxFinish[];

const STRING_CARD_SPEC = /^(?:(\d+)\s+)?(\S.*)$/s;

const quantitySchema = z.number().int().min(1).max(MAX_QUANTITY);
const cardNameSchema = z.string().trim().min(1).max(200);
const zoneSchema = z.enum(MOCK_ZONES);
const finishSchema = z.enum(FINISHES);
const setCodeSchema = z.string().trim().min(1).max(16);
const collectorNumberSchema = z.string().trim().min(1).max(16);
const safeKey = z.string().refine((key) => key !== '__proto__', 'Invalid key');

const cardObjectSchema = z.strictObject({
  name: cardNameSchema,
  quantity: quantitySchema.optional(),
  set: setCodeSchema.optional(),
  collectorNumber: collectorNumberSchema.optional(),
  finish: finishSchema.optional(),
  lang: z.string().trim().min(2).max(8).optional(),
  typeLine: z.string().max(200).optional(),
  manaCost: z.string().max(100).optional(),
  isProxy: z.boolean().optional(),
  isAlter: z.boolean().optional(),
}) satisfies z.ZodType<MoxCardObject>;

const cardStringSchema = z
  .string()
  .trim()
  .max(220)
  .refine(
    (spec) => parseCardString(spec) !== null,
    'Expected "Card Name" or "<quantity> Card Name" with a quantity of 1–999',
  );

const cardSpecSchema = z.union([cardStringSchema, cardObjectSchema]) satisfies z.ZodType<MoxCardSpec>;
const cardListSchema = z.array(cardSpecSchema).max(MAX_CARDS_PER_ZONE);

const deckBodySchema = z.strictObject({
  /** Optional; must equal the id in the URL when given. */
  publicId: z.string().optional(),
  id: z.string().regex(MOXFIELD_INTERNAL_ID_PATTERN, 'Invalid internal deck id').optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(10_000).optional(),
  format: z.string().trim().min(1).max(40).optional(),
  version: z.number().int().min(0).optional(),
  lastUpdatedAtUtc: z.iso.datetime().optional(),
  commanders: cardListSchema.optional(),
  companions: cardListSchema.optional(),
  mainboard: cardListSchema.optional(),
  sideboard: cardListSchema.optional(),
  considering: cardListSchema.optional(),
  extraBoards: z
    .record(
      z
        .string()
        .regex(/^[a-z][A-Za-z0-9]{0,39}$/, 'Board names are camelCase words')
        .refine((board) => !BUILDER_BOARDS.has(board), 'Use the dedicated field for this board'),
      cardListSchema,
    )
    .optional(),
  hubs: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  authorTags: z.record(safeKey, z.array(z.string().trim().min(1).max(60)).max(50)).optional(),
  primer: z.string().max(MAX_PRIMER_LENGTH).optional(),
}) satisfies z.ZodType<Omit<MoxDeckSpec, 'publicId'> & { publicId?: string }>;

const editOpSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('move'),
    card: cardNameSchema,
    from: zoneSchema,
    to: zoneSchema,
    quantity: quantitySchema.optional(),
  }),
  z.strictObject({ op: z.literal('add'), zone: zoneSchema, card: cardSpecSchema }),
  z.strictObject({
    op: z.literal('remove'),
    zone: zoneSchema,
    card: cardNameSchema,
    quantity: quantitySchema.optional(),
  }),
  z.strictObject({
    op: z.literal('setQuantity'),
    zone: zoneSchema,
    card: cardNameSchema,
    quantity: z.number().int().min(0).max(MAX_QUANTITY),
  }),
  z.strictObject({ op: z.literal('primer'), text: z.string().max(MAX_PRIMER_LENGTH) }),
  z.strictObject({ op: z.literal('rename'), name: z.string().trim().min(1).max(200) }),
  z.strictObject({
    op: z.literal('setPrinting'),
    zone: zoneSchema,
    card: cardNameSchema,
    set: setCodeSchema,
    collectorNumber: collectorNumberSchema,
    finish: finishSchema.optional(),
  }),
]) satisfies z.ZodType<EditOp>;

const editOpsSchema = z.array(editOpSchema).min(1, 'Expected at least one operation').max(MAX_EDIT_OPS);

const modeBodySchema = z.strictObject({ mode: z.enum(MOCK_MODES) });

function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.map(String).join('.') || '(body)'}: ${issue.message}`)
    .join('; ');
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MockRequestError(400, `Invalid ${what}: ${formatIssues(result.error)}`);
  return result.data;
}

/** Validates a control API edit body: a non-empty array of {@link EditOp}s. */
export function parseEditOps(body: unknown): EditOp[] {
  return parseInput(editOpsSchema, body, 'edit operations');
}

/** Validates a `POST /__control/mode` body (`{ mode }`) and returns the mode. */
export function parseModeBody(body: unknown): MockMode {
  return parseInput(modeBodySchema, body, 'mode').mode;
}

/**
 * Validates a full deck spec for `PUT /__control/decks/:publicId`. `publicId` comes from
 * the URL; the body may repeat it but must not contradict it.
 */
export function parseDeckSpec(publicId: string, body: unknown): MoxDeckSpec {
  if (!MOXFIELD_PUBLIC_ID_PATTERN.test(publicId)) {
    throw new MockRequestError(400, `Invalid Moxfield deck id: ${JSON.stringify(publicId)}`);
  }
  const parsed = parseInput(deckBodySchema, body, 'deck');
  if (parsed.publicId !== undefined && parsed.publicId !== publicId) {
    throw new MockRequestError(
      400,
      `The body's publicId ${parsed.publicId} does not match the URL (${publicId})`,
    );
  }
  return { ...parsed, publicId };
}

/** `'Island'` → 1 Island, `'3 Island'` → 3 Island; `null` for an invalid quantity. */
function parseCardString(spec: string): { name: string; quantity: number } | null {
  const match = STRING_CARD_SPEC.exec(spec.trim());
  if (!match) return null;
  const [, quantityText, name = ''] = match;
  const quantity = quantityText === undefined ? 1 : Number(quantityText);
  return quantity >= 1 && quantity <= MAX_QUANTITY ? { name: name.trim(), quantity } : null;
}

/** The object form of a card spec, as a fresh object. */
export function toCardObject(spec: MoxCardSpec): MoxCardObject {
  if (typeof spec !== 'string') return { ...spec };
  const parsed = parseCardString(spec);
  if (parsed === null) throw new MockRequestError(400, `Invalid card spec: ${JSON.stringify(spec)}`);
  return parsed;
}

function copies(entry: MoxCardObject): number {
  return entry.quantity ?? 1;
}

function isSameCard(entry: MoxCardObject, name: string): boolean {
  return cardKey(entry.name) === cardKey(name);
}

/** What makes two entries of the same card the same printing (as the builder emits it). */
function printingIdentity(entry: MoxCardObject): string {
  return [
    entry.set ?? '',
    entry.collectorNumber ?? '',
    entry.finish ?? 'nonFoil',
    entry.lang ?? 'en',
    String(entry.isProxy ?? false),
    String(entry.isAlter ?? false),
  ].join('\u0000');
}

/** Total copies per zone of a deck spec. */
export function zoneCounts(spec: MoxDeckSpec): Record<MockZone, number> {
  const count = (zone: MockZone): number =>
    (spec[zone] ?? []).reduce((n, card) => n + copies(toCardObject(card)), 0);
  return {
    commanders: count('commanders'),
    companions: count('companions'),
    mainboard: count('mainboard'),
    sideboard: count('sideboard'),
    considering: count('considering'),
  };
}

/**
 * Mutable view of a deck during an edit: zones are converted to object entries on first
 * use, so string specs (`'3 Island'`) and object specs are handled uniformly.
 */
class DeckEditor {
  private readonly zones = new Map<MockZone, MoxCardObject[]>();

  constructor(readonly spec: MoxDeckSpec) {}

  entries(zone: MockZone): MoxCardObject[] {
    let entries = this.zones.get(zone);
    if (!entries) {
      entries = (this.spec[zone] ?? []).map(toCardObject);
      this.zones.set(zone, entries);
    }
    return entries;
  }

  /** Writes the edited zones back into the spec and returns it. */
  finish(): MoxDeckSpec {
    for (const [zone, entries] of this.zones) this.spec[zone] = entries;
    return this.spec;
  }

  total(zone: MockZone, card: string): number {
    return this.entries(zone)
      .filter((entry) => isSameCard(entry, card))
      .reduce((n, entry) => n + copies(entry), 0);
  }

  /** Removes copies (default: all) and returns them, one chunk per printing taken from. */
  take(zone: MockZone, card: string, quantity: number | undefined): MoxCardObject[] {
    const available = this.total(zone, card);
    if (available === 0) throw new Error(`${card} is not in ${zone}`);
    const wanted = quantity ?? available;
    if (wanted > available) {
      throw new Error(
        `cannot take ${wanted} ${card} from ${zone}: there ${available === 1 ? 'is' : 'are'} only ${available}`,
      );
    }
    const entries = this.entries(zone);
    const chunks: MoxCardObject[] = [];
    let remaining = wanted;
    for (const entry of entries) {
      if (remaining === 0) break;
      if (!isSameCard(entry, card)) continue;
      const taken = Math.min(copies(entry), remaining);
      chunks.push({ ...entry, quantity: taken });
      entry.quantity = copies(entry) - taken;
      remaining -= taken;
    }
    this.zones.set(
      zone,
      entries.filter((entry) => copies(entry) > 0),
    );
    return chunks;
  }

  /** Adds copies, merging with an entry of the same card and printing. */
  put(zone: MockZone, chunk: MoxCardObject): void {
    const entries = this.entries(zone);
    const identity = printingIdentity(chunk);
    const existing = entries.find(
      (entry) => isSameCard(entry, chunk.name) && printingIdentity(entry) === identity,
    );
    if (existing) existing.quantity = copies(existing) + copies(chunk);
    else entries.push({ ...chunk, quantity: copies(chunk) });
  }

  apply(op: EditOp): void {
    switch (op.op) {
      case 'move': {
        if (op.from === op.to) throw new Error('"from" and "to" must be different zones');
        for (const chunk of this.take(op.from, op.card, op.quantity)) this.put(op.to, chunk);
        return;
      }
      case 'add':
        this.put(op.zone, toCardObject(op.card));
        return;
      case 'remove':
        this.take(op.zone, op.card, op.quantity);
        return;
      case 'setQuantity': {
        const current = this.total(op.zone, op.card);
        if (current === 0) throw new Error(`${op.card} is not in ${op.zone}; use "add" for new cards`);
        if (op.quantity < current) {
          this.take(op.zone, op.card, current - op.quantity);
        } else if (op.quantity > current) {
          const first = this.entries(op.zone).find((entry) => isSameCard(entry, op.card));
          if (first) first.quantity = copies(first) + op.quantity - current;
        }
        return;
      }
      case 'primer':
        this.spec.primer = op.text;
        return;
      case 'rename':
        this.spec.name = op.name;
        return;
      case 'setPrinting': {
        const entries = this.entries(op.zone);
        const index = entries.findIndex((entry) => isSameCard(entry, op.card));
        const first = entries[index];
        if (!first) throw new Error(`${op.card} is not in ${op.zone}`);
        const merged: MoxCardObject = {
          ...first,
          quantity: this.total(op.zone, op.card),
          set: op.set,
          collectorNumber: op.collectorNumber,
          finish: op.finish ?? first.finish ?? 'nonFoil',
        };
        // All copies collapse into the first entry's position.
        this.zones.set(
          op.zone,
          entries.flatMap((entry, i) => (i === index ? [merged] : isSameCard(entry, op.card) ? [] : [entry])),
        );
        return;
      }
    }
  }
}

/**
 * Applies edit operations to a deck, all or nothing, like one save on Moxfield: the
 * result has `version` incremented by one and `lastUpdatedAtUtc` set to `now`. The input
 * spec is not modified.
 *
 * @throws {MockRequestError} 400 naming the first operation that cannot be applied.
 */
export function applyEditOps(spec: MoxDeckSpec, ops: readonly EditOp[], now: Date): MoxDeckSpec {
  const editor = new DeckEditor(structuredClone(spec));
  ops.forEach((op, index) => {
    try {
      editor.apply(op);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new MockRequestError(400, `Operation ${index + 1} (${op.op}) failed: ${reason}`);
    }
  });
  const edited = editor.finish();
  edited.version = (spec.version ?? 1) + 1;
  edited.lastUpdatedAtUtc = now.toISOString();
  return edited;
}

export interface MockMoxfieldStateOptions {
  /** Returns the decks to start with (fresh objects on every call); used by {@link MockMoxfieldState.reset}. */
  seed: () => readonly MoxDeckSpec[];
  /** Clock for `lastUpdatedAtUtc` and the request log. Default: system time. */
  now?: () => Date;
}

/**
 * The mock's mutable state. Callers only ever receive copies, so a returned spec can be
 * changed freely without affecting what the server serves.
 */
export class MockMoxfieldState {
  private readonly decks = new Map<string, MoxDeckSpec>();
  private readonly requestLog: MockRequestLogEntry[] = [];
  private currentMode: MockMode = 'ok';
  private readonly seed: () => readonly MoxDeckSpec[];
  private readonly now: () => Date;

  constructor(options: MockMoxfieldStateOptions) {
    this.seed = options.seed;
    this.now = options.now ?? (() => new Date());
    this.reset();
  }

  get mode(): MockMode {
    return this.currentMode;
  }

  /** Validates and sets the mode from a control request body (`{ mode }`). */
  setMode(body: unknown): MockMode {
    this.currentMode = parseModeBody(body);
    return this.currentMode;
  }

  /** Restores the seeded decks, mode `ok`, and an empty request log. */
  reset(): void {
    this.decks.clear();
    for (const spec of this.seed()) {
      this.assertInternalIdFree(spec);
      this.decks.set(spec.publicId, structuredClone(spec));
    }
    this.currentMode = 'ok';
    this.requestLog.length = 0;
  }

  listDecks(): MoxDeckSpec[] {
    return [...this.decks.values()].map((spec) => structuredClone(spec));
  }

  getDeck(publicId: string): MoxDeckSpec | undefined {
    const spec = this.decks.get(publicId);
    return spec && structuredClone(spec);
  }

  /** The deck whose internal id (used by the primer endpoint) is `internalId`. */
  findDeckByInternalId(internalId: string): MoxDeckSpec | undefined {
    const spec = [...this.decks.values()].find((deck) => moxfieldInternalId(deck) === internalId);
    return spec && structuredClone(spec);
  }

  /**
   * Creates or replaces a deck from an untrusted body. Without an explicit `version`, a
   * replaced deck gets its previous version + 1 and a new deck version 1; without
   * `lastUpdatedAtUtc`, the current time.
   *
   * @throws {MockRequestError} 400 for an invalid spec; 409 when its internal id is
   * already used by another deck.
   */
  putDeck(publicId: string, body: unknown): { deck: MoxDeckSpec; created: boolean } {
    const parsed = parseDeckSpec(publicId, body);
    const previous = this.decks.get(publicId);
    const spec: MoxDeckSpec = {
      ...parsed,
      version: parsed.version ?? (previous ? (previous.version ?? 1) + 1 : 1),
      lastUpdatedAtUtc: parsed.lastUpdatedAtUtc ?? this.now().toISOString(),
    };
    this.assertInternalIdFree(spec);
    this.decks.set(publicId, spec);
    return { deck: structuredClone(spec), created: previous === undefined };
  }

  /** Deletes a deck (it then answers 404, like a deleted Moxfield deck). */
  deleteDeck(publicId: string): boolean {
    return this.decks.delete(publicId);
  }

  /**
   * Applies an untrusted list of edit operations atomically (see {@link applyEditOps}).
   * @throws {MockRequestError} 404 for an unknown deck, 400 for invalid operations.
   */
  editDeck(publicId: string, body: unknown): MoxDeckSpec {
    const spec = this.decks.get(publicId);
    if (!spec) throw new MockRequestError(404, `Unknown deck ${publicId}`);
    const edited = applyEditOps(spec, parseEditOps(body), this.now());
    this.decks.set(publicId, edited);
    return structuredClone(edited);
  }

  recordRequest(entry: Omit<MockRequestLogEntry, 'at'>): void {
    this.requestLog.push({ at: this.now().toISOString(), ...entry });
    if (this.requestLog.length > MAX_REQUEST_LOG_ENTRIES) this.requestLog.shift();
  }

  /** What `GET /__control/state` returns. */
  snapshot(): MockStateSnapshot {
    return {
      mode: this.currentMode,
      decks: [...this.decks.values()].map((spec) => ({
        publicId: spec.publicId,
        internalId: moxfieldInternalId(spec),
        name: spec.name ?? 'Fixture Deck',
        version: spec.version ?? 1,
        lastUpdatedAtUtc: spec.lastUpdatedAtUtc ?? BUILDER_DEFAULT_UPDATED_AT,
        counts: zoneCounts(spec),
      })),
      requests: this.requestLog.map((entry) => ({ ...entry })),
    };
  }

  private assertInternalIdFree(spec: MoxDeckSpec): void {
    const internalId = moxfieldInternalId(spec);
    for (const other of this.decks.values()) {
      if (other.publicId !== spec.publicId && moxfieldInternalId(other) === internalId) {
        throw new MockRequestError(
          409,
          `Internal deck id ${internalId} is already used by deck ${other.publicId}`,
        );
      }
    }
  }
}
