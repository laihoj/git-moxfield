import { describe, expect, it } from 'vitest';

import { buildSnapshot } from '@tests/support/builders';

import { emptySnapshot, stableStringify } from './canonical';
import {
  COMMIT_OBJECT_VERSION,
  commitId,
  commitObjectOf,
  type CommitObject,
  deckReference,
  isContentAddressed,
  serializeCommitObject,
  sha256Hex,
  shortId,
  snapshotHash,
} from './hash';

// Pinned digests below were computed independently (Python hashlib), not with this module.

const base: CommitObject = {
  deck: 'moxfield:FixtureDeckId_00000001',
  snapshotHash: 'a'.repeat(64),
  parentId: 'b'.repeat(64),
  createdAt: '2026-10-09T12:34:56.789Z',
  sourceVersion: 42,
  message: 'Cut Dress Down\n\nMoved to considering.',
};

describe('sha256Hex', () => {
  it('matches known SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes strings as UTF-8 and accepts bytes', () => {
    expect(sha256Hex('\u00fb')).toBe('19d170e209f746158ddf6469043de8c43462cff01cee0023ede9b8ddd9480024');
    expect(sha256Hex(new TextEncoder().encode('\u00fb'))).toBe(sha256Hex('\u00fb'));
  });
});

describe('snapshotHash', () => {
  it('is the sha256 of the stable serialization', () => {
    const snapshot = buildSnapshot({ zones: { mainboard: ['Island'] } });
    expect(snapshotHash(snapshot)).toBe(sha256Hex(stableStringify(snapshot)));
    expect(snapshotHash(snapshot)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('pins the hash of the empty deck', () => {
    expect(snapshotHash(emptySnapshot())).toBe(
      '3ba0fdeaace9b5dc04247f2e14b1b2b883d89930e1de0bd8f4bfeb9ab672f9ed',
    );
  });

  it('is equal for semantically identical snapshots built differently', () => {
    const a = buildSnapshot({ zones: { mainboard: ['Island', '2 Swamp'] }, deck: { tags: ['b', 'a'] } });
    const b = buildSnapshot({
      zones: { mainboard: ['1 Swamp', 'Island', 'Swamp'] },
      deck: { tags: ['a', 'b'] },
    });
    expect(snapshotHash(b)).toBe(snapshotHash(a));
  });

  it('changes with any user-controlled state, including source ids', () => {
    const island = buildSnapshot({ zones: { mainboard: ['Island'] } });
    const variants = [
      buildSnapshot({ zones: { mainboard: ['2 Island'] } }),
      buildSnapshot({ zones: { sideboard: ['Island'] } }),
      buildSnapshot({ zones: { mainboard: ['Island'] }, primer: null }),
      buildSnapshot({ zones: { mainboard: ['Island'] }, cardTags: { Island: ['land'] } }),
      buildSnapshot({ zones: { mainboard: ['Island'] }, deck: { name: 'Other' } }),
      buildSnapshot({ zones: { mainboard: [{ name: 'Island', ids: { moxfield: 'island-id' } }] } }),
    ];
    const hashes = new Set([island, ...variants].map(snapshotHash));
    expect(hashes.size).toBe(variants.length + 1);
  });
});

describe('serializeCommitObject', () => {
  it('uses version 1 of the commit object format', () => {
    expect(COMMIT_OBJECT_VERSION).toBe(1);
  });

  it('serializes all headers, a blank line and the message', () => {
    expect(serializeCommitObject(base)).toBe(
      [
        'git-moxfield-commit 1',
        'deck moxfield:FixtureDeckId_00000001',
        `snapshot ${'a'.repeat(64)}`,
        `parent ${'b'.repeat(64)}`,
        'created-at 2026-10-09T12:34:56.789Z',
        'source-version 42',
        '',
        'Cut Dress Down',
        '',
        'Moved to considering.',
      ].join('\n'),
    );
  });

  it('omits the parent of a first version and an unknown source version', () => {
    expect(serializeCommitObject({ ...base, parentId: null, sourceVersion: null, message: 'Initial' })).toBe(
      [
        'git-moxfield-commit 1',
        'deck moxfield:FixtureDeckId_00000001',
        `snapshot ${'a'.repeat(64)}`,
        'created-at 2026-10-09T12:34:56.789Z',
        '',
        'Initial',
      ].join('\n'),
    );
  });

  it('keeps source version 0', () => {
    expect(serializeCommitObject({ ...base, sourceVersion: 0 })).toContain('\nsource-version 0\n');
  });

  it('serializes an empty message as an empty body', () => {
    expect(serializeCommitObject({ ...base, message: '' })).toMatch(/\nsource-version 42\n\n$/);
  });

  it('normalizes message line endings and Unicode composition, nothing else', () => {
    const lf = serializeCommitObject({ ...base, message: 'Line one\nLine two  \n\nLim-D\u00fbl\n' });
    expect(serializeCommitObject({ ...base, message: 'Line one\r\nLine two  \r\n\rLim-Du\u0302l\r\n' })).toBe(
      lf,
    );
    expect(lf.endsWith('\n\nLine one\nLine two  \n\nLim-D\u00fbl\n')).toBe(true);
  });

  it.each<[keyof CommitObject, string]>([
    ['deck', 'moxfield:abc\ninjected'],
    ['snapshotHash', `${'a'.repeat(64)}\n`],
    ['parentId', `${'b'.repeat(64)}\rparent ${'c'.repeat(64)}`],
    ['createdAt', '2026-10-09T12:34:56.789Z\r\n'],
  ])('rejects a multi-line %s header', (field, value) => {
    expect(() => serializeCommitObject({ ...base, [field]: value })).toThrow(TypeError);
  });
});

describe('commitId', () => {
  it('is the sha256 of the serialized commit object (pinned)', () => {
    expect(commitId(base)).toBe(sha256Hex(serializeCommitObject(base)));
    expect(commitId(base)).toBe('a104438459a87e4e917780d3b1aae0be4280267e2a1bd555bad4ed342e552ddd');
  });

  it.each<[string, Partial<CommitObject>]>([
    ['deck', { deck: 'moxfield:FixtureDeckId_00000002' }],
    ['snapshot hash', { snapshotHash: 'c'.repeat(64) }],
    ['parent', { parentId: 'c'.repeat(64) }],
    ['missing parent', { parentId: null }],
    ['creation time', { createdAt: '2026-10-09T12:34:56.790Z' }],
    ['source version', { sourceVersion: 43 }],
    ['unknown source version', { sourceVersion: null }],
    ['message', { message: 'Cut Dress Down' }],
    ['message whitespace', { message: 'Cut Dress Down\n\nMoved to considering. ' }],
  ])('changes when the %s changes', (_, change) => {
    expect(commitId({ ...base, ...change })).not.toBe(commitId(base));
  });

  it('does not change with message line-ending style', () => {
    expect(commitId({ ...base, message: base.message.replace(/\n/g, '\r\n') })).toBe(commitId(base));
  });
});

describe('deckReference, commitObjectOf and isContentAddressed', () => {
  const { deck: _deck, ...content } = base;

  it('builds the deck header from the source and the external id', () => {
    expect(deckReference({ source: 'moxfield', externalId: 'FixtureDeckId_00000001' })).toBe(base.deck);
  });

  it('puts stored commit content and a deck reference together as the commit object', () => {
    expect(commitObjectOf({ ...content, extra: 'ignored' } as typeof content, base.deck)).toEqual(base);
    expect(commitId(commitObjectOf(content, base.deck))).toBe(commitId(base));
  });

  it('accepts an id that is the hash of the content under any listed reference, and nothing else', () => {
    const commit = { ...content, id: commitId(base) };
    expect(isContentAddressed(commit, [base.deck])).toBe(true);
    expect(isContentAddressed(commit, ['moxfield:Other', base.deck])).toBe(true);
    expect(isContentAddressed(commit, ['moxfield:Other'])).toBe(false);
    expect(isContentAddressed(commit, [])).toBe(false);
    expect(isContentAddressed({ ...commit, message: 'edited' }, [base.deck])).toBe(false);
    expect(isContentAddressed({ ...commit, sourceVersion: null }, [base.deck])).toBe(false);
  });

  it('treats content that cannot be serialized as not content addressed', () => {
    const commit = { ...content, createdAt: '2026-10-09\n12:34', id: 'whatever' };
    expect(isContentAddressed(commit, [base.deck])).toBe(false);
  });
});

describe('shortId', () => {
  const id = 'a104438459a87e4e917780d3b1aae0be4280267e2a1bd555bad4ed342e552ddd';

  it('abbreviates to 7 characters by default', () => {
    expect(shortId(id)).toBe('a104438');
  });

  it('accepts a custom length and never pads', () => {
    expect(shortId(id, 12)).toBe('a104438459a8');
    expect(shortId('abc')).toBe('abc');
  });
});
