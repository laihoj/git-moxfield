/**
 * Moxfield-specific constants shared by the adapter modules.
 *
 * Moxfield has no public API; every assumption about its endpoints and payloads is
 * documented in `docs/moxfield-integration.md` and isolated in this directory.
 */
import { otherZone, type KnownZone, type ZoneId } from '@/core/zones';

/** {@link import('../deck-source').DeckSource} id of the Moxfield adapter. */
export const MOXFIELD_SOURCE_ID = 'moxfield';

/**
 * Media type of {@link import('../deck-source').RawSourcePayload.data} produced by this
 * adapter: a `MoxfieldPayloadData` object (`{ deck, primer, primerError? }`) holding the
 * untouched JSON of the deck and primer endpoints. Bump the version when that wrapper
 * shape changes, never because Moxfield's own JSON changes.
 */
export const MOXFIELD_PAYLOAD_MEDIA_TYPE = 'application/vnd.git-moxfield.moxfield-deck.v1+json';

export const DEFAULT_MOXFIELD_API_BASE_URL = 'https://api2.moxfield.com';
export const DEFAULT_MOXFIELD_SITE_ORIGIN = 'https://moxfield.com';

/** Defaults of the adapter's request handling (the app's configuration starts from the same values). */
export const DEFAULT_MOXFIELD_TIMEOUT_MS = 15_000;
export const DEFAULT_MOXFIELD_MIN_REQUEST_INTERVAL_MS = 1_000;
export const DEFAULT_MOXFIELD_BLOCK_BACKOFF_SECONDS = 3_600;

/**
 * Honest User-Agent sent by server-side fetches when no Moxfield-issued one is
 * configured. git-moxfield never impersonates a browser.
 */
export const DEFAULT_MOXFIELD_USER_AGENT = 'git-moxfield/0.1 (+https://github.com/laihoj/git-moxfield)';

/**
 * Deck ids as they appear in deck URLs (`/decks/{publicId}`). Observed ids are 22
 * characters; the range is deliberately wider so a format tweak does not break parsing.
 */
export const MOXFIELD_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;

/** Internal deck ids (`deck.id`, e.g. `A0j00`), used only for the primer endpoint. */
export const MOXFIELD_INTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Parts of the API paths `/v3/decks/all/{publicId}` and `/v1/decks/{internalId}/primer`. */
export const MOXFIELD_DECK_PATH_PREFIX = '/v3/decks/all/';
export const MOXFIELD_PRIMER_PATH_PREFIX = '/v1/decks/';
export const MOXFIELD_PRIMER_PATH_SUFFIX = '/primer';

/** The deck endpoint of a public deck id. */
export function moxfieldDeckApiPath(publicId: string): string {
  return `${MOXFIELD_DECK_PATH_PREFIX}${encodeURIComponent(publicId)}`;
}

/** The primer endpoint of a deck's internal id (the deck payload's `id`). */
export function moxfieldPrimerApiPath(internalId: string): string {
  return `${MOXFIELD_PRIMER_PATH_PREFIX}${encodeURIComponent(internalId)}${MOXFIELD_PRIMER_PATH_SUFFIX}`;
}

/** The deck id pattern as regular expression source without anchors, for embedding in a larger pattern. */
export const MOXFIELD_PUBLIC_ID_PATTERN_SOURCE = MOXFIELD_PUBLIC_ID_PATTERN.source.slice(1, -1);

/**
 * Moxfield board name → canonical zone. `maybeboard` is shown as "Considering" in
 * Moxfield's UI and becomes the `considering` zone. Boards missing here are kept as
 * `other:<slug>` zones (see {@link zoneForBoard}).
 */
export const BOARD_TO_ZONE = {
  commanders: 'commanders',
  companions: 'companions',
  signatureSpells: 'signatureSpells',
  mainboard: 'mainboard',
  sideboard: 'sideboard',
  maybeboard: 'considering',
  attractions: 'attractions',
  stickers: 'stickers',
  contraptions: 'contraptions',
  planes: 'planes',
  schemes: 'schemes',
  tokens: 'tokens',
} as const satisfies Record<string, KnownZone>;

export type MoxfieldBoardName = keyof typeof BOARD_TO_ZONE;

/** Whether `board` is one of the Moxfield boards listed in {@link BOARD_TO_ZONE}. */
export function isKnownMoxfieldBoard(board: string): board is MoxfieldBoardName {
  return Object.hasOwn(BOARD_TO_ZONE, board);
}

/** Zone for a Moxfield board name; unknown boards map to `other:<slug>`. */
export function zoneForBoard(board: string): ZoneId {
  return isKnownMoxfieldBoard(board) ? BOARD_TO_ZONE[board] : otherZone(board);
}
