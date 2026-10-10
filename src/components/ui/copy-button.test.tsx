// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { CopyButton } from './copy-button';

/** jsdom does not implement `isSecureContext`; define it per test. */
function setSecureContext(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', { value: secure, configurable: true });
}

describe('CopyButton', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies with the Clipboard API, confirms visually and announces it', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    setSecureContext(true);

    render(<CopyButton text={'1 Sol Ring\n'} label="Copy Mainboard" subject="Mainboard" />);
    await user.click(screen.getByRole('button', { name: 'Copy Mainboard' }));

    expect(writeText).toHaveBeenCalledWith('1 Sol Ring\n');
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Mainboard copied to the clipboard');

    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole('button', { name: 'Copy Mainboard' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('falls back to a temporary textarea outside secure contexts', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    setSecureContext(false);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
    let copiedText = '';
    execCommand.mockImplementation(() => {
      copiedText = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });

    render(<CopyButton text="restore text" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(copiedText).toBe('restore text');
    expect(document.querySelector('textarea')).toBeNull();
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('reports a failure when nothing can copy', async () => {
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    setSecureContext(false);
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });

    render(<CopyButton text="x" />);
    await user.click(screen.getByRole('button', { name: 'Copy' }));

    expect(screen.getByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Copying failed. Select the text and copy it manually.',
    );
  });
});
