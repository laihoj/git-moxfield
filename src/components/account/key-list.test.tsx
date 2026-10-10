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
            shareLinkCount: 0,
            derivedShareLinkCount: 0,
          },
          {
            id: 'k2',
            label: 'Phone',
            createdAt: '2026-10-02T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [],
            shareLinkCount: 0,
            derivedShareLinkCount: 0,
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
    // No bookmarklets were made through it; share links may still be, until it is revoked.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(
      screen.getByRole('checkbox', { name: /^Also revoke any share links made in a browser it signed in\./ }),
    ).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('k2', false, false);
  });

  it('offers the share links also when none were counted when the page loaded', async () => {
    // A link made after the page loaded (by whoever holds a stolen copy of the key) is
    // revoked too: the server revokes what exists when it runs.
    const user = userEvent.setup();
    revokeKeyAction.mockResolvedValue({ ok: true });
    render(
      <KeyList
        keys={[
          {
            id: 'k1',
            label: 'Laptop',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [],
            shareLinkCount: 0,
            derivedShareLinkCount: 0,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    await user.click(screen.getByRole('checkbox', { name: /^Also revoke any share links made/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('k1', false, true);
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
            shareLinkCount: 0,
            derivedShareLinkCount: 0,
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
            shareLinkCount: 0,
            derivedShareLinkCount: 0,
          },
        ]}
      />,
    );
    const rows = [...screen.getByRole('list', { name: 'Bookmarklets' }).querySelectorAll(':scope > li')];
    expect(rows[0]).toHaveTextContent('Via “Laptop”');
    expect(rows[1]).not.toHaveTextContent('Via');

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    const choice = screen.getByRole('checkbox', {
      name: /Also revoke the bookmarklets made in a browser it signed in: “Laptop Chrome 2” and “Tablet”/,
    });
    expect(choice).not.toBeChecked();
    await user.click(choice);
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('stolen', true, false);
  });

  it('offers to revoke the share links made through a key, counting what would be revoked', async () => {
    const user = userEvent.setup();
    revokeKeyAction.mockResolvedValue({ ok: true });
    render(
      <KeyList
        keys={[
          {
            id: 'stolen',
            label: 'Laptop',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [{ id: 'minted', label: 'Laptop Chrome 2' }],
            shareLinkCount: 2,
            derivedShareLinkCount: 1,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const links = screen.getByRole('checkbox', {
      name: /^Also revoke the 2 share links made in a browser it signed in\./,
    });
    expect(links).not.toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: /Also revoke the bookmarklet made/ }));
    expect(links).toHaveAccessibleName(
      expect.stringMatching(
        /^Also revoke the 3 share links made in browsers these bookmarklets signed in\./,
      ) as string,
    );
    await user.click(links);
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('stolen', true, true);
  });

  it('counts the share links made through derived keys only together with those keys', async () => {
    const user = userEvent.setup();
    revokeKeyAction.mockResolvedValue({ ok: true });
    render(
      <KeyList
        keys={[
          {
            id: 'stolen',
            label: 'Laptop',
            createdAt: '2026-10-01T10:00:00.000Z',
            lastUsedAt: null,
            madeFrom: null,
            derived: [{ id: 'minted', label: 'Laptop Chrome 2' }],
            shareLinkCount: 0,
            derivedShareLinkCount: 1,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    const links = screen.getByRole('checkbox', { name: /^Also revoke any share links made in a browser it/ });

    const derived = screen.getByRole('checkbox', { name: /Also revoke the bookmarklet made/ });
    await user.click(derived);
    expect(links).toHaveAccessibleName(
      expect.stringMatching(
        /^Also revoke the share link made in browsers these bookmarklets signed in\./,
      ) as string,
    );
    await user.click(links);
    // Unticking the bookmarklets keeps the choice made: the key's own links, whatever exist by then.
    await user.click(derived);
    expect(links).toBeChecked();
    expect(links).toHaveAccessibleName(
      expect.stringMatching(/^Also revoke any share links made in a browser it signed in\./) as string,
    );
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(revokeKeyAction).toHaveBeenCalledWith('stolen', false, true);
  });

  it('points to creating one when there are none', () => {
    render(<KeyList keys={[]} />);
    expect(screen.getByText('No bookmarklets yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create a bookmarklet' })).toHaveAttribute('href', '/setup');
  });
});
