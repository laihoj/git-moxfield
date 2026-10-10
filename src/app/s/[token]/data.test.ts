/**
 * Metadata of the pages below a share link: a link that grants nothing must not give its
 * "This link doesn't work" page the title of the page it names (`History`, `Version not
 * found`), so every dead link looks the same, whichever page it names.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SharedDeckAccess } from '@/server/services';

const state = vi.hoisted(() => ({ access: null as SharedDeckAccess | null, tokens: [] as unknown[] }));

vi.mock('@/server/access', () => ({
  sharedDeckServices: (token: unknown) => {
    state.tokens.push(token);
    return Promise.resolve(state.access);
  },
}));

import { sharedPageMetadata } from './data';

const ACCESS = {
  services: {},
  share: { label: 'For Mikko', includeNotes: false, ownerDisplayName: 'Aino', deckId: 'deck-1' },
} as unknown as SharedDeckAccess;

const TOKEN = `gmv_${'A'.repeat(43)}`;

describe('sharedPageMetadata', () => {
  beforeEach(() => {
    state.access = null;
    state.tokens = [];
  });

  it('gives a link that grants nothing no metadata of its own, so the layout’s title stays', async () => {
    const metadata = vi.fn(() => ({ title: 'History' }));

    await expect(sharedPageMetadata(TOKEN, metadata)).resolves.toEqual({});
    expect(metadata).not.toHaveBeenCalled();
    expect(state.tokens).toEqual([TOKEN]);
  });

  it('gives a working link the page’s metadata, built from the link’s access', async () => {
    state.access = ACCESS;
    const metadata = vi.fn((access: SharedDeckAccess) =>
      Promise.resolve({ title: `History · ${access.share.ownerDisplayName}` }),
    );

    await expect(sharedPageMetadata(TOKEN, metadata)).resolves.toEqual({ title: 'History · Aino' });
    expect(metadata).toHaveBeenCalledWith(ACCESS);
  });
});
