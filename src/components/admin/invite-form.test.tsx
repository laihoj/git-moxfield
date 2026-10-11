// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { CreateInviteState } from '@/app/action-types';

import { InviteForm } from './invite-form';

const createInviteAction = vi.hoisted(() =>
  vi.fn<(previous: CreateInviteState, formData: FormData) => Promise<CreateInviteState>>(),
);
vi.mock('@/app/admin-actions', () => ({ createInviteAction }));

const INVITE_URL = `https://decks.example.com/invite/gmi_${'d'.repeat(43)}`;

describe('InviteForm', () => {
  it('creates a member invite by default and shows its link once', async () => {
    const user = userEvent.setup();
    createInviteAction.mockResolvedValue({
      status: 'created',
      url: INVITE_URL,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      note: 'Mikko',
      role: 'member',
    });
    render(<InviteForm />);

    expect(screen.getByRole('radio', { name: /Member/ })).toBeChecked();
    await user.type(screen.getByLabelText('Who is it for?'), 'Mikko');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));

    const formData = createInviteAction.mock.calls[0]?.[1];
    expect(formData?.get('note')).toBe('Mikko');
    expect(formData?.get('role')).toBe('member');
    const created = await screen.findByRole('status', { name: 'New invite link' });
    expect(created).toHaveTextContent('Invite link ready');
    expect(created).toHaveTextContent('Send it to Mikko. It makes one member account.');
    expect(screen.getByText(INVITE_URL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy invite link' })).toBeInTheDocument();
  });

  it('sends the admin role and keeps the values when it fails', async () => {
    const user = userEvent.setup();
    createInviteAction.mockResolvedValue({
      status: 'error',
      message: 'Notes can be at most 200 characters long.',
      values: { note: 'Way too long', role: 'admin' },
    });
    render(<InviteForm />);
    await user.click(screen.getByRole('radio', { name: /Admin/ }));
    await user.type(screen.getByLabelText('Who is it for?'), 'Way too long');
    await user.click(screen.getByRole('button', { name: 'Create invite link' }));

    expect(createInviteAction.mock.calls[0]?.[1].get('role')).toBe('admin');
    expect(await screen.findByRole('alert')).toHaveTextContent('Notes can be at most 200 characters long.');
    expect(screen.getByLabelText('Who is it for?')).toHaveValue('Way too long');
    expect(screen.getByRole('radio', { name: /Admin/ })).toBeChecked();
  });
});
