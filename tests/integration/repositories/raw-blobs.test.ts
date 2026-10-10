import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { createTestRepositories, expectRepositoryError, countRows } from '@tests/support/db';

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
  it('round-trips the payload exactly', () => {
    const { repos } = createTestRepositories();
    const data = { deck: deckPayload(3), primer: { content: 'Ünïcødé ✓\n' }, list: [1, 2.5, null, true] };

    const hash = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });

    expect(repos.rawBlobs.get(hash)).toEqual({ mediaType: MEDIA_TYPE, data });
  });

  it('keys blobs by the SHA-256 of the exact JSON.stringify bytes', () => {
    const { repos } = createTestRepositories();
    // Key order is preserved (not canonicalized): the raw payload is kept as received.
    const data = { b: 1, a: 'ä' };
    const hash = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    expect(hash).toBe(createHash('sha256').update(Buffer.from('{"b":1,"a":"ä"}', 'utf8')).digest('hex'));
    expect(repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { a: 'ä', b: 1 } })).not.toBe(hash);
  });

  it('stores gzip-compressed bytes and reports sizes', () => {
    const { db, repos } = createTestRepositories();
    const data = deckPayload();
    const json = JSON.stringify(data);

    const hash = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    const info = repos.rawBlobs.info(hash);

    expect(info).toEqual({
      hash,
      mediaType: MEDIA_TYPE,
      encoding: 'gzip',
      byteLength: Buffer.byteLength(json, 'utf8'),
      compressedByteLength: expect.any(Number) as number,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(info?.compressedByteLength).toBeLessThan((info?.byteLength ?? 0) / 5);
    const stored = db.$client.prepare('SELECT data FROM raw_blobs WHERE hash = ?').get(hash) as {
      data: Buffer;
    };
    expect(stored.data.byteLength).toBe(info?.compressedByteLength);
    expect(gunzipSync(stored.data).toString('utf8')).toBe(json);
    expect(repos.rawBlobs.info('0'.repeat(64))).toBeNull();
  });

  it('is idempotent and keeps the first media type for identical bytes', () => {
    const { db, repos } = createTestRepositories();
    const data = deckPayload(5);
    const first = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data });
    const second = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: structuredClone(data) });
    const relabelled = repos.rawBlobs.put({ mediaType: 'application/json', data });

    expect(second).toBe(first);
    expect(relabelled).toBe(first);
    expect(countRows(db, 'raw_blobs')).toBe(1);
    expect(repos.rawBlobs.get(first)?.mediaType).toBe(MEDIA_TYPE);
  });

  it('accepts any JSON value and rejects values JSON cannot represent', () => {
    const { repos } = createTestRepositories();
    for (const data of [null, 0, 'text', [], {}]) {
      expect(repos.rawBlobs.get(repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data }))?.data).toEqual(data);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expectRepositoryError(
      () => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: undefined }),
      'invalid-input',
    );
    expectRepositoryError(
      () => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: circular }),
      'invalid-input',
    );
    expectRepositoryError(() => repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: 10n }), 'invalid-input');
    expectRepositoryError(() => repos.rawBlobs.put({ mediaType: ' ', data: {} }), 'invalid-input');
  });

  it('returns null for unknown hashes', () => {
    const { repos } = createTestRepositories();
    expect(repos.rawBlobs.get('0'.repeat(64))).toBeNull();
  });

  it('detects stored bytes that do not match their hash', () => {
    const { db, repos } = createTestRepositories();
    const hash = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { real: true } });
    const forged = 'c'.repeat(64);
    db.$client
      .prepare(
        `INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at)
         SELECT ?, media_type, encoding, byte_length, data, created_at FROM raw_blobs WHERE hash = ?`,
      )
      .run(forged, hash);
    expectRepositoryError(() => repos.rawBlobs.get(forged), 'corrupt-data');

    const garbage = 'd'.repeat(64);
    db.$client
      .prepare(
        'INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(garbage, MEDIA_TYPE, 'gzip', 3, Buffer.from('not gzip'), '2026-01-01T00:00:00.000Z');
    expectRepositoryError(() => repos.rawBlobs.get(garbage), 'corrupt-data');

    const zstd = 'e'.repeat(64);
    db.$client
      .prepare(
        'INSERT INTO raw_blobs (hash, media_type, encoding, byte_length, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(zstd, MEDIA_TYPE, 'zstd', 3, Buffer.from('xyz'), '2026-01-01T00:00:00.000Z');
    expectRepositoryError(() => repos.rawBlobs.get(zstd), 'unsupported-version');
  });

  it('is immutable: stored blobs cannot be updated', () => {
    const { db, repos } = createTestRepositories();
    const hash = repos.rawBlobs.put({ mediaType: MEDIA_TYPE, data: { a: 1 } });
    expect(() =>
      db.$client.prepare("UPDATE raw_blobs SET media_type = 'x' WHERE hash = ?").run(hash),
    ).toThrow(/raw blobs are immutable/);
  });
});
