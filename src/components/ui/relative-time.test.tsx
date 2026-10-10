// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { formatDateTime, formatFullDateTime } from '@/lib/format';

import { AbsoluteTime, ClockTime, RelativeTime } from './relative-time';

const EDITED = '2026-10-09T09:00:00.000Z';

// Hydration is driven by hand here (Testing Library renders client-side only), so tell
// React that `act` is in use.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Server-renders `ui` at `serverNow`, then hydrates it in the browser at `browserNow`. */
async function serverRenderAndHydrate(ui: ReactElement, serverNow: string, browserNow: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(serverNow));
  const container = document.createElement('div');
  container.innerHTML = renderToString(ui);
  document.body.appendChild(container);
  const serverText = container.textContent;

  vi.setSystemTime(new Date(browserNow));
  // Sync the page's shared clock to the browser time first (as if another time element
  // had been mounted), so the result cannot depend on a stale clock from earlier tests.
  const warmUp = createRoot(document.createElement('div'));
  act(() => {
    warmUp.render(<RelativeTime value={EDITED} />);
  });
  act(() => {
    warmUp.unmount();
  });

  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  await act(async () => {
    root = hydrateRoot(container, ui);
    await Promise.resolve();
  });
  return { container, serverText, errors };
}

describe('RelativeTime', () => {
  it('renders the relative text on the server, so hydration changes nothing', async () => {
    const { container, serverText, errors } = await serverRenderAndHydrate(
      <RelativeTime value={EDITED} />,
      '2026-10-09T12:00:00.000Z',
      '2026-10-09T12:00:01.000Z',
    );
    expect(serverText).toBe('3 hours ago');
    expect(errors).not.toHaveBeenCalled();
    const time = container.querySelector('time');
    expect(time).toHaveTextContent('3 hours ago');
    expect(time).toHaveAttribute('datetime', EDITED);
    expect(time).toHaveAttribute('title', formatFullDateTime(EDITED));
  });

  it('switches to the browser clock after hydration when the two disagree, without warnings', async () => {
    const { container, serverText, errors } = await serverRenderAndHydrate(
      <RelativeTime value={EDITED} />,
      '2026-10-09T12:00:00.000Z',
      '2026-10-09T14:00:00.000Z',
    );
    expect(serverText).toBe('3 hours ago');
    expect(errors).not.toHaveBeenCalled();
    expect(container.querySelector('time')).toHaveTextContent('5 hours ago');
  });

  it('uses words, never a date, in the words style', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    const html = renderToString(<RelativeTime value="2026-08-31T18:03:00.000Z" style="words" />);
    expect(html).toContain('1 month ago');
  });
});

describe('AbsoluteTime and ClockTime', () => {
  it('render local times on the server and hydrate without warnings', async () => {
    const { container, errors } = await serverRenderAndHydrate(
      <p>
        <AbsoluteTime value={EDITED} /> <ClockTime value="2026-10-09T13:00:00.000Z" />
      </p>,
      '2026-10-09T12:00:00.000Z',
      '2026-10-09T12:00:00.000Z',
    );
    expect(errors).not.toHaveBeenCalled();
    const [absolute, clock] = container.querySelectorAll('time');
    expect(absolute).toHaveTextContent(formatDateTime(EDITED));
    expect(clock?.textContent).toMatch(/^(\w{3} \d{1,2}, )?\d{1,2}:\d{2}\s[AP]M$/);
  });
});
