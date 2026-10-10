import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  countRows,
  createTestRepositories,
  expectDatabaseError,
  expectRepositoryError,
} from '@tests/support/db';

const MEDIA_TYPE = 'application/vnd.git-moxfield.moxfield.v1+json';

/** A payload shaped like a Moxfield deck response: large and repetitive, like the real thing. */
function deckPayload(cards = 200): unknown {
  const entries = Object.fromEntries(
    Array.from({ length: cards }, (_, i) => [
      `card-${i}`,
      {
        quantity: 1,
        boardType: 'mainboard',
        finish: 'nonFoil',
        isFoil: false,
        card: {
          name: `Card number ${i}`,
          set: 'cmm',
          cn: String(i),
          type_line: 'Artifact',
          mana_cost: '{1}',
        },
      },
    ]),
  );
  return {
    id: 'A0j00',
    publicId: 'AbCdEfGhIjKlMnOpQrStUv',
    name: 'Blue Farm',
    version: 42,
    boards: { mainboard: { count: cards, cards: entries } },
  };
}

describe('raw blobs repository', () => {
  it('round-trips the payload exactly', async () => {
    const { repos } = await createTestRepositories();
    const data = { deck: deckPayload(3), primer: { content: 'Ünïcødé ✓\n' }, list: [1, 2.5, null, true] };

    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });

    expect(await repos.rawBlobs.get(hash)).toEqual({ mediaType: MEDIA_TYPE, data });
  });

  it('keys blobs by the SHA-256 of the exact JSON.stringify bytes', async () => {
    const { repos } = await createTestRepositories();
    // Key order is preserved (not canonicalized): the raw payload is kept as received.
    const data = { b: 1, a: 'ä' };
    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    expect(hash).toBe(createHash('sha256').update(Buffer.from('{"b":1,"a":"ä"}', 'utf8')).digest('hex'));
    expect(await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { a: 'ä', b: 1 } })).not.toBe(hash);
  });

  it('stores gzip-compressed bytes and reports sizes', async () => {
    const { db, repos } = await createTestRepositories();
    const data = deckPayload();
    const json = JSON.stringify(data);

    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    const info = await repos.rawBlobs.info(hash);

    expect(info).toEqual({
      hash,
      mediaType: MEDIA_TYPE,
      encoding: 'gzip',
      byteLength: Buffer.byteLength(json, 'utf8'),
      compressedByteLength: expect.any(Number) as number,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(info?.compressedByteLength).toBeLessThan((info?.byteLength ?? 0) / 5);
    const stored = (await db.all(sql`SELECT data FROM raw_blobs WHERE hash = ${hash}`))[0] as {
      data: Buffer;
    };
    expect(stored.data.byteLength).toBe(info?.compressedByteLength);
    expect(gunzipSync(stored.data).toString('utf8')).toBe(json);
    expect(await repos.rawBlobs.info('0'.repeat(64))).toBeNull();
  });

  it('is idempotent and keeps the first media type for identical bytes', async () => {
    const { db, repos } = await createTestRepositories();
    const data = deckPayload(5);
    const first = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    const second = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: structuredClone(data) });
    const relabelled = await repos.rawBlobs.put({ mediaType: 'application/json', data });

    expect(second).toBe(first);
    expect(relabelled).toBe(first);
    expect(await countRows(db, 'raw_blobs')).toBe(1);
    expect((await repos.rawBlobs.get(first))?.mediaType).toBe(MEDIA_TYPE);
  });

  it('accepts any JSON value and rejects values JSON cannot represent', async () => {
    const { repos } = await createTestRepositories();
    for (const data of [null, 0, 'text', [], {}]) {
      expect(
        (await repos.rawBlobs.get(await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data })))?.data,
      ).toEqual(data);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expectRepositoryError(
      () => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: undefined }),
      'invalid-input',
    );
    await expectRepositoryError(
      () => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: circular }),
      'invalid-input',
    );
    await expectRepositoryError(
      () => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: 10n }),
      'invalid-input',
    );
    await expectRepositoryError(() => repos.rawBlobs.put({ mediaType: ' ', data: {} }), 'invalid-input');
  });

  it('returns null for unknown hashes', async () => {
    const { repos } = await createTestRepositories();
    expect(await repos.rawBlobs.get('0'.repeat(64))).toBeNull();
  });

  it('detects stored bytes that do not match their hash', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { real: true } });
    const forged = 'c'.repeat(64);
    await db.run(sql`INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at)
         SELECT ${forged}, media_type, encoding, byte_length, data, created_at FROM raw_blobs WHERE hash = ${hash}`);
    await expectRepositoryError(() => repos.rawBlobs.get(forged), 'corrupt-data');

    const garbage = 'd'.repeat(64);
    await db.run(
      sql`INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at) VALUES (${garbage}, ${MEDIA_TYPE}, ${'gzip'}, ${3}, ${Buffer.from('not gzip')}, ${'2026-01-01T00:00:00.000Z'})`,
    );
    await expectRepositoryError(() => repos.rawBlobs.get(garbage), 'corrupt-data');

    const zstd = 'e'.repeat(64);
    await db.run(
      sql`INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at) VALUES (${zstd}, ${MEDIA_TYPE}, ${'zstd'}, ${3}, ${Buffer.from('xyz')}, ${'2026-01-01T00:00:00.000Z'})`,
    );
    await expectRepositoryError(() => repos.rawBlobs.get(zstd), 'unsupported-version');
  });

  it('is immutable: stored blobs cannot be updated', async () => {
    const { db, repos } = await createTestRepositories();
    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { a: 1 } });
    await expectDatabaseError(
      db.run(sql`UPDATE raw_blobs SET media_type = 'x' WHERE hash = ${hash}`),
      'trigger',
      /raw blobs are immutable/,
    );
  });

  it('refuses payloads too large to store, before writing anything', async () => {
    const { db, repos } = await createTestRepositories();
    // Random text barely compresses: about 4.8 MB of gzip, more than a remote libSQL
    // database accepts in one value (5,000,000 bytes, row included) minus a margin.
    const data = randomBytes(4_800_000).toString('base64');
    const error = await expectRepositoryError(
      repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data }),
      'invalid-input',
    );
    expect(error.message).toMatch(/too large to store: [\d,]+ bytes, the limit is 4,500,000 bytes/);
    expect(error.message).not.toContain(data.slice(0, 32));
    expect(await countRows(db, 'raw_blobs')).toBe(0);

    // Large payloads that compress well are fine.
    const compressible = 'Island '.repeat(1_000_000);
    const hash = await repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: compressible });
    expect((await repos.rawBlobs.get(hash))?.data).toBe(compressible);
  });
});
