// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';

import { RefreshOnReturn } from './refresh-on-return';

const refresh = vi.hoisted(() => vi.fn<() => void>());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

let visibility: DocumentVisibilityState = 'visible';

function showTab(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('RefreshOnReturn', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-10T12:00:00Z') });
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    refresh.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('re-renders the page from the server when its tab is shown or focused again', () => {
    render(<RefreshOnReturn />);
    expect(refresh).not.toHaveBeenCalled();

    showTab('hidden');
    expect(refresh).not.toHaveBeenCalled();
    showTab('visible');
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes at most every two seconds, however often the tab is switched', () => {
    render(<RefreshOnReturn />);
    showTab('visible');
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1_999);
    showTab('visible');
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    showTab('visible');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops listening when it unmounts', () => {
    const { unmount } = render(<RefreshOnReturn />);
    unmount();
    showTab('visible');
    window.dispatchEvent(new Event('focus'));
    expect(refresh).not.toHaveBeenCalled();
  });
});
