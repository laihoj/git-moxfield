/**
 * Content-addressed store of raw source payloads (the full, untrimmed data a deck was
 * normalized from). Payloads are stored as the exact `JSON.stringify` bytes of the
 * data, gzip-compressed; the key is the SHA-256 of the uncompressed bytes.
 */
import { constants, gunzipSync, gzipSync } from 'node:zlib';

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';

import { sha256Hex } from '@/core/hash';
import { commits, observations, rawBlobs } from '@/server/db/schema';

import { corruptData, decodeJson } from './codec';
import { batches, distinct, type DbExecutor, type RepositoryContext } from './context';
import { RepositoryError } from './errors';

/** The only encoding written today. */
const GZIP = 'gzip';

export interface RawBlobInput {
  /** Versioned media type describing `data`, e.g. `application/vnd.git-moxfield.moxfield.v1+json`. */
  mediaType: string;
  /** Any JSON-serializable value. */
  data: unknown;
}

export interface RawBlob {
  mediaType: string;
  /** The payload as parsed from the stored JSON. Untrusted. */
  data: unknown;
}

export interface RawBlobInfo {
  hash: string;
  mediaType: string;
  encoding: string;
  /** Size of the uncompressed JSON in bytes. */
  byteLength: number;
  /** Size of the stored, compressed bytes. */
  compressedByteLength: number;
  createdAt: string;
}

export interface RawBlobRepository {
  /**
   * Stores a payload and returns its hash (SHA-256 hex of the UTF-8 `JSON.stringify`
   * bytes). Idempotent: known bytes are not compressed or written again, and keep the
   * media type they were first stored with (identical bytes have identical meaning).
   *
   * @throws {RepositoryError} `invalid-input` when the data is not JSON-serializable or
   * the media type is empty.
   */
  put(input: RawBlobInput): string;
  /**
   * Loads and decompresses a payload, or `null` when unknown.
   * @throws {RepositoryError} `corrupt-data` when the stored bytes do not match the hash.
   */
  get(hash: string): RawBlob | null;
  /** Storage details without loading the payload, or `null` when unknown. */
  info(hash: string): RawBlobInfo | null;
}

export function createRawBlobRepository(ctx: RepositoryContext): RawBlobRepository {
  return {
    put({ mediaType, data }) {
      if (mediaType.trim() === '') throw new RepositoryError('invalid-input', 'Raw blob media type is empty');
      const bytes = Buffer.from(serialize(data), 'utf8');
      const hash = sha256Hex(bytes);
      const known = ctx.db
        .select({ hash: rawBlobs.hash })
        .from(rawBlobs)
        .where(eq(rawBlobs.hash, hash))
        .get();
      if (known) return hash;
      ctx.db
        .insert(rawBlobs)
        .values({
          hash,
          mediaType,
          encoding: GZIP,
          byteLength: bytes.byteLength,
          data: gzipSync(bytes, { level: constants.Z_BEST_COMPRESSION }),
          createdAt: ctx.now(),
        })
        .onConflictDoNothing()
        .run();
      return hash;
    },

    get(hash) {
      const row = ctx.db.select().from(rawBlobs).where(eq(rawBlobs.hash, hash)).get();
      if (!row) return null;
      const what = `Raw blob ${hash}`;
      if (row.encoding !== GZIP) {
        throw new RepositoryError('unsupported-version', `${what} uses unknown encoding ${row.encoding}`);
      }
      let bytes: Buffer;
      try {
        bytes = gunzipSync(row.data);
      } catch (cause) {
        throw new RepositoryError('corrupt-data', `${what} cannot be decompressed`, { cause });
      }
      if (bytes.byteLength !== row.byteLength || sha256Hex(bytes) !== hash) {
        throw corruptData(what, 'content does not match its hash');
      }
      return { mediaType: row.mediaType, data: decodeJson(bytes.toString('utf8'), what) };
    },

    info(hash) {
      const row = ctx.db
        .select({
          hash: rawBlobs.hash,
          mediaType: rawBlobs.mediaType,
          encoding: rawBlobs.encoding,
          byteLength: rawBlobs.byteLength,
          compressedByteLength: sql<number>`length(${rawBlobs.data})`,
          createdAt: rawBlobs.createdAt,
        })
        .from(rawBlobs)
        .where(eq(rawBlobs.hash, hash))
        .get();
      return row ?? null;
    },
  };
}

/** `JSON.stringify` typed honestly: it returns `undefined` for `undefined`, functions and symbols. */
const stringify: (value: unknown) => string | undefined = JSON.stringify;

function serialize(data: unknown): string {
  let json: string | undefined;
  try {
    json = stringify(data);
  } catch (cause) {
    throw new RepositoryError('invalid-input', 'Raw blob data is not JSON-serializable', { cause });
  }
  if (json === undefined)
    throw new RepositoryError('invalid-input', 'Raw blob data is not JSON-serializable');
  return json;
}

/**
 * Deletes those of `hashes` that no commit or observation references any more.
 * Returns the number of blobs deleted.
 */
export function deleteUnreferencedRawBlobs(db: DbExecutor, hashes: readonly string[]): number {
  let deleted = 0;
  for (const batch of batches(distinct(hashes))) {
    deleted += db
      .delete(rawBlobs)
      .where(
        and(
          inArray(rawBlobs.hash, batch),
          notExists(
            db
              .select({ one: sql`1` })
              .from(commits)
              .where(eq(commits.rawBlobHash, rawBlobs.hash)),
          ),
          notExists(
            db
              .select({ one: sql`1` })
              .from(observations)
              .where(eq(observations.rawBlobHash, rawBlobs.hash)),
          ),
        ),
      )
      .run().changes;
  }
  return deleted;
}
