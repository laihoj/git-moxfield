/**
 * Request-scoped data of the share link pages (`/s/[token]/…`, ADR 0007). The link's
 * token is the only authorization: these pages never look for a session, and viewers may
 * be signed out. `cache` makes the layout, the metadata and the page of one request
 * resolve the link once (and record the view once).
 *
 * The token is a bearer secret: pass the raw route segment to these loaders only, never
 * log it, and never hand it to a server action (the dev server logs their arguments).
 */
import 'server-only';

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import { sharedDeckServices } from '@/server/access';
import type { SharedDeckAccess } from '@/server/services';
import type { SharedOverviewDTO } from '@/server/services/types';

/**
 * The read-only services of the deck `token` grants, and what the link is; `null` for a
 * link that grants nothing (malformed, unknown or revoked, deck untracked, owner disabled).
 */
export const loadSharedDeck = cache((token: string) => sharedDeckServices(token));

/**
 * {@link loadSharedDeck}, answering 404 for a link that grants nothing: every such link
 * gets the very same "This link doesn't work" page (`src/app/s/not-found.tsx`), so a
 * revoked link tells nothing a mistyped one does not.
 *
 * For the layout only. A navigation inside the link re-renders the page but not the
 * layout, so a page's `notFound()` would land in the deck's frame (`./not-found.tsx`):
 * pages answer a link that grants nothing with `SharedPageMissing` (`./page-missing.tsx`).
 */
export async function requireSharedDeck(token: string): Promise<SharedDeckAccess> {
  const access = await loadSharedDeck(token);
  if (access === null) notFound();
  return access;
}

/**
 * The shared deck (committed facts) and its newest versions, or `null` when the link
 * grants nothing. For metadata, which must not answer 404 itself.
 */
export const findSharedOverview = cache(async (token: string) => {
  const access = await loadSharedDeck(token);
  return access === null ? null : access.services.getOverview();
});

/**
 * The metadata of a page below a share link (`/s/[token]/history`, …): `metadata(access)`
 * while the link works, and nothing when it grants nothing. A page's metadata overrides
 * its layout's, so a page that set its own title would title the "This link doesn't work"
 * page after itself (`History`, `Version not found`); with none, every link that grants
 * nothing keeps the layout's "Link not available", whichever page it names.
 */
export async function sharedPageMetadata(
  token: string,
  metadata: (access: SharedDeckAccess) => Metadata | Promise<Metadata>,
): Promise<Metadata> {
  const access = await loadSharedDeck(token);
  return access === null ? {} : metadata(access);
}

/** {@link findSharedOverview}, answering 404 when the link grants nothing. For the layout only (see {@link requireSharedDeck}). */
export async function loadSharedOverview(token: string): Promise<SharedOverviewDTO> {
  const overview = await findSharedOverview(token);
  if (overview === null) notFound();
  return overview;
}
