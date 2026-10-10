// @vitest-environment jsdom
import { buildSnapshot, baseDeckSpec } from '@tests/support/builders';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { emptySnapshot } from '@/core/canonical';
import { diffSnapshots } from '@/core/diff';
import { renderWithProviders, facts } from '@/components/test-utils';
import type { DeckScope } from '@/lib/routes';

import { DiffView } from './diff-view';
import { SummaryChips } from './summary-chips';

const OWNER: DeckScope = { kind: 'owner', deckId: 'deck-1' };
const SHARED = { kind: 'shared', token: `gmv_${'A'.repeat(43)}` } as const;

const CATALOG = {
  'dress down': facts('dress down', 'Dress Down', '{1}{U}', 'Enchantment'),
  'mnemonic betrayal': facts('mnemonic betrayal', 'Mnemonic Betrayal', '{1}{U}{B}', 'Sorcery'),
  'beseech the mirror': facts('beseech the mirror', 'Beseech the Mirror', '{1}{B}{B}{B}', 'Sorcery'),
};

function changedDeck() {
  const before = buildSnapshot(baseDeckSpec());
  const after = buildSnapshot({
    ...baseDeckSpec(),
    zones: {
      commanders: ['Tymna the Weaver', "Kraum, Ludevic's Opus"],
      mainboard: [
        'Underworld Breach',
        "Thassa's Oracle",
        'Demonic Tutor',
        'Rhystic Study',
        '4 Island',
        { name: 'Sol Ring', printings: [{ set: 'cmm', collectorNumber: '703' }] },
        'Mnemonic Betrayal',
        'Beseech the Mirror',
      ],
      considering: ['Dress Down', 'Peer into the Abyss'],
      sideboard: ['Orcish Bowmasters'],
    },
  });
  return { before, after, diff: diffSnapshots(before, after) };
}

describe('DiffView', () => {
  it('reports a primer captured after a version without one as a change', () => {
    const before = buildSnapshot({ ...baseDeckSpec(), primer: null });
    const after = buildSnapshot({ ...baseDeckSpec(), primer: '# Blue Farm\n' });
    renderWithProviders(<DiffView diff={diffSnapshots(before, after)} catalog={CATALOG} scope={OWNER} />);

    expect(screen.getByRole('region', { name: 'Primer' })).toHaveTextContent(
      'Captured (the previous version has none)',
    );
  });

  it('renders moves as one row with "from → to" zones, never as a removal plus an addition', () => {
    const { diff } = changedDeck();
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={OWNER} />);

    const moved = screen.getByRole('region', { name: /Moved/ });
    const dressDown = within(moved).getByText('Dress Down').closest('li');
    expect(dressDown).not.toBeNull();
    expect(dressDown).toHaveTextContent('Mainboard → Considering');
    expect(dressDown).toHaveTextContent('Moved from Mainboard to Considering');
    expect(within(moved).getByText('Mnemonic Betrayal').closest('li')).toHaveTextContent(
      'Considering → Mainboard',
    );

    // Dress Down appears only in the Moved section.
    expect(screen.getAllByText('Dress Down')).toHaveLength(1);
  });

  it('shows glyphs and spoken meaning for additions and quantity changes', () => {
    const { diff } = changedDeck();
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={OWNER} />);

    const mainboard = screen.getByRole('region', { name: /Mainboard/ });
    const beseech = within(mainboard).getByText('Beseech the Mirror').closest('li');
    expect(beseech).toHaveTextContent('Added:');
    expect(within(mainboard).getByText('Island').closest('li')).toHaveTextContent('3 → 4');
    expect(
      within(beseech as HTMLElement).getByRole('img', { name: 'Mana cost: 1 generic, 3 black' }),
    ).toBeVisible();
  });

  it('links card names to their card history', () => {
    const { diff } = changedDeck();
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={OWNER} />);
    expect(screen.getByRole('link', { name: 'Dress Down' })).toHaveAttribute(
      'href',
      '/decks/deck-1/cards/dress%20down',
    );
  });

  it('links card names within a share link’s pages for its viewers', () => {
    const { diff } = changedDeck();
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={SHARED} />);
    expect(screen.getByRole('link', { name: 'Dress Down' })).toHaveAttribute(
      'href',
      `/s/${SHARED.token}/cards/dress%20down`,
    );
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).toMatch(new RegExp(`^/s/${SHARED.token}/`));
    }
  });

  it('links the cards of a first version within the scope too', () => {
    const snapshot = buildSnapshot(baseDeckSpec());
    const diff = diffSnapshots(emptySnapshot(snapshot.deck), snapshot);
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={SHARED} initial />);
    const links = screen.getAllByRole('link', { hidden: true });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(new RegExp(`^/s/${SHARED.token}/cards/`));
    }
  });

  it('collapses cosmetic sections (printings) behind a closed disclosure', () => {
    const { diff } = changedDeck();
    const { container } = renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={OWNER} />);

    const printings = screen.getByText('Printings').closest('details');
    expect(printings).not.toBeNull();
    expect(printings).not.toHaveAttribute('open');
    expect(within(printings as HTMLElement).getByText('Sol Ring')).toBeInTheDocument();
    // Strategic sections are not inside any disclosure.
    expect(container.querySelectorAll('details')).toHaveLength(1);
  });

  it('renders a first version as per-zone counts with the full list collapsed', () => {
    const snapshot = buildSnapshot(baseDeckSpec());
    const diff = diffSnapshots(emptySnapshot(snapshot.deck), snapshot);
    renderWithProviders(<DiffView diff={diff} catalog={CATALOG} scope={OWNER} initial />);

    const tiles = within(screen.getByRole('list', { name: 'Cards per zone' }))
      .getAllByRole('listitem')
      .map((tile) => tile.textContent);
    expect(tiles).toEqual(['Commanders2', 'Mainboard9', 'Sideboard1', 'Considering2']);
    const all = screen.getByText('Show all 14 cards').closest('details');
    expect(all).not.toHaveAttribute('open');
    // No "+" rows: the glyph list is not used for an initial version.
    expect(screen.queryByText('Added:', { exact: false })).not.toBeInTheDocument();
  });

  it('says so when nothing differs', () => {
    const snapshot = buildSnapshot(baseDeckSpec());
    renderWithProviders(
      <DiffView
        diff={diffSnapshots(snapshot, snapshot)}
        catalog={{}}
        scope={OWNER}
        emptyMessage="Identical."
      />,
    );
    expect(screen.getByText('Identical.')).toBeInTheDocument();
  });
});

describe('SummaryChips', () => {
  it('lists additions, removals, moves and primer changes in order', () => {
    const before = buildSnapshot(baseDeckSpec());
    const after = buildSnapshot({
      ...baseDeckSpec(),
      zones: {
        ...baseDeckSpec().zones,
        mainboard: [
          'Underworld Breach',
          "Thassa's Oracle",
          'Demonic Tutor',
          '3 Island',
          'Sol Ring',
          'Final Fortune',
          'Beseech the Mirror',
        ],
        considering: ['Mnemonic Betrayal', 'Peer into the Abyss', 'Dress Down'],
      },
      primer: '# Blue Farm\n\nWin with a new line.\nAnother line.\n',
    });
    renderWithProviders(<SummaryChips diff={diffSnapshots(before, after)} />);

    const chips = within(screen.getByRole('list', { name: 'Summary of changes' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(chips).toEqual(['+2 Mainboard', '−1 Mainboard', '1 moved to Considering', 'Primer +2 / −1 lines']);
  });

  it('renders nothing for an empty diff', () => {
    const snapshot = buildSnapshot(baseDeckSpec());
    const { container } = renderWithProviders(<SummaryChips diff={diffSnapshots(snapshot, snapshot)} />);
    expect(container.querySelector('ul')).toBeNull();
  });
});
