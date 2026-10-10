// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { RevokedKeyShareLinks } from './revoked-key-share-links';

const revokeKeyShareLinksAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/account-actions', () => ({ revokeKeyShareLinksAction }));

const KEYS = [
  { id: 'k1', label: 'Old phone', revokedAt: '2026-10-09T10:00:00.000Z', shareLinkCount: 2 },
  { id: 'k2', label: 'Tablet', revokedAt: '2026-10-01T10:00:00.000Z', shareLinkCount: 1 },
];

describe('RevokedKeyShareLinks', () => {
  it('lists each revoked bookmarklet with how many of its share links still work', () => {
    render(<RevokedKeyShareLinks keys={KEYS} />);
    const list = screen.getByRole('list', { name: 'Share links of revoked bookmarklets' });
    const rows = [...list.querySelectorAll(':scope > li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Old phone');
    expect(rows[0]).toHaveTextContent('2 share links still working');
    expect(rows[0]).toHaveTextContent('Revoked');
    expect(rows[1]).toHaveTextContent('1 share link still working');
  });

  it('revokes a bookmarklet’s share links after confirming, saying who loses access', async () => {
    const user = userEvent.setup();
    revokeKeyShareLinksAction.mockResolvedValue({ ok: true });
    render(<RevokedKeyShareLinks keys={KEYS} />);

    await user.click(screen.getByRole('button', { name: 'Revoke the share links of Tablet' }));
    expect(revokeKeyShareLinksAction).not.toHaveBeenCalled();
    expect(screen.getByRole('group')).toHaveTextContent(
      'Revoke the share link made in a browser “Tablet” signed in? Anyone using it loses access at once',
    );
    await user.click(screen.getByRole('button', { name: 'Revoke share link' }));
    expect(revokeKeyShareLinksAction).toHaveBeenCalledWith('k2');
  });

  it('shows why revoking failed', async () => {
    const user = userEvent.setup();
    revokeKeyShareLinksAction.mockResolvedValue({
      ok: false,
      message: 'These share links were already revoked.',
    });
    render(<RevokedKeyShareLinks keys={KEYS} />);
    await user.click(screen.getByRole('button', { name: 'Revoke the share links of Old phone' }));
    expect(screen.getByRole('group')).toHaveTextContent('Revoke the 2 share links made in a browser');
    await user.click(screen.getByRole('button', { name: 'Revoke share links' }));
    expect(await screen.findByText('These share links were already revoked.')).toBeInTheDocument();
  });
});
