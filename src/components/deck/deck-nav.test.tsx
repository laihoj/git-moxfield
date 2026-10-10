// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { DeckNav } from './deck-nav';

const segments = vi.hoisted(() => ({ current: [] as string[] }));
vi.mock('next/navigation', () => ({ useSelectedLayoutSegments: () => segments.current }));

const TOKEN = `gmv_${'A'.repeat(43)}`;

/** The tabs of one of the two navigations (top tabs, bottom bar), as [label, href]. */
function tabs(index: 0 | 1): [string, string | null][] {
  const nav = screen.getAllByRole('navigation', { name: 'Deck' })[index];
  if (nav === undefined) throw new Error('No deck navigation');
  return within(nav)
    .getAllByRole('link')
    .map((link) => [link.textContent, link.getAttribute('href')]);
}

describe('DeckNav', () => {
  beforeEach(() => {
    segments.current = [];
  });

  it('links the owner’s Status · History · Compare · Cards, exactly as before share links', () => {
    render(<DeckNav scope={{ kind: 'owner', deckId: 'd1' }} />);
    const expected = [
      ['Status', '/decks/d1'],
      ['History', '/decks/d1/history'],
      ['Compare', '/decks/d1/compare'],
      ['Cards', '/decks/d1/cards'],
    ];
    expect(tabs(0)).toEqual(expected);
    expect(tabs(1)).toEqual(expected);
  });

  it('keeps a share link’s viewers within its pages, with Overview in place of Status', () => {
    render(<DeckNav scope={{ kind: 'shared', token: TOKEN }} />);
    const expected = [
      ['Overview', `/s/${TOKEN}`],
      ['History', `/s/${TOKEN}/history`],
      ['Compare', `/s/${TOKEN}/compare`],
      ['Cards', `/s/${TOKEN}/cards`],
    ];
    expect(tabs(0)).toEqual(expected);
    expect(tabs(1)).toEqual(expected);
  });

  it.each([
    [[], 'Overview'],
    [['history'], 'History'],
    [['versions', '3'], 'History'],
    [['compare'], 'Compare'],
    [['cards', 'dress down'], 'Cards'],
  ])('marks the section of %j as current', (current, active) => {
    segments.current = current;
    render(<DeckNav scope={{ kind: 'shared', token: TOKEN }} />);
    for (const nav of screen.getAllByRole('navigation', { name: 'Deck' })) {
      expect(within(nav).getByRole('link', { name: active })).toHaveAttribute('aria-current', 'page');
      expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    }
  });

  it('marks no section on pages outside them (the owner’s Share page)', () => {
    segments.current = ['share'];
    render(<DeckNav scope={{ kind: 'owner', deckId: 'd1' }} />);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(0);
  });
});
