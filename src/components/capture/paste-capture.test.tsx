// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { envelopeJson, gzipPayload } from '@tests/support/capture-codec';
import { sentJsonBody, stubJsonFetch } from '@tests/support/fetch-stub';

import '@/components/test-utils';
import { decodeCapturePayload } from '@/integrations/moxfield/capture-codec';
import { CAPTURE_GZIP_TAG } from '@/integrations/moxfield/capture-codec-protocol';
import { MAX_CAPTURE_BYTES } from '@/integrations/moxfield/capture-protocol';
import { v1Primer, v3Deck } from '@/integrations/moxfield/test-fixtures';

import { PasteCapture } from './paste-capture';

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: navigation.replace }),
}));

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigation.replace.mockClear();
  fetchMock = stubJsonFetch(200, { status: 'untracked', name: 'Fixture Blue Farm', externalId: 'abc' });
  // jsdom's Blob has no stream(), which compressing needs; browsers' (and Node's) has.
  vi.stubGlobal('Blob', NodeBlob);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface PostedBody {
  payload: unknown;
  method: string;
  track: boolean;
}

/** The one capture request sent, with its payload decoded as the server decodes it. */
async function postedCapture(): Promise<{ method: string; text: string; compressed: boolean }> {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const body = sentJsonBody(fetchMock) as PostedBody;
  if (typeof body.payload !== 'string') throw new Error('No payload string was sent');
  return {
    method: body.method,
    text: await decodeCapturePayload(body.payload),
    compressed: body.payload.startsWith(CAPTURE_GZIP_TAG),
  };
}

const DECK_JSON = JSON.stringify(v3Deck());
const PRIMER_JSON = JSON.stringify(v1Primer());

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

describe('PasteCapture deck data link', () => {
  async function typeDeck(text: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderPasteCapture();
    await user.type(screen.getByLabelText('Moxfield deck URL'), text);
    return step(/Open the deck data and copy all of it/);
  }

  it.each([
    ['https://moxfield.com/decks/AbCdEf123456', 'AbCdEf123456'],
    ['moxfield.com/decks/AbCdEf123456/primer?x=1', 'AbCdEf123456'],
    ['AbCdEf123456', 'AbCdEf123456'],
  ])('links the data page of the deck in %s', async (typed, id) => {
    const copyStep = await typeDeck(typed);
    expect(within(copyStep).getByRole('link')).toHaveAttribute(
      'href',
      `https://api2.moxfield.com/v3/decks/all/${id}`,
    );
  });

  it.each([
    'https://moxfield.com/decks/personal',
    'https://moxfield.com/decks/new',
    'https://user:secret@moxfield.com/decks/AbCdEf123456',
    'https://example.com/decks/AbCdEf123456',
    'javascript:alert(1)',
  ])('does not recognize %s as a deck, as the server parser does not', async (typed) => {
    const copyStep = await typeDeck(typed);
    expect(within(copyStep).queryByRole('link')).not.toBeInTheDocument();
    // Described, not announced: the message comes and goes while typing.
    expect(screen.getByLabelText('Moxfield deck URL')).toHaveAccessibleDescription(
      'That does not look like a Moxfield deck URL.',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('PasteCapture pasted JSON kinds', () => {
  async function pasteDeckField(json: string): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderPasteCapture();
    await user.click(screen.getByLabelText('Deck JSON'));
    await user.paste(json);
    return step(/Paste it here/);
  }

  it('takes a { deck, primer } pair as a complete capture, as the server does: no primer step', async () => {
    const pasteStep = await pasteDeckField(JSON.stringify({ deck: DECK_JSON, primer: PRIMER_JSON }));
    expect(within(pasteStep).queryByRole('alert')).not.toBeInTheDocument();
    expect(pasteStep).toHaveTextContent('Fixture Blue Farm');
    expect(pasteStep).toHaveTextContent('Deck and primer');
    expect(screen.queryByRole('heading', { name: /Optional: the primer/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /import/i })).toBeEnabled();
  });

  it('calls primer JSON the primer, also when it carries a board key, as the server does', async () => {
    const pasteStep = await pasteDeckField(JSON.stringify({ content: '# Primer', mainboard: {} }));
    expect(within(pasteStep).getByRole('alert')).toHaveTextContent('This is the primer JSON.');
  });
});

describe('PasteCapture sending', () => {
  async function pasteInto(label: string, text: string): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByLabelText(label));
    await user.paste(text);
  }

  it('sends the pasted deck compressed', async () => {
    renderPasteCapture();
    await pasteInto('Deck JSON', DECK_JSON);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import deck' }));

    expect(await screen.findByRole('heading', { name: 'Track “Fixture Blue Farm”?' })).toBeInTheDocument();
    expect(await postedCapture()).toEqual({ method: 'manual-paste', text: DECK_JSON, compressed: true });
  });

  it('sends deck and primer as one compressed { deck, primer } JSON text', async () => {
    renderPasteCapture();
    await pasteInto('Deck JSON', DECK_JSON);
    await pasteInto('Primer JSON (optional)', PRIMER_JSON);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import deck' }));

    await screen.findByRole('heading', { name: 'Track “Fixture Blue Farm”?' });
    expect(await postedCapture()).toEqual({
      method: 'manual-paste',
      text: JSON.stringify({ deck: DECK_JSON, primer: PRIMER_JSON }),
      compressed: true,
    });
  });

  it('reads a compressed capture copied by the bookmarklet, and sends it as a capture', async () => {
    renderPasteCapture();
    await pasteInto('Deck JSON', `${gzipPayload(envelopeJson())}\n`);

    const summary = await within(step(/Paste it here/)).findByRole('list');
    expect(summary.parentElement).toHaveTextContent(/^Fixture Blue Farm·Bookmarklet capture·[\d.]+ KB$/);
    // A capture carries its primer: no primer step.
    expect(screen.queryByLabelText('Primer JSON (optional)')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Import deck' }));
    await screen.findByRole('heading', { name: 'Track “Fixture Blue Farm”?' });
    expect(await postedCapture()).toEqual({
      method: 'browser-capture',
      text: envelopeJson(),
      compressed: true,
    });
  });

  it('explains compressed data that was damaged on the way', async () => {
    renderPasteCapture();
    await pasteInto('Deck JSON', gzipPayload(envelopeJson()).slice(0, -100));

    expect(await within(step(/Paste it here/)).findByRole('alert')).toHaveTextContent(
      'The pasted deck data is damaged or incomplete. Run the bookmarklet on the Moxfield deck page again, then paste again.',
    );
    expect(screen.getByRole('button', { name: 'Import deck' })).toBeDisabled();
  });

  it('refuses pasted data over the size limit', () => {
    renderPasteCapture();
    // A paste event with a huge text (typing it would take forever).
    fireEvent.paste(screen.getByLabelText('Deck JSON'), {
      clipboardData: { getData: () => ' '.repeat(MAX_CAPTURE_BYTES) + '{}' },
    });
    expect(within(step(/Paste it here/)).getByRole('alert')).toHaveTextContent(
      'The pasted data is too large to import (limit 8.0 MB).',
    );
  });

  it('reports a deck that is too large to send, without sending it', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    renderPasteCapture();
    const padded = JSON.stringify({ ...v3Deck(), padding: ' '.repeat(1_500_000) });
    fireEvent.paste(screen.getByLabelText('Deck JSON'), { clipboardData: { getData: () => padded } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Import deck' }));

    const alert = await screen.findByText('The deck could not be imported');
    expect(alert.closest('[role="alert"]')).toHaveTextContent('this browser cannot compress it');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PasteCapture continuing an existing deck’s history', () => {
  const candidate = (id: string, name: string, versionCount: number) => ({
    id,
    name,
    externalId: `${id}-moxfield`,
    format: 'commander',
    versionCount,
    updatedAt: '2026-10-01T00:00:00.000Z',
  });

  function answer(...bodies: unknown[]): void {
    fetchMock.mockReset();
    for (const body of bodies) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    }
  }

  async function importPasted(): Promise<void> {
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Deck JSON'));
    await user.paste(DECK_JSON);
    await user.click(screen.getByRole('button', { name: 'Import deck' }));
  }

  function postedBodies(): Record<string, unknown>[] {
    return fetchMock.mock.calls.map((call) => {
      const body = (call[1] as RequestInit | undefined)?.body;
      if (typeof body !== 'string') throw new Error('No JSON body was sent');
      return JSON.parse(body) as Record<string, unknown>;
    });
  }

  it('continues the chosen deck (preselected by name) instead of tracking a new one', async () => {
    answer(
      {
        status: 'untracked',
        source: 'moxfield',
        name: 'Fixture Blue Farm',
        externalId: 'NewPublicId',
        decks: [candidate('deck-2', 'Another deck', 1), candidate('deck-1', 'Fixture Blue Farm', 3)],
      },
      { status: 'ingested', deckId: 'deck-1', changedSinceLastObservation: true },
    );
    const user = userEvent.setup();
    renderPasteCapture();
    await importPasted();

    const region = await screen.findByRole('region', { name: 'Or continue an existing deck’s history' });
    expect(region).toHaveTextContent('Deleted a deck on Moxfield and made it again?');
    const select = within(region).getByLabelText('Deck to continue');
    expect(select).toHaveValue('deck-1');
    expect(
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose one of your decks…', 'Another deck · 1 version', 'Fixture Blue Farm · 3 versions']);
    await user.selectOptions(select, 'deck-2');
    expect(within(region).getByRole('button', { name: 'Continue “Another deck”' })).toBeEnabled();
    await user.selectOptions(select, 'deck-1');
    await user.click(within(region).getByRole('button', { name: 'Continue “Fixture Blue Farm”' }));

    expect(await screen.findByText(/The deck now continues from this Moxfield deck/)).toBeInTheDocument();
    const [first, second] = postedBodies();
    expect(second).toEqual({ ...first, track: false, relinkDeckId: 'deck-1' });
    expect(navigation.replace).toHaveBeenCalledWith('/decks/deck-1?captured=1&relinked=1');
  });

  it('preselects nothing when no single deck has the captured deck’s name', async () => {
    answer({
      status: 'untracked',
      source: 'moxfield',
      name: 'Fixture Blue Farm',
      externalId: 'NewPublicId',
      decks: [candidate('deck-1', 'Fixture Blue Farm', 3), candidate('deck-2', 'fixture  blue farm', 0)],
    });
    renderPasteCapture();
    await importPasted();

    const region = await screen.findByRole('region', { name: 'Or continue an existing deck’s history' });
    expect(within(region).getByLabelText('Deck to continue')).toHaveValue('');
    expect(within(region).getByRole('button', { name: 'Continue the chosen deck' })).toBeDisabled();
  });

  it('offers nothing to continue to a user without decks', async () => {
    answer({
      status: 'untracked',
      source: 'moxfield',
      name: 'Fixture Blue Farm',
      externalId: 'x',
      decks: [],
    });
    renderPasteCapture();
    await importPasted();
    expect(await screen.findByRole('heading', { name: 'Track “Fixture Blue Farm”?' })).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Or continue an existing deck’s history' }),
    ).not.toBeInTheDocument();
  });
});
