// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import type { SessionDTO } from '@/server/auth/types';

import { DeviceList } from './device-list';

const revokeSessionAction = vi.hoisted(() => vi.fn());
const signOutOtherDevicesAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/account-actions', () => ({ revokeSessionAction, signOutOtherDevicesAction }));

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function session(overrides: Partial<SessionDTO>): SessionDTO {
  return {
    id: 's',
    createdVia: 'bookmarklet',
    userAgent: MAC,
    createdAt: '2026-10-09T12:00:00.000Z',
    lastSeenAt: '2026-10-09T12:00:00.000Z',
    expiresAt: '2027-11-13T12:00:00.000Z',
    current: false,
    ...overrides,
  };
}

describe('DeviceList', () => {
  it('lists this device first, by browser and platform, with how each signed in', () => {
    render(
      <DeviceList
        sessions={[
          session({ id: 'phone', userAgent: IPHONE, createdVia: 'device-link' }),
          session({ id: 'here', current: true }),
        ]}
      />,
    );
    const rows = [
      ...screen.getByRole('list', { name: 'Signed-in devices' }).querySelectorAll<HTMLElement>(':scope > li'),
    ];
    expect(rows).toHaveLength(2);
    const [here, phone] = rows;
    if (here === undefined || phone === undefined) throw new Error('Rows missing');
    expect(here).toHaveTextContent('Chrome on Mac');
    expect(here).toHaveTextContent('This device');
    expect(here).toHaveTextContent('Signed in with the bookmarklet');
    expect(within(here).queryByRole('button')).not.toBeInTheDocument();
    expect(phone).toHaveTextContent('Safari on iPhone');
    expect(phone).toHaveTextContent('Signed in with a device link');
    expect(within(phone).getByRole('button', { name: 'Sign out Safari on iPhone' })).toBeInTheDocument();
  });

  it('signs one other device out', async () => {
    const user = userEvent.setup();
    revokeSessionAction.mockResolvedValue({ ok: true });
    render(
      <DeviceList
        sessions={[session({ id: 'here', current: true }), session({ id: 'phone', userAgent: IPHONE })]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out Safari on iPhone' }));
    expect(revokeSessionAction).toHaveBeenCalledWith('phone');
  });

  it('signs all other devices out after confirming', async () => {
    const user = userEvent.setup();
    signOutOtherDevicesAction.mockResolvedValue({ ok: true });
    render(
      <DeviceList
        sessions={[
          session({ id: 'here', current: true }),
          session({ id: 'phone', userAgent: IPHONE }),
          session({ id: 'laptop' }),
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign out the other 2 devices' }));
    expect(screen.getByRole('group')).toHaveTextContent('Sign out 2 other devices?');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOutOtherDevicesAction).toHaveBeenCalledTimes(1);
  });

  it('offers no bulk sign-out when this is the only device', () => {
    render(<DeviceList sessions={[session({ id: 'here', current: true })]} />);
    expect(screen.queryByRole('button', { name: /Sign out the other/ })).not.toBeInTheDocument();
  });
});
