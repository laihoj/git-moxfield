// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { deriveCardHistory } from '@/core/history/card-history';
import type { CardHistoryEntry, CardVersionPoint, ZoneQuantity } from '@/core/history/types';
import { facts, metaItemTexts, renderWithProviders } from '@/components/test-utils';

import { CardHistoryView, historySummary, transitionLabel } from './card-history-view';

function point(
  sequence: number | null,
  zones: ZoneQuantity[],
  message = `Version ${sequence ?? 'now'}`,
): CardVersionPoint {
  return {
    commitId: sequence === null ? null : `commit-${sequence}`,
    sequence,
    at: '2026-10-01T12:00:00.000Z',
    message,
    zones,
  };
}

const MAIN = (quantity = 1): ZoneQuantity => ({ zone: 'mainboard', quantity });
const CONSIDERING: ZoneQuantity = { zone: 'considering', quantity: 1 };
const SIDEBOARD: ZoneQuantity = { zone: 'sideboard', quantity: 1 };

/** Mainboard → considering → mainboard (restored) → gone → sideboard (returned to the deck). */
function dressDownHistory() {
  return deriveCardHistory({
    key: 'dress down',
    name: 'Dress Down',
    points: [
      point(1, [MAIN()]),
      point(2, [MAIN()]),
      point(3, [CONSIDERING], 'Testing Broodlord package'),
      point(4, [MAIN()], 'Back to Dress Down'),
      point(5, []),
      point(6, [SIDEBOARD], 'Sideboard plan'),
      point(null, [SIDEBOARD]),
    ],
  });
}

describe('transitionLabel', () => {
  const entry = (overrides: Partial<CardHistoryEntry>): CardHistoryEntry => ({
    ...point(2, [MAIN()]),
    transition: 'unchanged',
    previousZones: [],
    ...overrides,
  });

  it.each<[Partial<CardHistoryEntry>, string]>([
    [{ transition: 'first-seen', sequence: 1 }, 'In the first version'],
    [{ transition: 'added' }, 'Added'],
    [{ transition: 'removed', zones: [], previousZones: [MAIN()] }, 'Removed from Mainboard'],
    [{ transition: 'moved', zones: [CONSIDERING], previousZones: [MAIN()] }, 'Moved from Mainboard'],
    [
      { transition: 'restored', restoredFrom: [{ zone: 'mainboard', lastSequence: 2 }] },
      'Restored to Mainboard (last there in v2)',
    ],
    [{ transition: 'restored', restoredFrom: [] }, 'Returned to the deck'],
    [{ transition: 'quantity', zones: [MAIN(3)], previousZones: [MAIN(2)] }, '2 → 3 copies'],
    [{ transition: 'unchanged' }, 'No change'],
    [
      { transition: 'unchanged', renamedFrom: { key: 'æther vial', name: 'Æther Vial' } },
      'Renamed from Æther Vial',
    ],
    [
      {
        transition: 'moved',
        zones: [CONSIDERING],
        previousZones: [MAIN()],
        renamedFrom: { key: 'æther vial', name: 'Æther Vial' },
      },
      'Moved from Mainboard, renamed from Æther Vial',
    ],
  ])('labels %o as "%s"', (overrides, label) => {
    expect(transitionLabel(entry(overrides))).toBe(label);
  });
});

describe('CardHistoryView', () => {
  it('summarizes the history: versions on any board, versions played, cuts and restores', () => {
    expect(historySummary(dressDownHistory())).toEqual([
      'In 5 of 6 versions',
      'played in 3',
      'cut twice',
      'restored twice',
    ]);
  });

  it('says "all" when the card is in every version, and leaves out an equal played count', () => {
    const history = deriveCardHistory({
      key: 'sol ring',
      name: 'Sol Ring',
      points: [point(1, [MAIN()]), point(2, [MAIN()]), point(3, [MAIN()])],
    });
    expect(historySummary(history)).toEqual(['In all 3 versions']);
  });

  it('says when a card on other boards was never played', () => {
    const history = deriveCardHistory({
      key: 'grief',
      name: 'Grief',
      points: [point(1, []), point(2, [CONSIDERING]), point(3, [CONSIDERING])],
    });
    expect(historySummary(history)).toEqual(['In 2 of 3 versions', 'never played']);
  });

  it('shows compressed runs, newest first, with transition labels and version links', () => {
    const history = dressDownHistory();
    renderWithProviders(
      <CardHistoryView
        deckId="deck-1"
        history={history}
        facts={facts('dress down', 'Dress Down', '{1}{U}', 'Enchantment')}
        showAll={false}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Dress Down', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Now on Moxfield:').parentElement).toHaveTextContent('Sideboard');
    expect(metaItemTexts(screen.getByRole('list', { name: 'Summary' }))).toEqual([
      'In 5 of 6 versions',
      'played in 3',
      'cut twice',
      'restored twice',
    ]);

    const items = [...screen.getByRole('list', { name: 'Card timeline' }).querySelectorAll(':scope > li')];
    const texts = items.map((item) => item.textContent);
    expect(texts[0]).toContain('v6–now');
    expect(texts[0]).toContain('Returned to the deck');
    expect(texts[1]).toContain('v5');
    expect(texts[1]).toContain('Removed from Mainboard');
    expect(texts[2]).toContain('Restored to Mainboard (last there in v2)');
    expect(texts[3]).toContain('Moved from Mainboard');
    expect(texts[4]).toContain('v1–v2');
    expect(texts[4]).toContain('In the first version');

    expect(screen.getByRole('link', { name: 'v3' })).toHaveAttribute('href', '/decks/deck-1/versions/3');
  });

  it('counts only versions in a run that reaches the current Moxfield deck', () => {
    const history = deriveCardHistory({
      key: 'sol ring',
      name: 'Sol Ring',
      points: [point(1, [MAIN()]), point(2, [MAIN()]), point(3, [MAIN()]), point(null, [MAIN()])],
    });
    renderWithProviders(<CardHistoryView deckId="deck-1" history={history} facts={null} showAll={false} />);
    const timeline = screen.getByRole('list', { name: 'Card timeline' });
    expect(timeline).toHaveTextContent('v1–now');
    expect(timeline).toHaveTextContent('3 versions');
  });

  it('shows a rename as its own run in the compressed timeline', () => {
    const history = deriveCardHistory({
      key: 'aether vial',
      name: 'Aether Vial',
      points: [
        point(1, [MAIN()]),
        point(2, [MAIN()]),
        { ...point(3, [MAIN()], 'Oracle update'), renamedFrom: { key: 'æther vial', name: 'Æther Vial' } },
        point(null, [MAIN()]),
      ],
    });
    renderWithProviders(<CardHistoryView deckId="deck-1" history={history} facts={null} showAll={false} />);

    const items = [...screen.getByRole('list', { name: 'Card timeline' }).querySelectorAll(':scope > li')];
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('v3–now') as unknown,
      expect.stringContaining('v1–v2') as unknown,
    ]);
    expect(items[0]).toHaveTextContent('Renamed from Æther Vial');
    expect(metaItemTexts(screen.getByRole('list', { name: 'Summary' }))).toEqual(['In all 3 versions']);
  });

  it('lists every version when asked to', () => {
    renderWithProviders(
      <CardHistoryView deckId="deck-1" history={dressDownHistory()} facts={null} showAll />,
    );
    expect(screen.getByRole('link', { name: 'Current' })).toHaveAttribute('href', '/decks/deck-1');
    expect(screen.getByRole('link', { name: 'v2' })).toBeInTheDocument();
    expect(screen.getAllByText('No change')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Every version' })).toHaveAttribute('aria-current', 'page');
  });
});
