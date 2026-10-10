// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as NextLinkModule from 'next/link';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/components/test-utils';
import { ownerDeckRoutes } from '@/lib/routes';

import { Form, Link, NavigationProgress } from './navigation';

/** Props every Next.js `<Link>` was rendered with, and the link status `useLinkStatus` reports. */
const nextLink = vi.hoisted(() => ({ props: [] as Record<string, unknown>[], pending: false }));
vi.mock('next/link', async (importOriginal) => {
  const actual = await importOriginal<typeof NextLinkModule>();
  const { createElement } = await import('react');
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      nextLink.props.push(props);
      return createElement(actual.default, props);
    },
    useLinkStatus: () => ({ pending: nextLink.pending }),
  };
});

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function progressBar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('.navigation-progress');
  if (bar === null) throw new Error('No navigation progress bar');
  return bar;
}

beforeEach(() => {
  nextLink.props.length = 0;
  nextLink.pending = false;
});

describe('Link', () => {
  it('renders a Next.js link that is never prefetched', () => {
    render(
      <Link href="/setup" className="nav" aria-current="page" scroll={false}>
        Connect Moxfield
      </Link>,
    );
    const link = screen.getByRole('link', { name: 'Connect Moxfield' });
    expect(link).toHaveAttribute('href', '/setup');
    expect(link).toHaveClass('nav');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(nextLink.props).toHaveLength(1);
    expect(nextLink.props[0]).toMatchObject({ href: '/setup', prefetch: false, scroll: false });
  });
});

describe('NavigationProgress', () => {
  it('is shown while a clicked link waits for its page, and hidden from assistive tech', () => {
    const page = (link: boolean) => (
      <>
        <NavigationProgress />
        {link && <Link href="/account">Account</Link>}
      </>
    );
    const { rerender } = render(page(true));
    expect(progressBar()).toHaveAttribute('aria-hidden', 'true');
    expect(progressBar()).not.toHaveAttribute('data-active');

    nextLink.pending = true;
    rerender(page(true));
    expect(progressBar()).toHaveAttribute('data-active');

    // The new page replaces the one with the link.
    rerender(page(false));
    expect(progressBar()).not.toHaveAttribute('data-active');
  });
});

describe('Form', () => {
  function CompareForm({ replace, onSubmit }: { replace?: boolean; onSubmit?: () => void }) {
    return (
      <Form
        action={ownerDeckRoutes('d1').compare()}
        replace={replace}
        scroll={false}
        onSubmit={(event) => {
          onSubmit?.();
          if (onSubmit !== undefined) event.preventDefault();
        }}
      >
        <label>
          From
          <select name="from" defaultValue="v1">
            <option value="v1">v1</option>
            <option value="working">Current Moxfield deck</option>
          </select>
        </label>
        <input type="hidden" name="to" value="v2 & more" />
        <button type="submit">Compare</button>
      </Form>
    );
  }

  it('works without JavaScript: a GET form with the page as its action', () => {
    render(<CompareForm />);
    const form = screen.getByRole('button', { name: 'Compare' }).closest('form');
    expect(form).toHaveAttribute('action', '/decks/d1/compare');
    expect(form).not.toHaveAttribute('method');
  });

  it('opens the page with the fields as its query on the client', async () => {
    const user = userEvent.setup();
    render(<CompareForm />);
    await user.selectOptions(screen.getByLabelText('From'), 'working');
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(router.push).toHaveBeenCalledExactlyOnceWith('/decks/d1/compare?from=working&to=v2+%26+more', {
      scroll: false,
    });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('replaces the history entry when asked to', async () => {
    const user = userEvent.setup();
    render(<CompareForm replace />);
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(router.replace).toHaveBeenCalledExactlyOnceWith('/decks/d1/compare?from=v1&to=v2+%26+more', {
      scroll: false,
    });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('leaves a submission its own handler prevented alone', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<CompareForm onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(router.push).not.toHaveBeenCalled();
  });
});
