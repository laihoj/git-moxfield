/**
 * The Moxfield {@link DeckSource}: wires URL parsing, the HTTP client, capture parsing,
 * normalization, restore export and primer conversion together.
 */
import { isRecord } from '@/core/guards';
import type { CanonicalSnapshot, NormalizedDeck, SourceDeckMetadata } from '@/core/model';

import {
  isDeckSourceError,
  type DeckRef,
  type DeckSource,
  type FetchOptions,
  type ParseDeckUrlResult,
  type RawSourcePayload,
  type RestoreExport,
  type RestoreTarget,
  type ServerFetchStatus,
} from '../deck-source';

import { parseMoxfieldCapture } from './capture';
import {
  DEFAULT_MOXFIELD_API_BASE_URL,
  DEFAULT_MOXFIELD_SITE_ORIGIN,
  DEFAULT_MOXFIELD_TIMEOUT_MS,
  MOXFIELD_PAYLOAD_MEDIA_TYPE,
  MOXFIELD_SOURCE_ID,
} from './constants';
import { moxfieldError, moxfieldSchemaError } from './errors';
import { MoxfieldHttpClient, type MoxfieldHttpClientOptions } from './http-client';
import { normalizeMoxfieldPayload } from './normalize';
import type { MoxfieldRequestLimiter } from './request-limiter';
import { moxfieldPrimerToMarkdown } from './primer-markup';
import { moxfieldRestoreExport } from './restore-text';
import { parseMoxfieldPayloadData, type MoxfieldPayloadData } from './schema';
import { isValidMoxfieldPublicId, moxfieldDeckUrl, parseMoxfieldDeckInput } from './url';

/**
 * The HTTP client's options, all optional (defaults: `DEFAULT_MOXFIELD_*`) except the
 * request limiter, and the adapter's own.
 */
export interface MoxfieldDeckSourceOptions
  extends Partial<Omit<MoxfieldHttpClientOptions, 'limiter'>>, Pick<MoxfieldHttpClientOptions, 'limiter'> {
  /** Defaults to `https://moxfield.com`. */
  siteOrigin?: string;
  /** `auto` (default): fetch server-side, as the limiter allows. `off`: never fetch server-side. */
  serverFetch?: 'auto' | 'off';
}

const DISABLED_REASON =
  'Server-side fetching from Moxfield is turned off. Use the bookmarklet or paste the deck JSON instead.';

function deckInternalId(deck: unknown): string | null {
  return isRecord(deck) && typeof deck.id === 'string' && deck.id.length > 0 ? deck.id : null;
}

export class MoxfieldDeckSource implements DeckSource {
  readonly id = MOXFIELD_SOURCE_ID;
  readonly displayName = 'Moxfield';

  private readonly siteOrigin: string;
  private readonly serverFetch: 'auto' | 'off';
  private readonly limiter: MoxfieldRequestLimiter;
  private readonly client: MoxfieldHttpClient;

  /** @throws {TypeError} when `apiBaseUrl` is not an absolute http(s) URL. */
  constructor(options: MoxfieldDeckSourceOptions) {
    this.siteOrigin = options.siteOrigin ?? DEFAULT_MOXFIELD_SITE_ORIGIN;
    this.serverFetch = options.serverFetch ?? 'auto';
    this.limiter = options.limiter;
    this.client = new MoxfieldHttpClient({
      apiBaseUrl: options.apiBaseUrl ?? DEFAULT_MOXFIELD_API_BASE_URL,
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs ?? DEFAULT_MOXFIELD_TIMEOUT_MS,
      limiter: options.limiter,
      fetchImpl: options.fetchImpl,
      now: options.now,
      sleep: options.sleep,
      logger: options.logger,
    });
  }

  parseDeckUrl(input: string): ParseDeckUrlResult {
    return parseMoxfieldDeckInput(input, this.siteOrigin);
  }

  deckUrl(ref: DeckRef): string {
    return moxfieldDeckUrl(ref.externalId, this.siteOrigin);
  }

  async serverFetchStatus(): Promise<ServerFetchStatus> {
    if (this.serverFetch === 'off') return { state: 'disabled', reason: DISABLED_REASON };
    return this.limiter.status();
  }

  resumeServerFetch(): Promise<boolean> {
    return this.limiter.resume();
  }

  /**
   * Fetches the deck, then its primer. A primer failure is recorded as `primerError`
   * and never fails the deck. Throws without any request when server fetching is
   * disabled, or when the request limiter refuses (paused, backing off, busy, or its
   * database unreachable).
   *
   * @throws {DeckSourceError} `invalid-ref`, `blocked`, `rate-limited`, `unavailable` or a
   *   mapped HTTP error.
   */
  async getDeck(ref: DeckRef, options: FetchOptions = {}): Promise<RawSourcePayload> {
    if (ref.source !== MOXFIELD_SOURCE_ID || !isValidMoxfieldPublicId(ref.externalId)) {
      throw moxfieldError('invalid-ref', `Not a Moxfield deck reference: ${ref.source}:${ref.externalId}`);
    }
    if (this.serverFetch === 'off') throw moxfieldError('blocked', DISABLED_REASON);

    const deck = await this.client.getDeckJson(ref.externalId, options.signal);
    const data: MoxfieldPayloadData = { deck, primer: null };
    const internalId = deckInternalId(deck);
    if (internalId === null) {
      data.primerError = 'The deck data has no internal id, so the primer could not be requested.';
    } else {
      try {
        data.primer = await this.client.getPrimerJson(internalId, options.signal);
      } catch (error) {
        if (!isDeckSourceError(error)) throw error;
        data.primerError = `${error.code}: ${error.message}`;
      }
    }
    return { source: MOXFIELD_SOURCE_ID, mediaType: MOXFIELD_PAYLOAD_MEDIA_TYPE, data };
  }

  /** Implemented via {@link getDeck}; Moxfield has no cheaper metadata endpoint. */
  async getDeckMetadata(ref: DeckRef, options?: FetchOptions): Promise<SourceDeckMetadata> {
    return this.normalizeDeck(await this.getDeck(ref, options)).metadata;
  }

  parseCapturedPayload(data: unknown): RawSourcePayload {
    return {
      source: MOXFIELD_SOURCE_ID,
      mediaType: MOXFIELD_PAYLOAD_MEDIA_TYPE,
      data: parseMoxfieldCapture(data),
    };
  }

  normalizeDeck(raw: RawSourcePayload): NormalizedDeck {
    if (raw.source !== MOXFIELD_SOURCE_ID || raw.mediaType !== MOXFIELD_PAYLOAD_MEDIA_TYPE) {
      throw moxfieldSchemaError(
        `Unsupported payload for Moxfield: source ${JSON.stringify(raw.source)}, media type ${JSON.stringify(raw.mediaType)}.`,
      );
    }
    const data = parseMoxfieldPayloadData(raw.data);
    if (!data.ok) {
      throw moxfieldSchemaError('The stored Moxfield payload is malformed:', data.issues);
    }
    return normalizeMoxfieldPayload(data.value, { siteOrigin: this.siteOrigin });
  }

  exportForRestore(snapshot: CanonicalSnapshot, target?: RestoreTarget): RestoreExport {
    return moxfieldRestoreExport(snapshot, target);
  }

  primerToMarkdown(primer: string): string {
    return moxfieldPrimerToMarkdown(primer);
  }
}
