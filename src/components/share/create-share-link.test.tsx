// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { CreateShareLinkResult } from '@/app/action-types';

import { CreateShareLink } from './create-share-link';

const createShareLinkAction = vi.hoisted(() =>
  vi.fn<(deckId: string, label: string, includeNotes: boolean) => Promise<CreateShareLinkResult>>(),
);
vi.mock('@/app/share-actions', () => ({ createShareLinkAction }));

const URL = `http://localhost:3000/s/gmv_${'A'.repeat(43)}`;

function created(label: string, includeNotes: boolean): CreateShareLinkResult {
  return {
    status: 'created',
    url: URL,
    link: {
      id: 'l1',
      deckId: 'd1',
      label,
      includeNotes,
      createdAt: '2026-10-10T12:00:00.000Z',
      lastViewedAt: null,
    },
  };
}

describe('CreateShareLink', () => {
  it('creates a labelled link with notes and shows its URL once, with a copy button and a warning', async () => {
    const user = userEvent.setup();
    createShareLinkAction.mockResolvedValue(created('For Mikko', true));
    render(<CreateShareLink deckId="d1" maxLabelLength={60} />);

    const label = screen.getByLabelText('Who is it for?');
    expect(label).toHaveAttribute('maxlength', '60');
    expect(label).toHaveAccessibleDescription(/Only you see this name/);
    await user.type(label, 'For Mikko');
    const notes = screen.getByRole('checkbox', { name: 'Include my version notes' });
    expect(notes).not.toBeChecked();
    expect(notes).toHaveAccessibleDescription(/Notes stay private unless you include them/);
    await user.click(notes);
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createShareLinkAction).toHaveBeenCalledWith('d1', 'For Mikko', true);
    const heading = await screen.findByRole('heading', { name: 'Link for “For Mikko” is ready' });
    expect(heading).toHaveFocus();
    expect(screen.getByText(URL)).toBeInTheDocument();
    expect(screen.getByText(/with your notes/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.getByText('Copy it now: it won’t be shown again.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Who is it for?')).not.toBeInTheDocument();
  });

  it('forgets the URL when done, and starts over with an empty form', async () => {
    const user = userEvent.setup();
    createShareLinkAction.mockResolvedValue(created('Playgroup', false));
    render(<CreateShareLink deckId="d1" maxLabelLength={60} />);
    await user.type(screen.getByLabelText('Who is it for?'), 'Playgroup');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByText(URL)).toBeInTheDocument();
    expect(screen.queryByText(/with your notes/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByText(URL)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Who is it for?')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Include my version notes' })).not.toBeChecked();
  });

  it('shows a label problem at the label and keeps what was typed', async () => {
    const user = userEvent.setup();
    createShareLinkAction.mockResolvedValue({
      status: 'error',
      field: 'label',
      message: 'Name the link, e.g. “For Mikko”.',
    });
    render(<CreateShareLink deckId="d1" maxLabelLength={60} />);
    await user.type(screen.getByLabelText('Who is it for?'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    const input = screen.getByLabelText('Who is it for?');
    expect(await screen.findByRole('alert')).toHaveTextContent('Name the link');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Name the link, e.g. “For Mikko”.');
    expect(input).toHaveValue('   ');
    await user.type(input, 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows other failures below the form', async () => {
    const user = userEvent.setup();
    createShareLinkAction.mockResolvedValue({
      status: 'error',
      message: 'You were signed out. Sign in again.',
    });
    render(<CreateShareLink deckId="d1" maxLabelLength={60} />);
    await user.type(screen.getByLabelText('Who is it for?'), 'For Mikko');
    await user.click(screen.getByRole('button', { name: 'Create link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You were signed out');
    expect(screen.getByLabelText('Who is it for?')).not.toHaveAttribute('aria-invalid');
  });
});
