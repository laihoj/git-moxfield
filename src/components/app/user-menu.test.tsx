// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { UserMenu } from './user-menu';

vi.mock('@/app/auth-actions', () => ({ signOutAction: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/account' }));

function panel(): HTMLElement {
  const button = screen.getByRole('button', { name: /Account menu/ });
  const id = button.getAttribute('aria-controls');
  const element = id === null ? null : document.getElementById(id);
  if (element === null) throw new Error('No menu panel');
  return element;
}

describe('UserMenu', () => {
  it('names the signed-in user and opens a panel with Account and Sign out', async () => {
    const user = userEvent.setup();
    render(<UserMenu displayName="Mikko Korhonen" isAdmin={false} />);

    const button = screen.getByRole('button', { name: 'Account menu, signed in as Mikko Korhonen' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).not.toBeVisible();

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).toBeVisible();
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('href', '/account');
    expect(screen.getByRole('link', { name: 'Account' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toHaveAttribute('type', 'submit');
  });

  it('offers Admin to admins only', async () => {
    const user = userEvent.setup();
    render(<UserMenu displayName="Jaakko" isAdmin />);
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
  });

  it('closes with Escape (focus back on the button), a click outside, or choosing an item', async () => {
    const user = userEvent.setup();
    render(
      <>
        <UserMenu displayName="Jaakko" isAdmin />
        <p>Outside</p>
      </>,
    );
    const button = screen.getByRole('button', { name: /Account menu/ });

    await user.click(button);
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(screen.getByText('Outside'));
    expect(button).toHaveAttribute('aria-expanded', 'false');

    // jsdom cannot navigate: keep the link's default action from running, after React's handlers.
    const stayHere = (event: MouseEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('click', stayHere);
    await user.click(button);
    await user.click(screen.getByRole('link', { name: 'Admin' }));
    expect(button).toHaveAttribute('aria-expanded', 'false');
    window.removeEventListener('click', stayHere);
  });
});
