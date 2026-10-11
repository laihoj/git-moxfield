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

  it('says once that an empty tab must be cleared, and names the tab only as the target', () => {
    render();
    const considering = screen.getByRole('article', { name: 'Considering' });
    expect(considering).toHaveTextContent('Bulk Edit › Considering');
    expect(considering.textContent).not.toMatch(/clear the tab/i);
    expect(considering.textContent.match(/clear this tab/gi)).toHaveLength(1);
  });

  it('takes how a section is restored from its kind, whatever its zone', () => {
    const restore = moxfieldRestoreExport(snapshot());
    renderWithProviders(
      <RestorePanel
        restore={{
          ...restore,
          sections: restore.sections.map((section) =>
            section.zone === 'mainboard' ? { ...section, kind: 'reference' } : section,
          ),
        }}
        downloadHref="/decks/d/versions/3/restore.txt"
      />,
    );
    const mainboard = screen.getByRole('article', { name: 'Mainboard' });
    expect(mainboard).toHaveTextContent('Reference only');
    expect(mainboard).toHaveTextContent('Moxfield cannot restore this by pasting');
    expect(screen.getByRole('article', { name: 'Sideboard' })).not.toHaveTextContent('Reference only');
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

describe('RestorePanel without a deck to open', () => {
  it('links to no Moxfield deck (a share link viewer restores into a deck of their own)', () => {
    renderWithProviders(
      <RestorePanel
        restore={moxfieldRestoreExport(snapshot(), 'own-deck')}
        downloadHref="/s/gmv_x/versions/3/restore.txt"
      />,
    );
    const steps = screen.getByRole('region', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem')[0]).toHaveTextContent(
      'Open a deck of your own on Moxfield (or create one)',
    );
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/s/gmv_x/versions/3/restore.txt',
    ]);
  });
});

describe('RestorePanel primer', () => {
  function renderPrimer(primer: string | null) {
    return renderWithProviders(
      <RestorePanel
        restore={moxfieldRestoreExport(buildSnapshot({ zones: { mainboard: ['Sol Ring'] }, primer }))}
        deckUrl="https://moxfield.com/decks/abc"
        downloadHref="/decks/d/versions/3/restore.txt"
      />,
    );
  }

  it('offers the primer source verbatim, with its Moxfield target and a copy button', () => {
    const primer = "===panel: Win lines\n1. [[Thassa's Oracle]] + [[Demonic Consultation]]\n===endpanel\n";
    renderPrimer(primer);
    const block = screen.getByRole('article', { name: 'Primer' });
    expect(block).toHaveAttribute('id', 'restore-primer');
    expect(block).toHaveTextContent('Deck page › Primer › Edit');
    expect(block).toHaveTextContent('3 lines');
    expect(within(block).getByRole('textbox', { name: 'Primer source' })).toHaveValue(primer);
    expect(within(block).getByRole('button', { name: 'Copy primer' })).toHaveClass('bg-accent');
  });

  it('asks to clear the primer when the version had none', () => {
    renderPrimer('');
    const block = screen.getByRole('article', { name: 'Primer' });
    expect(block).toHaveTextContent('this version has no primer');
    expect(within(block).queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no primer block when the primer was not captured', () => {
    renderPrimer(null);
    expect(screen.queryByRole('article', { name: 'Primer' })).not.toBeInTheDocument();
    expect(screen.getByText(/The primer was not captured for this version/)).toBeInTheDocument();
  });
});
