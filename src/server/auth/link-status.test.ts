import { describe, expect, it } from 'vitest';

import { oneTimeLinkState } from './link-status';

const NOW = '2026-01-02T00:00:00.000Z';
const LIVE = { usedAt: null, revokedAt: null, expiresAt: '2026-01-03T00:00:00.000Z' };

describe('oneTimeLinkState', () => {
  it('is pending while nothing has happened to the link', () => {
    expect(oneTimeLinkState(LIVE, true, NOW)).toBe('pending');
  });

  it('is expired from the moment of its expiry on', () => {
    expect(oneTimeLinkState({ ...LIVE, expiresAt: NOW }, true, NOW)).toBe('expired');
    expect(oneTimeLinkState({ ...LIVE, expiresAt: '2026-01-01T00:00:00.000Z' }, true, NOW)).toBe('expired');
  });

  it('is revoked when withdrawn or when its creator is no longer an active admin', () => {
    expect(oneTimeLinkState({ ...LIVE, revokedAt: NOW }, true, NOW)).toBe('revoked');
    expect(oneTimeLinkState(LIVE, false, NOW)).toBe('revoked');
  });

  it('is used before anything else', () => {
    const everything = { usedAt: NOW, revokedAt: NOW, expiresAt: '2026-01-01T00:00:00.000Z' };
    expect(oneTimeLinkState(everything, false, NOW)).toBe('used');
  });

  it('is revoked before it is expired, when it was revoked before it expired', () => {
    const expired = '2026-01-01T12:00:00.000Z';
    expect(
      oneTimeLinkState({ ...LIVE, revokedAt: '2026-01-01T00:00:00.000Z', expiresAt: expired }, true, NOW),
    ).toBe('revoked');
    // Withdrawn after it had expired (older invites could be): it expired.
    expect(oneTimeLinkState({ ...LIVE, revokedAt: NOW, expiresAt: expired }, true, NOW)).toBe('expired');
    expect(oneTimeLinkState({ ...LIVE, revokedAt: expired, expiresAt: expired }, true, NOW)).toBe('expired');
  });
});
