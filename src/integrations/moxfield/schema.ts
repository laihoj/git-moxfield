/**
 * Lenient validation of Moxfield's (undocumented) JSON payloads.
 *
 * Only fields that normalization actually reads are validated. Unknown fields are
 * ignored, and non-essential fields fall back to `undefined` via `.catch()` when their
 * type changes, so an unrelated change on Moxfield's side never breaks ingestion.
 * Essentials (deck identity, boards, card names) produce readable issue paths instead.
 *
 * Maps keyed by user data (boards, board entries, author tags) are validated as plain
 * objects and iterated by the caller, so keys such as `__proto__` are never assigned
 * into fresh objects.
 */
import { z } from 'zod';

import { isRecord } from '@/core/guards';

import { MOXFIELD_PUBLIC_ID_PATTERN } from './constants';

/**
 * What a Moxfield {@link import('../deck-source').RawSourcePayload} carries: the
 * untouched JSON of the deck endpoint and of the primer endpoint.
 */
export interface MoxfieldPayloadData {
  /** JSON of `GET /v3/decks/all/{publicId}` (or the legacy v2 shape). Untrusted. */
  deck: unknown;
  /** JSON of `GET /v1/decks/{id}/primer`, or `null` when it was not retrieved. Untrusted. */
  primer: unknown;
  /** Why the primer could not be retrieved, when it could not. */
  primerError?: string;
}

/** Result of a schema parse: the parsed value, or readable `path: message` issues. */
export type SchemaParseResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export type PlainObject = Record<string, unknown>;

const plainObject = z.custom<PlainObject>(isRecord, { message: 'Invalid input: expected object' });

/** Optional string that degrades to `undefined` when the field changes type. */
const looseString = z.string().optional().catch(undefined);
const looseNumber = z.number().optional().catch(undefined);
const looseBoolean = z.boolean().optional().catch(undefined);

const userSchema = z.object({ userName: looseString }).optional().catch(undefined);

const cardFaceSchema = z.object({
  name: looseString,
  mana_cost: looseString,
  type_line: looseString,
});

/** The `card` object of a board entry. Only `name` is essential. */
export const moxfieldCardSchema = z.object({
  /** Moxfield printing id. */
  id: looseString,
  /** Moxfield oracle-level id, stable across printings. */
  uniqueCardId: looseString,
  scryfall_id: looseString,
  name: z.string().trim().min(1),
  set: looseString,
  cn: looseString,
  lang: looseString,
  layout: looseString,
  type_line: looseString,
  mana_cost: looseString,
  cmc: looseNumber,
  color_identity: z.array(z.string().catch('')).optional().catch(undefined),
  card_faces: z.array(cardFaceSchema.nullable().catch(null)).optional().catch(undefined),
});
export type MoxfieldCard = z.infer<typeof moxfieldCardSchema>;

/**
 * One entry of a board. `quantity` and `card` are checked by normalization so that a
 * bad entry becomes a warning instead of failing the whole deck.
 */
export const moxfieldBoardEntrySchema = z.object({
  quantity: z.unknown().optional(),
  finish: looseString,
  isFoil: looseBoolean,
  isAlter: looseBoolean,
  isProxy: looseBoolean,
  card: z.unknown().optional(),
});
export type MoxfieldBoardEntry = z.infer<typeof moxfieldBoardEntrySchema>;

/** A v3 board: `{ count, cards: { [entryKey]: entry } }`. */
export const moxfieldBoardSchema = z.object({
  count: looseNumber,
  cards: plainObject,
});
export type MoxfieldBoard = z.infer<typeof moxfieldBoardSchema>;

const hubSchema = z
  .union([z.string(), z.object({ name: z.string() }).transform((hub) => hub.name)])
  .nullable()
  .catch(null);

/** Deck fields git-moxfield relies on. Boards are validated separately, per board. */
export const moxfieldDeckSchema = z.object({
  /** Internal deck id, needed for the primer endpoint. */
  id: looseString,
  publicId: z.string().regex(MOXFIELD_PUBLIC_ID_PATTERN, 'Invalid input: expected a Moxfield deck id'),
  publicUrl: looseString,
  name: z.string(),
  description: looseString,
  format: looseString,
  visibility: looseString,
  version: z.number().int().optional().catch(undefined),
  createdAtUtc: looseString,
  lastUpdatedAtUtc: looseString,
  createdByUser: userSchema,
  authors: z.array(userSchema).optional().catch(undefined),
  hubs: z.array(hubSchema).optional().catch(undefined),
  authorTags: plainObject.optional().catch(undefined),
  enableMultiplePrintings: looseBoolean,
  /** v3 shape: all boards under one key. */
  boards: plainObject.optional(),
});
export type MoxfieldDeck = z.infer<typeof moxfieldDeckSchema>;

/** `GET /v1/decks/{id}/primer`. `content` is `""` when the deck has no primer. */
export const moxfieldPrimerSchema = z.object({
  content: z
    .string()
    .nullable()
    .transform((content) => content ?? ''),
  lastUpdatedAtUtc: looseString,
  lastUpdatedByUser: userSchema,
});
export type MoxfieldPrimer = z.infer<typeof moxfieldPrimerSchema>;

/** The stored payload wrapper. `deck` presence is checked; its content is checked later. */
const payloadDataSchema = z.object({
  deck: z.unknown().refine((deck) => deck !== undefined, 'Invalid input: expected deck JSON'),
  primer: z
    .unknown()
    .optional()
    .transform((primer) => primer ?? null),
  primerError: z.string().optional().catch(undefined),
});

/**
 * Board names that the legacy v2 shape kept as top-level maps of entries
 * (`deck.mainboard = { [cardName]: entry }`, counts in `deck.mainboardCount`).
 * `tokens` is excluded on purpose: top-level `tokens` is an array of token cards.
 */
export const LEGACY_BOARD_NAMES = [
  'commanders',
  'companions',
  'signatureSpells',
  'mainboard',
  'sideboard',
  'maybeboard',
  'attractions',
  'stickers',
  'contraptions',
  'planes',
  'schemes',
] as const;

/** Formats zod issues as `path: message` strings, prefixed with `prefix` when given. */
export function formatIssues(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((issue) => {
    const path = [...(prefix === undefined ? [] : [prefix]), ...issue.path.map(String)].join('.');
    return `${path || '(root)'}: ${issue.message}`;
  });
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown, prefix?: string): SchemaParseResult<T> {
  const result = schema.safeParse(data);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: formatIssues(result.error, prefix) };
}

/**
 * Validates the deck-level fields of a deck payload (v3 or legacy v2). Boards are not
 * validated here; see {@link parseMoxfieldBoard} and {@link parseMoxfieldBoardEntry}.
 */
export function parseMoxfieldDeck(data: unknown): SchemaParseResult<MoxfieldDeck> {
  return parseWith(moxfieldDeckSchema, data);
}

/** Validates a v3 board object. `path` prefixes issue paths (e.g. `boards.mainboard`). */
export function parseMoxfieldBoard(data: unknown, path?: string): SchemaParseResult<MoxfieldBoard> {
  return parseWith(moxfieldBoardSchema, data, path);
}

/** Validates the envelope of one board entry (not its card). */
export function parseMoxfieldBoardEntry(data: unknown, path?: string): SchemaParseResult<MoxfieldBoardEntry> {
  return parseWith(moxfieldBoardEntrySchema, data, path);
}

/** Validates the `card` object of a board entry. */
export function parseMoxfieldCard(data: unknown, path?: string): SchemaParseResult<MoxfieldCard> {
  return parseWith(moxfieldCardSchema, data, path);
}

/** Validates a primer endpoint payload. */
export function parseMoxfieldPrimer(data: unknown): SchemaParseResult<MoxfieldPrimer> {
  return parseWith(moxfieldPrimerSchema, data, 'primer');
}

/** Validates the stored {@link MoxfieldPayloadData} wrapper (not the deck inside it). */
export function parseMoxfieldPayloadData(data: unknown): SchemaParseResult<MoxfieldPayloadData> {
  const result = parseWith(payloadDataSchema, data);
  if (!result.ok) return result;
  const { deck, primer, primerError } = result.value;
  return { ok: true, value: primerError === undefined ? { deck, primer } : { deck, primer, primerError } };
}
