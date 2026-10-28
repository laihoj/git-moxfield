/**
 * The deck view of a request (`@/core/deck-view`): a reading preference kept in a cookie
 * of the browser, so it applies to every deck page the browser opens, the owner's and a
 * share link's alike, and needs no account. Pages read it ({@link currentDeckView}); the
 * toggle's server action sets it ({@link setDeckViewCookie}).
 *
 * The cookie holds no secret and grants nothing: an unexpected value only means the
 * default view.
 */
import 'server-only';

import { cookies, headers } from 'next/headers';
import { cache } from 'react';

import { DEFAULT_DECK_VIEW, isDeckView, type DeckView } from '@/core/deck-view';
import { isSecureCookieContext } from '@/server/auth/cookie-spec';
import { getConfig } from '@/server/config';

export const DECK_VIEW_COOKIE = 'gm_deck_view';

/** 400 days: the longest `Max-Age` browsers keep. */
const DECK_VIEW_MAX_AGE_S = 400 * 24 * 60 * 60;

/**
 * The deck view the request's browser asked for; the default without (or with an unknown)
 * cookie. Read once per request (`cache`): the layout, the pages and their data share it.
 */
export const currentDeckView = cache(async (): Promise<DeckView> => {
  const value = (await cookies()).get(DECK_VIEW_COOKIE)?.value;
  return isDeckView(value) ? value : DEFAULT_DECK_VIEW;
});

/**
 * Remembers `view` for the browser. For server functions and route handlers only: pages
 * cannot set cookies. `Secure` whenever the browser accepts it (see `isSecureCookieContext`).
 */
export async function setDeckViewCookie(view: DeckView): Promise<void> {
  const [store, requestHeaders] = await Promise.all([cookies(), headers()]);
  store.set(DECK_VIEW_COOKIE, view, {
    path: '/',
    maxAge: DECK_VIEW_MAX_AGE_S,
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureCookieContext(requestHeaders, getConfig().PUBLIC_APP_URL),
  });
}
