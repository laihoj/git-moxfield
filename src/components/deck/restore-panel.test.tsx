// @vitest-environment jsdom
import { buildSnapshot } from '@tests/support/builders';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { moxfieldRestoreExport } from '@/integrations/moxfield/restore-text';
import { renderWithProviders } from '@/components/test-utils';

import { RestorePanel } from './restore-panel';

function snapshot() {
  return buildSnapshot({ zones: { commanders: ['Tymna the Weaver'], mainboard: ['Sol Ring', '3 Island'] } });
}

function render() {
  return renderWithProviders(
    <RestorePanel
      restore={moxfieldRestoreExport(snapshot())}
      deckUrl="https://moxfield.com/decks/abc"
      downloadHref="/decks/d/versions/3/restore.txt"
    />,
  );
}

describe('RestorePanel', () => {
  it('numbers the steps from the restore instructions', () => {
    render();
    const steps = screen.getByRole('region', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem')[0]).toHaveTextContent(
      'Open the deck on Moxfield and reload the page',
    );
  });

  it('gives each board a block with its target, count, text and a copy button', () => {
    render();
    const mainboard = screen.getByRole('article', { name: 'Mainboard' });
    expect(mainboard).toHaveTextContent('Bulk Edit › Main Deck');
    expect(mainboard).toHaveTextContent('4 cards');
    const expected = moxfieldRestoreExport(snapshot()).sections.find(
      (section) => section.zone === 'mainboard',
    )?.text;
    expect(expected).toMatch(/^3 Island \(TST\) \d+\n1 Sol Ring \(TST\) \d+\n$/);
    expect(within(mainboard).getByRole('textbox', { name: 'Mainboard restore text' })).toHaveValue(expected);
    expect(within(mainboard).getByRole('textbox')).toHaveAttribute('readonly');
    expect(within(mainboard).getByRole('button', { name: 'Copy Mainboard' })).toBeInTheDocument();
    expect(mainboard).toHaveTextContent('2 lines');
  });

  it('marks the commanders as a manual step with a secondary copy button', () => {
    render();
    const commanders = screen.getByRole('article', { name: 'Commanders' });
    expect(commanders).toHaveTextContent('Manual step');
    expect(commanders).toHaveTextContent('Bulk Edit does not change this');
    expect(within(commanders).getByRole('button', { name: 'Copy Commanders' })).not.toHaveClass('bg-accent');
    const mainboard = screen.getByRole('article', { name: 'Mainboard' });
    expect(mainboard).not.toHaveTextContent('Manual step');
    expect(within(mainboard).getByRole('button', { name: 'Copy Mainboard' })).toHaveClass('bg-accent');
  });

  it('tells the user to clear tabs that this version leaves empty', () => {
    render();
    const considering = screen.getByRole('article', { name: 'Considering' });
    expect(considering).toHaveTextContent('Clear this tab in Moxfield');
    expect(within(considering).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(considering).queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers the combined list for a new deck in a collapsed disclosure, plus limitations and a download', () => {
    render();
    const combined = screen.getByText('Create a new deck instead').closest('details');
    expect(combined).not.toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: 'Limitations of restoring by text' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download .txt' })).toHaveAttribute(
      'href',
      '/decks/d/versions/3/restore.txt',
    );
    expect(screen.getByRole('link', { name: /Open deck in Moxfield/ })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
  });
});
