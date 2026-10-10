// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { DeviceLinkPanel } from './device-link-panel';

const createDeviceLinkAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/account-actions', () => ({ createDeviceLinkAction }));

const URL_WITH_TOKEN = `https://decks.example.com/signin/gml_${'b'.repeat(43)}`;

describe('DeviceLinkPanel', () => {
  it('makes a one-time link and shows it as a QR code and as text to copy', async () => {
    const user = userEvent.setup();
    createDeviceLinkAction.mockResolvedValue({
      status: 'created',
      url: URL_WITH_TOKEN,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      qr: { size: 2, path: 'M0 0h1v1h-1z' },
    });
    render(<DeviceLinkPanel />);
    expect(screen.queryByText(URL_WITH_TOKEN)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create a sign-in link' }));
    const qr = await screen.findByRole('img', { name: 'QR code of the sign-in link' });
    expect(qr).toHaveAttribute('viewBox', '-4 -4 10 10');
    expect(qr.querySelector('path')).toHaveAttribute('d', 'M0 0h1v1h-1z');
    expect(screen.getByText(URL_WITH_TOKEN)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy sign-in link' })).toBeInTheDocument();
    expect(screen.getByText(/^Expires in 1[45] min$/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Make a new link' }));
    expect(createDeviceLinkAction).toHaveBeenCalledTimes(2);
  });

  it('shows why a link could not be made', async () => {
    const user = userEvent.setup();
    createDeviceLinkAction.mockResolvedValue({ status: 'error', message: 'Set PUBLIC_APP_URL.' });
    render(<DeviceLinkPanel />);
    await user.click(screen.getByRole('button', { name: 'Create a sign-in link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Set PUBLIC_APP_URL.');
  });
});
