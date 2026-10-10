/**
 * Content-addressed store of raw source payloads (the full, untrimmed data a deck was
 * normalized from). Payloads are stored as the exact `JSON.stringify` bytes of the
 * data, gzip-compressed; the key is the SHA-256 of the uncompressed bytes.
 */
import { promisify } from 'node:util';
import { constants, gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

import { and, eq, inArray, notExists, sql } from 'drizzle-orm';

import { sha256Hex } from '@/core/hash';
import { commits, observations, rawBlobs } from '@/server/db/schema';

import { corruptData, decodeJson } from './codec';
import {
  assertStorableSize,
  batches,
  distinct,
  write,
  type LibsqlExecutor,
  type RepositoryContext,
} from './context';
import { RepositoryError } from './errors';

/** The only encoding written today. */
const GZIP = 'gzip';

// Asynchronous: (de)compressing a large capture must not block the event loop.
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

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
   * @throws {RepositoryError} `invalid-input` when the data is not JSON-serializable, the
   * media type is empty, or the compressed payload is too large to store
   * (`MAX_STORED_VALUE_BYTES`).
   */
  put(input: RawBlobInput): Promise<string>;
  /**
   * Loads and decompresses a payload, or `null` when unknown.
   * @throws {RepositoryError} `corrupt-data` when the stored bytes do not match the hash.
   */
  get(hash: string): Promise<RawBlob | null>;
  /** Storage details without loading the payload, or `null` when unknown. */
  info(hash: string): Promise<RawBlobInfo | null>;
}

export function createRawBlobRepository(ctx: RepositoryContext): RawBlobRepository {
  return {
    async put({ mediaType, data }) {
      if (mediaType.trim() === '') throw new RepositoryError('invalid-input', 'Raw blob media type is empty');
      const bytes = Buffer.from(serialize(data), 'utf8');
      const hash = sha256Hex(bytes);
      const known = await ctx.db
        .select({ hash: rawBlobs.hash })
        .from(rawBlobs)
        .where(eq(rawBlobs.hash, hash))
        .get();
      if (known) return hash;
      const compressed = await gzip(bytes, { level: constants.Z_BEST_COMPRESSION });
      assertStorableSize(`Raw payload ${hash} (compressed)`, compressed.byteLength);
      const values = {
        hash,
        mediaType,
        encoding: GZIP,
        byteLength: bytes.byteLength,
        data: compressed,
        createdAt: ctx.now(),
      };
      await write(ctx, (db) => db.insert(rawBlobs).values(values).onConflictDoNothing());
      return hash;
    },

    async get(hash) {
      const row = await ctx.db.select().from(rawBlobs).where(eq(rawBlobs.hash, hash)).get();
      if (!row) return null;
      const bytes = await inflateRawBlob(row);
      return { mediaType: row.mediaType, data: decodeJson(bytes.toString('utf8'), `Raw blob ${hash}`) };
    },

    async info(hash) {
      const row = await ctx.db
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

/**
 * The uncompressed bytes of a stored raw blob row, verified against its hash and length.
 * @throws {RepositoryError} `unsupported-version` for an unknown encoding; `corrupt-data`
 *   when the bytes cannot be decompressed or do not match the hash.
 */
export async function inflateRawBlob(row: typeof rawBlobs.$inferSelect): Promise<Buffer> {
  const what = `Raw blob ${row.hash}`;
  if (row.encoding !== GZIP) {
    throw new RepositoryError('unsupported-version', `${what} uses unknown encoding ${row.encoding}`);
  }
  let bytes: Buffer;
  try {
    bytes = await gunzip(row.data);
  } catch (cause) {
    throw new RepositoryError('corrupt-data', `${what} cannot be decompressed`, { cause });
  }
  if (bytes.byteLength !== row.byteLength || sha256Hex(bytes) !== row.hash) {
    throw corruptData(what, 'content does not match its hash');
  }
  return bytes;
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
export async function deleteUnreferencedRawBlobs(
  db: LibsqlExecutor,
  hashes: readonly string[],
): Promise<number> {
  let deleted = 0;
  for (const batch of batches(distinct(hashes))) {
    const result = await db.delete(rawBlobs).where(
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
    );
    deleted += result.rowsAffected;
  }
  return deleted;
}
