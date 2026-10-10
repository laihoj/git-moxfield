// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { InviteDTO } from '@/server/auth/types';

import { InviteList } from './invite-list';

const revokeInviteAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/admin-actions', () => ({ revokeInviteAction }));

function invite(overrides: Partial<InviteDTO>): InviteDTO {
  return {
    id: 'i',
    role: 'member',
    note: '',
    status: 'pending',
    createdAt: '2026-10-09T12:00:00.000Z',
    expiresAt: '2099-10-16T12:00:00.000Z',
    createdBy: 'Jaakko',
    usedAt: null,
    usedBy: null,
    ...overrides,
  };
}

function rows(): HTMLElement[] {
  return [...screen.getByRole('list', { name: 'Invites' }).querySelectorAll<HTMLElement>(':scope > li')];
}

describe('InviteList', () => {
  it('shows each invite’s state, note, role and who made or used it', () => {
    render(
      <InviteList
        invites={[
          invite({ id: 'a', note: 'Mikko', role: 'admin' }),
          invite({
            id: 'b',
            status: 'used',
            usedAt: '2026-10-09T13:00:00.000Z',
            usedBy: { id: 'u', displayName: 'Aino' },
          }),
          invite({ id: 'c', status: 'expired', createdBy: null }),
          invite({ id: 'd', status: 'revoked' }),
        ]}
      />,
    );
    const [pending, used, expired, revoked] = rows();
    expect(pending).toHaveTextContent('Pending');
    expect(pending).toHaveTextContent('Mikko');
    expect(pending).toHaveTextContent('Admin');
    expect(pending).toHaveTextContent('By Jaakko');
    expect(pending).toHaveTextContent('Expires in');
    expect(used).toHaveTextContent('Accepted');
    expect(used).toHaveTextContent('Accepted by Aino');
    expect(used).toHaveTextContent('No note');
    expect(expired).toHaveTextContent('Expired');
    expect(expired).toHaveTextContent('Created on the command line');
    expect(revoked).toHaveTextContent('Withdrawn');
    // Only pending invites can be withdrawn.
    expect(screen.getAllByRole('button', { name: /^Withdraw/ })).toHaveLength(1);
  });

  it('withdraws a pending invite after confirming', async () => {
    const user = userEvent.setup();
    revokeInviteAction.mockResolvedValue({ ok: true });
    render(<InviteList invites={[invite({ id: 'a', note: 'Mikko' })]} />);
    await user.click(screen.getByRole('button', { name: 'Withdraw the invite for Mikko' }));
    await user.click(screen.getByRole('button', { name: 'Withdraw invite' }));
    expect(revokeInviteAction).toHaveBeenCalledWith('a');
  });

  it('has an empty state', () => {
    render(<InviteList invites={[]} />);
    expect(screen.getByText('No invites yet')).toBeInTheDocument();
  });
});
