// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { AccountActionResult } from '@/app/action-types';
import '@/components/test-utils';

import { InlineConfirm } from './inline-confirm';

function renderConfirm(onConfirm: () => Promise<AccountActionResult>) {
  return render(
    <InlineConfirm
      trigger={{ label: 'Revoke', ariaLabel: 'Revoke Laptop Chrome' }}
      message="Revoke “Laptop Chrome”? It stops working at once."
      confirmLabel="Revoke bookmarklet"
      onConfirm={onConfirm}
    />,
  );
}

describe('InlineConfirm', () => {
  it('asks first, then runs the action once confirmed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue({ ok: true });
    renderConfirm(onConfirm);

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop Chrome' }));
    expect(onConfirm).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Revoke “Laptop Chrome”? It stops working at once.' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke bookmarklet' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Revoke Laptop Chrome' })).toBeInTheDocument();
  });

  it('shows the error and stays open when the action fails', async () => {
    const user = userEvent.setup();
    renderConfirm(vi.fn().mockResolvedValue({ ok: false, message: 'This bookmarklet was already revoked.' }));

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop Chrome' }));
    await user.click(screen.getByRole('button', { name: 'Revoke bookmarklet' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This bookmarklet was already revoked.');
    expect(screen.getByRole('group')).toBeInTheDocument();
  });

  it('cancels without running the action and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    renderConfirm(onConfirm);

    await user.click(screen.getByRole('button', { name: 'Revoke Laptop Chrome' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke Laptop Chrome' })).toHaveFocus();
  });
});
