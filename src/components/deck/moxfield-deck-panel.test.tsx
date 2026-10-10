// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import '@/components/test-utils';
import type { RelinkDeckState } from '@/app/action-types';

import { ChangeMoxfieldDeckLink, MoxfieldDeckPanel } from './moxfield-deck-panel';

const relinkDeckAction = vi.hoisted(() =>
  vi.fn<(previous: RelinkDeckState, formData: FormData) => Promise<RelinkDeckState>>(),
);
vi.mock('@/app/actions', () => ({ relinkDeckAction }));

const URL = 'https://moxfield.com/decks/NewPublicId';

function renderPanel(relinks: Parameters<typeof MoxfieldDeckPanel>[0]['relinks'] = []) {
  return render(<MoxfieldDeckPanel deckId="d1" externalId="NewPublicId" url={URL} relinks={relinks} />);
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: 'Moxfield deck' });
}

describe('MoxfieldDeckPanel', () => {
  it('links to the Moxfield deck and lists the decks it followed before', () => {
    renderPanel([
      {
        previousExternalId: 'SecondPublicId',
        previousUrl: 'https://moxfield.com/decks/SecondPublicId',
        externalId: 'NewPublicId',
        url: URL,
        at: '2026-10-09T12:00:00.000Z',
      },
      {
        previousExternalId: 'FirstPublicId',
        previousUrl: 'https://moxfield.com/decks/FirstPublicId',
        externalId: 'SecondPublicId',
        url: 'https://moxfield.com/decks/SecondPublicId',
        at: '2026-10-01T12:00:00.000Z',
      },
    ]);
    const link = within(panel()).getByRole('link', { name: /NewPublicId/ });
    expect(link).toHaveAttribute('href', URL);
    expect(link).toHaveAttribute('target', '_blank');
    const earlier = within(panel()).getByRole('list', { name: 'Earlier Moxfield decks' });
    expect(
      within(earlier)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringMatching(/^Followed SecondPublicId until Oct 9, 2026/) as unknown,
      expect.stringMatching(/^Followed FirstPublicId until Oct 1, 2026/) as unknown,
    ]);
  });

  it('opens the form in place, sends the new deck and shows why it was refused', async () => {
    const user = userEvent.setup();
    relinkDeckAction.mockResolvedValue({
      status: 'error',
      message: 'Your deck “Copy” already tracks that Moxfield deck.',
      input: 'https://moxfield.com/decks/Taken',
      trackedBy: { deckId: 'd2', name: 'Copy' },
    });
    renderPanel();
    expect(within(panel()).queryByRole('list', { name: 'Earlier Moxfield decks' })).not.toBeInTheDocument();

    await user.click(within(panel()).getByRole('button', { name: 'Change Moxfield deck' }));
    const form = within(panel()).getByRole('form', { name: 'Change Moxfield deck' });
    expect(form).toHaveAccessibleDescription(/Deleted this deck on Moxfield and made it again\?/);
    const input = within(form).getByLabelText('New Moxfield deck URL');
    expect(input).toHaveFocus();
    await user.type(input, 'https://moxfield.com/decks/Taken');
    await user.click(within(form).getByRole('button', { name: 'Change deck' }));

    expect(relinkDeckAction).toHaveBeenCalledTimes(1);
    const sent = relinkDeckAction.mock.calls[0]?.[1];
    expect(sent?.get('deckId')).toBe('d1');
    expect(sent?.get('deck')).toBe('https://moxfield.com/decks/Taken');
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('already tracks that Moxfield deck');
    expect(within(alert).getByRole('link', { name: 'Open “Copy”' })).toHaveAttribute('href', '/decks/d2');
    // What was typed stays, marked invalid.
    expect(within(form).getByLabelText('New Moxfield deck URL')).toHaveValue(
      'https://moxfield.com/decks/Taken',
    );
    expect(within(form).getByLabelText('New Moxfield deck URL')).toHaveAttribute('aria-invalid', 'true');
  });

  it('closes the form on Cancel and gives the focus back', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(within(panel()).getByRole('button', { name: 'Change Moxfield deck' }));
    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    expect(within(panel()).queryByRole('form')).not.toBeInTheDocument();
    expect(within(panel()).getByRole('button', { name: 'Change Moxfield deck' })).toHaveFocus();
  });

  it('opens from a link elsewhere on the page (“Deck not found on Moxfield”)', async () => {
    const user = userEvent.setup();
    // jsdom does not scroll.
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    });
    render(
      <>
        <p>
          Deleted it and made it again?{' '}
          <ChangeMoxfieldDeckLink>Change the Moxfield deck</ChangeMoxfieldDeckLink>
        </p>
        <MoxfieldDeckPanel deckId="d1" externalId="NewPublicId" url={URL} relinks={[]} />
      </>,
    );
    const link = screen.getByRole('link', { name: 'Change the Moxfield deck' });
    expect(link).toHaveAttribute('href', '#moxfield-deck');
    await user.click(link);
    expect(screen.getByRole('form', { name: 'Change Moxfield deck' })).toBeInTheDocument();
    expect(screen.getByLabelText('New Moxfield deck URL')).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(window.location.hash).toBe('');
  });
});
