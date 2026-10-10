'use client';

/**
 * In-app navigation: every link to a page of the app and every form that opens one, and
 * the one place that decides how Next.js prefetches them. ESLint forbids `next/link` and
 * `next/form` everywhere else (`eslint.config.mjs`).
 *
 * **Policy: nothing is prefetched**, neither when a link scrolls into view nor on hover.
 * Next.js prefetches the page behind every visible `<Link>` and `<Form>` by default, and
 * every page of git-moxfield is rendered per request (the root layout opts out of
 * prerendering; pages read a session or a share link and query the database), so each
 * prefetch is a server render: hosted, function invocations (Netlify bills invocations
 * and compute) and rows read (Turso bills them). Measured with `next start` against the
 * libSQL server (ADR 0008): a version page view took 24 requests, 223 queries and 2,977
 * rows read with prefetching, and 1 request, 38 queries and 848 rows without; a
 * version's Deck tab, whose card names all link to their histories, took about 100
 * requests and 12,000 rows once scrolled through.
 *
 * Prefetching on hover was measured too and left out: on desktop the next page showed
 * about one round trip sooner, on touch screens (no hover) not at all, and it took three
 * server renders per click instead of one, and two for every link only hovered.
 *
 * What keeps navigation responsive instead: deck pages stream, so their `loading.tsx`
 * skeleton shows as soon as the server answers; until the new page shows, the navigation
 * is pending, which {@link NavigationProgress} (in the root layout) shows as a progress
 * bar when the wait is long enough to notice.
 */
import type { Route } from 'next';
import NextLink, { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore, useTransition, type ComponentProps, type SubmitEvent } from 'react';

import { formSubmissionRoute } from '@/lib/routes';

// Pending navigations, counted by the links and forms that started them.
let pendingNavigations = 0;
const pendingListeners = new Set<() => void>();

function changePendingNavigations(delta: number): void {
  pendingNavigations += delta;
  for (const listener of pendingListeners) listener();
}

function subscribeToPendingNavigations(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

function isNavigating(): boolean {
  return pendingNavigations > 0;
}

function isNavigatingOnServer(): boolean {
  return false;
}

/** Counts a navigation as pending while `pending` is true and the caller is mounted. */
function useReportPendingNavigation(pending: boolean): void {
  useEffect(() => {
    if (!pending) return;
    changePendingNavigations(1);
    return () => {
      changePendingNavigations(-1);
    };
  }, [pending]);
}

/** Reports the enclosing link's navigation as pending (renders nothing). */
function LinkPendingReporter() {
  useReportPendingNavigation(useLinkStatus().pending);
  return null;
}

export interface LinkProps extends Omit<ComponentProps<typeof NextLink>, 'href' | 'prefetch'> {
  href: Route;
}

/**
 * A link to a page of the app (Next.js `<Link>`: client-side navigation), never
 * prefetched. Links to other sites are plain `<a>` elements (`ExternalButtonLink`).
 */
export function Link({ children, ...props }: LinkProps) {
  return (
    <NextLink {...props} prefetch={false}>
      {children}
      <LinkPendingReporter />
    </NextLink>
  );
}

export interface FormProps extends Omit<ComponentProps<'form'>, 'action' | 'method'> {
  /** The page the form opens; the form's fields become its query. */
  action: Route;
  /** Replace the current history entry instead of adding one. */
  replace?: boolean;
  /** Scroll to the top of the new page (default), or keep the scroll position. */
  scroll?: boolean;
}

/**
 * A GET form that opens a page of the app (a search, a comparison) with its fields as the
 * query: a client-side navigation when JavaScript runs, a plain form submission without.
 * Takes the place of `next/form`, which prefetches its action whenever it is in view and
 * tells no one that a submission is pending.
 */
export function Form({ action, replace = false, scroll = true, onSubmit, ...props }: FormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useReportPendingNavigation(pending);

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    const href = formSubmissionRoute(action, new FormData(event.currentTarget, event.nativeEvent.submitter));
    startTransition(() => {
      if (replace) router.replace(href, { scroll });
      else router.push(href, { scroll });
    });
  }

  return <form {...props} action={action} onSubmit={submit} />;
}

/**
 * A thin bar along the top of the window while a navigation started by a {@link Link} or
 * a {@link Form} waits for the server (styles: `.navigation-progress` in globals.css).
 * Rendered once, by the root layout. Decorative: the new page's title is announced when
 * it shows.
 */
export function NavigationProgress() {
  const navigating = useSyncExternalStore(subscribeToPendingNavigations, isNavigating, isNavigatingOnServer);
  return <div aria-hidden="true" data-active={navigating ? '' : undefined} className="navigation-progress" />;
}
