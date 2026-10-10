// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { PasteCapture } from './paste-capture';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * What select-all + copy yields in Firefox's default JSON viewer: the tree view's text
 * (toolbar labels, keys and truncated values in columns), not the JSON document.
 */
const FIREFOX_TREE_VIEW_COPY = [
  'JSON',
  'Raw Data',
  'Headers',
  'Save',
  'Copy',
  'Collapse All',
  'Expand All',
  'Filter JSON',
  'id\t"aBcDeFgH12"',
  'name\t"Atraxa Superfriends"',
  'boards',
  'mainboard',
  'count\t1',
].join('\n');

function renderPasteCapture(): void {
  render(<PasteCapture apiBaseUrl="https://api2.moxfield.com" siteOrigin="https://moxfield.com" />);
}

function step(name: RegExp): HTMLElement {
  const section = screen.getByRole('heading', { name }).closest('section');
  if (section === null) throw new Error(`No section for step ${String(name)}`);
  return section;
}

describe('PasteCapture', () => {
  it("tells Firefox users to use the JSON viewer's Copy button or save the file", () => {
    renderPasteCapture();

    const copyStep = step(/Open the deck data and copy all of it/);
    expect(copyStep).toHaveTextContent(/Select all \(Ctrl\/⌘ \+ A\) and copy/);
    expect(copyStep).toHaveTextContent(/In Firefox, use the page's Copy button instead/);
    expect(copyStep).toHaveTextContent(/Or click Save and use Choose file below/);
  });

  it('points to the Firefox Copy button when the pasted deck text is not JSON', async () => {
    const user = userEvent.setup();
    renderPasteCapture();

    await user.click(screen.getByLabelText('Deck JSON'));
    await user.paste(FIREFOX_TREE_VIEW_COPY);

    const pasteStep = step(/Paste it here/);
    expect(within(pasteStep).getByRole('alert')).toHaveTextContent(
      "This is not valid JSON. Copy the whole deck data page: select all, then copy. In Firefox, use the page's Copy button (or Save it and choose the file).",
    );
  });

  it('summarizes pasted JSON by name and kind without repeating the kind', async () => {
    const user = userEvent.setup();
    renderPasteCapture();

    await user.click(screen.getByLabelText('Deck JSON'));
    await user.paste(
      JSON.stringify({ id: 'aBcDe', publicId: 'Deck0001', name: 'Atraxa Superfriends', boards: {} }),
    );
    const deckSummary = within(step(/Paste it here/)).getByRole('list');
    expect(deckSummary.parentElement).toHaveTextContent(/^Atraxa Superfriends·Deck JSON·\d+ B$/);

    // A primer has no name: its kind is the title and is not repeated below it.
    await user.click(screen.getByLabelText('Primer JSON (optional)'));
    await user.paste(JSON.stringify({ content: '# Primer' }));
    const primerSummary = within(step(/Optional: the primer/)).getByRole('list');
    expect(primerSummary.parentElement).toHaveTextContent(/^Primer JSON·\d+ B$/);
  });

  it('points to the Firefox Copy button when the pasted primer text is not JSON', async () => {
    const user = userEvent.setup();
    renderPasteCapture();

    await user.click(screen.getByLabelText('Primer JSON (optional)'));
    await user.paste(FIREFOX_TREE_VIEW_COPY);

    const primerStep = step(/Optional: the primer/);
    expect(within(primerStep).getByRole('alert')).toHaveTextContent(
      "This is not valid JSON. Copy the whole primer data page: select all, then copy. In Firefox, use the page's Copy button (or Save it and choose the file).",
    );
  });
});
