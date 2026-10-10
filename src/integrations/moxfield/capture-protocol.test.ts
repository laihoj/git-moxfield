import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  BOOKMARKLET_KEY_PATTERN,
  CAPTURE_API_PATH,
  CAPTURE_ENVELOPE_KIND,
  CAPTURE_FORM_TOKEN_FIELD,
  CAPTURE_MESSAGE_TYPES,
  CAPTURE_PROTOCOL_VERSION,
  DONE,
  ERROR,
  isCaptureEnvelope,
  isCaptureMessage,
  NONCE_PATTERN,
  PAYLOAD,
  READY,
  readCaptureNonce,
} from './capture-protocol';

const NONCE = '0123456789abcdef0123456789abcdef';
const KEY = 'gmk_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

describe('capture protocol', () => {
  it('has stable wire constants', () => {
    expect(CAPTURE_MESSAGE_TYPES).toEqual({
      READY: 'git-moxfield:ready',
      PAYLOAD: 'git-moxfield:payload',
      ERROR: 'git-moxfield:error',
      DONE: 'git-moxfield:done',
    });
    expect(CAPTURE_ENVELOPE_KIND).toBe('git-moxfield/capture');
    expect(CAPTURE_PROTOCOL_VERSION).toBe(2);
    expect(CAPTURE_API_PATH).toBe('/api/capture');
    expect(CAPTURE_FORM_TOKEN_FIELD).toBe('token');
    expect(NONCE_PATTERN.test(NONCE)).toBe(true);
    expect(NONCE_PATTERN.test(NONCE.toUpperCase())).toBe(false);
    expect(NONCE_PATTERN.test(`${NONCE}0`)).toBe(false);
  });

  it('stays dependency-free so client components can import it', () => {
    const source = readFileSync(new URL('./capture-protocol.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it.each([
    [{ t: READY, n: NONCE }, true],
    [{ t: DONE, n: NONCE }, true],
    [{ t: PAYLOAD, n: NONCE, json: '{}' }, true],
    [{ t: PAYLOAD, n: NONCE, json: '{}', key: KEY }, true],
    [{ t: PAYLOAD, n: NONCE, json: '{}', key: 42 }, false],
    [{ t: ERROR, n: NONCE, message: 'boom' }, true],
    [{ t: PAYLOAD, n: NONCE }, false],
    [{ t: ERROR, n: NONCE, message: 5 }, false],
    [{ t: READY, n: 'short' }, false],
    [{ t: 'git-moxfield:other', n: NONCE }, false],
    [{ t: READY }, false],
    ['git-moxfield:ready', false],
    [null, false],
    [[READY, NONCE], false],
  ])('isCaptureMessage(%j) → %s', (value, expected) => {
    expect(isCaptureMessage(value)).toBe(expected);
  });

  it('recognizes envelopes of this protocol version', () => {
    const envelope = {
      kind: CAPTURE_ENVELOPE_KIND,
      version: CAPTURE_PROTOCOL_VERSION,
      source: 'moxfield',
      pageUrl: 'https://moxfield.com/decks/x',
      capturedAt: '2026-10-09T00:00:00.000Z',
      deck: {},
      primer: null,
      primerError: null,
    };
    expect(isCaptureEnvelope(envelope)).toBe(true);
    expect(isCaptureEnvelope({ ...envelope, version: 1 })).toBe(false);
    expect(isCaptureEnvelope({ ...envelope, deck: 'x' })).toBe(false);
    expect(isCaptureEnvelope({ ...envelope, source: 'other' })).toBe(false);
  });

  it.each([
    [KEY, true],
    [`gmk_${'A'.repeat(43)}`, true],
    [`gmk_${'A'.repeat(42)}`, false],
    [`gmk_${'A'.repeat(44)}`, false],
    [`gms_${'A'.repeat(43)}`, false],
    [`gmk_${'A'.repeat(42)}=`, false],
    [`gmk_${'A'.repeat(42)}"`, false],
    ['c0ffee'.repeat(10) + 'beef', false],
  ])('BOOKMARKLET_KEY_PATTERN.test(%j) → %s', (value, expected) => {
    expect(BOOKMARKLET_KEY_PATTERN.test(value)).toBe(expected);
  });

  it('reads the nonce from the capture page hash', () => {
    expect(readCaptureNonce(`#n=${NONCE}`)).toBe(NONCE);
    expect(readCaptureNonce(`n=${NONCE}`)).toBe(NONCE);
    expect(readCaptureNonce(`#x=1&n=${NONCE}`)).toBe(NONCE);
    expect(readCaptureNonce('#n=xyz')).toBeNull();
    expect(readCaptureNonce('')).toBeNull();
  });
});
