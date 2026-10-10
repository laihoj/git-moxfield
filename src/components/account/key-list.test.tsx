// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { KeyList } from './key-list';

const revokeKeyAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/account-actions', () => ({ revokeKeyAction }));

describe('KeyList', () => {
  it('lists bookmarklets with their use, and revokes one after confirming, saying what else ends', async () => {
    const user = userEvent.setup();
    revokeKeyAction.mockResolvedValue({ ok: true });
    render(
      <KeyList
        keys={[
          {
            id: 'k1',
            label: 'Laptop Chrome',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: '2026-10-09T10:00:00.000Z',
            madeFrom: null,
            derived: [],
          },
          {
            id: 'k2',
            label: 'Phone',
            createdAt: '2026-10-02T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [],
          },
        ]}
      />,
    );
    const rows = [...screen.getByRole('list', { name: 'Bookmarklets' }).querySelectorAll(':scope > li')];
    expect(rows[0]).toHaveTextContent('Laptop Chrome');
    expect(rows[0]).toHaveTextContent('Last used');
    expect(rows[1]).toHaveTextContent('Never used');

    await user.click(screen.getByRole('button', { name: 'Revoke Phone' }));
    expect(revokeKeyAction).not.toHaveBeenCalled();
    const group = screen.getByRole('group');
    expect(group).toHaveTextContent('Revoke “Phone”? It stops working at once');
    expect(group).toHaveTextContent(
      'browsers signed in with a device link made on one of them, are signed out',
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('k2', false);
  });

  it('shows what a key was made with, and offers to revoke what was made through it', async () => {
    const user = userEvent.setup();
    revokeKeyAction.mockResolvedValue({ ok: true });
    render(
      <KeyList
        keys={[
          {
            id: 'minted',
            label: 'Laptop Chrome 2',
            createdAt: '2026-10-03T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: { id: 'stolen', label: 'Laptop' },
            derived: [],
          },
          {
            id: 'stolen',
            label: 'Laptop',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [
              { id: 'minted', label: 'Laptop Chrome 2' },
              { id: 'other', label: 'Tablet' },
            ],
          },
        ]}
      />,
    );
    const rows = [...screen.getByRole('list', { name: 'Bookmarklets' }).querySelectorAll(':scope > li')];
    expect(rows[0]).toHaveTextContent('Via “Laptop”');
    expect(rows[1]).not.toHaveTextContent('Via');

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const choice = screen.getByRole('checkbox', {
      name: /Also revoke the bookmarklets made in a browser it signed in: “Laptop Chrome 2” and “Tablet”/,
    });
    expect(choice).not.toBeChecked();
    await user.click(choice);
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('stolen', true);
  });

  it('points to creating one when there are none', () => {
    render(<KeyList keys={[]} />);
    expect(screen.getByText('No bookmarklets yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a bookmarklet' })).toHaveAttribute('href', '/setup');
  });
});
