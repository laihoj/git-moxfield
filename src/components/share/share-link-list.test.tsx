// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { ShareLinkDTO } from '@/server/services/types';

import { ShareLinkList } from './share-link-list';

const revokeShareLinkAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/share-actions', () => ({ revokeShareLinkAction }));

const LINKS: ShareLinkDTO[] = [
  {
    id: 'l2',
    deckId: 'd1',
    label: 'Playgroup chat',
    includeNotes: false,
    createdAt: '2026-10-09T12:00:00.000Z',
    lastViewedAt: null,
  },
  {
    id: 'l1',
    deckId: 'd1',
    label: 'For Mikko',
    includeNotes: true,
    createdAt: '2026-10-01T12:00:00.000Z',
    lastViewedAt: '2026-10-08T12:00:00.000Z',
  },
];

function rows(): HTMLElement[] {
  return [...screen.getByRole('list', { name: 'Share links' }).querySelectorAll<HTMLElement>(':scope > li')];
}

describe('ShareLinkList', () => {
  it('lists links with their name, use and whether they show notes, never a URL', () => {
    render(<ShareLinkList deckId="d1" links={LINKS} />);
    const [playgroup, mikko] = rows();
    expect(playgroup).toHaveTextContent('Playgroup chat');
    expect(playgroup).toHaveTextContent('Not viewed yet');
    expect(playgroup).not.toHaveTextContent('Includes notes');
    expect(mikko).toHaveTextContent('For Mikko');
    expect(mikko).toHaveTextContent('Includes notes');
    expect(mikko).toHaveTextContent('Last viewed');
    expect(document.body).not.toHaveTextContent('gmv_');
    expect(document.body).not.toHaveTextContent('/s/');
  });

  it('revokes a link only after confirming what it ends', async () => {
    const user = userEvent.setup();
    revokeShareLinkAction.mockResolvedValue({ ok: true });
    render(<ShareLinkList deckId="d1" links={LINKS} />);

    await user.click(screen.getByRole('button', { name: 'Revoke For Mikko' }));
    expect(revokeShareLinkAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group');
    expect(confirm).toHaveTextContent('Revoke “For Mikko”? Anyone using it loses access at once.');
    await user.click(within(confirm).getByRole('button', { name: 'Revoke link' }));
    expect(revokeShareLinkAction).toHaveBeenCalledWith('d1', 'l1');
  });

  it('shows why a revoke failed', async () => {
    const user = userEvent.setup();
    revokeShareLinkAction.mockResolvedValue({ ok: false, message: 'This link was already revoked.' });
    render(<ShareLinkList deckId="d1" links={LINKS} />);
    await user.click(screen.getByRole('button', { name: 'Revoke Playgroup chat' }));
    await user.click(screen.getByRole('button', { name: 'Revoke link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This link was already revoked.');
  });

  it('explains the list before there are links', () => {
    render(<ShareLinkList deckId="d1" links={[]} />);
    expect(screen.getByText('No links yet')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
