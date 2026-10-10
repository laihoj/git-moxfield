// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { UserDTO } from '@/server/auth/types';

import { PeopleList } from './people-list';

const createRecoveryLinkAction = vi.hoisted(() => vi.fn());
const setUserDisabledAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/admin-actions', () => ({ createRecoveryLinkAction, setUserDisabledAction }));

function person(overrides: Partial<UserDTO>): UserDTO {
  return {
    id: 'u',
    displayName: 'Someone',
    role: 'member',
    createdAt: '2026-10-01T12:00:00.000Z',
    lastSeenAt: null,
    disabledAt: null,
    deckCount: 0,
    activeKeyCount: 0,
    ...overrides,
  };
}

const PEOPLE = [
  person({ id: 'me', displayName: 'Jaakko', role: 'admin', deckCount: 3, activeKeyCount: 2 }),
  person({ id: 'mikko', displayName: 'Mikko', deckCount: 1, activeKeyCount: 1 }),
  person({ id: 'aino', displayName: 'Aino', disabledAt: '2026-10-09T12:00:00.000Z' }),
];

function row(name: string): HTMLElement {
  const found = [
    ...screen.getByRole('list', { name: 'People' }).querySelectorAll<HTMLElement>(':scope > li'),
  ].find((item) => item.textContent.includes(name));
  if (found === undefined) throw new Error(`No row for ${name}`);
  return found;
}

describe('PeopleList', () => {
  it('shows role, state and counts, and no actions on one’s own row', () => {
    render(<PeopleList people={PEOPLE} currentUserId="me" withPendingRecovery={[]} />);
    const me = row('Jaakko');
    expect(me).toHaveTextContent('You');
    expect(me).toHaveTextContent('Admin');
    expect(me).toHaveTextContent('3 decks');
    expect(me).toHaveTextContent('2 bookmarklets');
    expect(within(me).queryByRole('button')).not.toBeInTheDocument();
    expect(row('Mikko')).toHaveTextContent('Not seen yet');
    expect(row('Aino')).toHaveTextContent('Disabled');
  });

  it('makes a recovery link and shows it once', async () => {
    const user = userEvent.setup();
    const url = `https://decks.example.com/signin/gml_${'c'.repeat(43)}`;
    createRecoveryLinkAction.mockResolvedValue({
      status: 'created',
      url,
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    // The page lists Mikko's new link as outstanding once the action has run.
    const { rerender } = render(
      <PeopleList people={PEOPLE} currentUserId="me" withPendingRecovery={['mikko']} />,
    );
    await user.click(screen.getByRole('button', { name: 'Create a recovery link for Mikko' }));
    expect(createRecoveryLinkAction).toHaveBeenCalledWith('mikko');
    expect(await screen.findByText(url)).toBeInTheDocument();
    expect(row('Mikko')).toHaveTextContent(
      'Send this only to Mikko: whoever opens it signs in as them, their other devices are signed out, and their bookmarklets and share links stop working.',
    );

    await user.click(screen.getByRole('button', { name: 'Hide recovery link' }));
    expect(screen.queryByText(url)).not.toBeInTheDocument();

    // Shown again after a new one; hidden by itself once used or withdrawn (no longer listed).
    await user.click(screen.getByRole('button', { name: 'Create a recovery link for Mikko' }));
    expect(await screen.findByText(url)).toBeInTheDocument();
    rerender(<PeopleList people={PEOPLE} currentUserId="me" withPendingRecovery={[]} />);
    expect(screen.queryByText(url)).not.toBeInTheDocument();
  });

  it('disables after confirming, and enables directly', async () => {
    const user = userEvent.setup();
    setUserDisabledAction.mockResolvedValue({ ok: true });
    render(<PeopleList people={PEOPLE} currentUserId="me" withPendingRecovery={[]} />);

    await user.click(screen.getByRole('button', { name: 'Disable Mikko' }));
    expect(setUserDisabledAction).not.toHaveBeenCalled();
    await user.click(within(row('Mikko')).getByRole('button', { name: 'Disable' }));
    expect(setUserDisabledAction).toHaveBeenCalledWith('mikko', true);

    // A disabled person cannot be sent a recovery link.
    expect(within(row('Aino')).queryByRole('button', { name: /recovery link/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable Aino' }));
    expect(setUserDisabledAction).toHaveBeenCalledWith('aino', false);
  });

  it('shows why an action failed', async () => {
    const user = userEvent.setup();
    setUserDisabledAction.mockResolvedValue({
      ok: false,
      message: 'Only admins can manage users and invites.',
    });
    render(<PeopleList people={PEOPLE} currentUserId="me" withPendingRecovery={[]} />);
    await user.click(screen.getByRole('button', { name: 'Enable Aino' }));
    expect(await within(row('Aino')).findByRole('alert')).toHaveTextContent('Only admins can manage users');
  });
});
