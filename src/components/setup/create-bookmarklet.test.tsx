// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { CreateBookmarkletState } from '@/app/action-types';

import { CreateBookmarklet } from './create-bookmarklet';

const createBookmarkletAction = vi.hoisted(() =>
  vi.fn<(previous: CreateBookmarkletState, formData: FormData) => Promise<CreateBookmarkletState>>(),
);
vi.mock('@/app/account-actions', () => ({ createBookmarkletAction }));

const POPUP = 'javascript:void%20(()%20%3D%3E%20%7B%7D)()%2F*popup*%2F';
const SAME_TAB = 'javascript:void%20(()%20%3D%3E%20%7B%7D)()%2F*same-tab*%2F';

function renderCreate(appUrl = 'https://decks.example.com') {
  render(<CreateBookmarklet defaultLabel="Chrome on Mac" siteHost="moxfield.com" appUrl={appUrl} />);
}

describe('CreateBookmarklet', () => {
  it('suggests a name from the browser and sends the chosen one', async () => {
    const user = userEvent.setup();
    createBookmarkletAction.mockResolvedValue({
      status: 'error',
      message: 'Labels can be at most 60 characters long.',
      label: 'x',
    });
    renderCreate();

    const input = screen.getByLabelText('Name your bookmarklet');
    expect(input).toHaveValue('Chrome on Mac');
    await user.clear(input);
    await user.type(input, 'Laptop Chrome');
    await user.click(screen.getByRole('button', { name: 'Create bookmarklet' }));

    const formData = createBookmarkletAction.mock.calls[0]?.[1];
    expect(formData?.get('label')).toBe('Laptop Chrome');
  });

  it('shows an error next to the name it keeps', async () => {
    const user = userEvent.setup();
    createBookmarkletAction.mockResolvedValue({
      status: 'error',
      message: 'Name the bookmarklet, e.g. “Laptop Chrome”.',
      label: '  ',
    });
    renderCreate();
    await user.click(screen.getByRole('button', { name: 'Create bookmarklet' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Name the bookmarklet');
    expect(screen.getByLabelText('Name your bookmarklet')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the new bookmarklets once, with the personal-key warning, until put away', async () => {
    const user = userEvent.setup();
    createBookmarkletAction.mockResolvedValue({
      status: 'created',
      id: 'key-1',
      label: 'Laptop Chrome',
      popup: POPUP,
      sameTab: SAME_TAB,
    });
    renderCreate('http://localhost:3000');
    await user.click(screen.getByRole('button', { name: 'Create bookmarklet' }));

    const section = await screen.findByRole('region', { name: '“Laptop Chrome” is ready. Install it now.' });
    expect(within(section).getByText('This is the only time it’s shown')).toBeInTheDocument();
    expect(section).toHaveTextContent('whoever has it can sign in as you');
    // React 19 refuses javascript: hrefs, so the links get theirs after mount.
    const links = section.querySelectorAll('a[href^="javascript:"]');
    expect([...links].map((link) => link.getAttribute('href')).sort()).toEqual([POPUP, SAME_TAB].sort());
    expect(within(section).getByRole('button', { name: 'Copy bookmarklet code' })).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy same-tab bookmarklet' })).toBeInTheDocument();
    // A loopback address only works on this computer: say how to reach it from a phone.
    expect(section).toHaveTextContent('That address only works on this computer.');

    await user.click(screen.getByRole('button', { name: 'I’ve installed it' }));
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('“Laptop Chrome” is installed');
    expect(screen.getByLabelText('Make another bookmarklet')).toHaveValue('Chrome on Mac');
  });

  it('does not talk about loopback addresses for a public address', async () => {
    const user = userEvent.setup();
    createBookmarkletAction.mockResolvedValue({
      status: 'created',
      id: 'k',
      label: 'Phone',
      popup: POPUP,
      sameTab: SAME_TAB,
    });
    renderCreate('https://decks.example.com');
    await user.click(screen.getByRole('button', { name: 'Create bookmarklet' }));
    const section = await screen.findByRole('region');
    expect(section).toHaveTextContent('These bookmarklets send decks to https://decks.example.com.');
    expect(section).not.toHaveTextContent('only works on this computer');
  });
});
