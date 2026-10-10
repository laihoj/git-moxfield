import { notFound } from 'next/navigation';

import type { SharedDeckAccess } from '@/server/services';

import { SharedLinkGone } from './link-gone';

/**
 * What a page below a share link renders when it has nothing to show. While the link
 * works, that is a version, card or page the shared deck does not have: `notFound()`,
 * answered inside the deck's frame (`./not-found.tsx`). When the link no longer grants
 * anything (`access` is `null`, or it stopped while the page rendered), it is
 * {@link SharedLinkGone}, which turns the whole page into the one every dead link gets:
 * the frame of a revoked link must not stay up with a "not part of the shared deck".
 */
export async function SharedPageMissing({ access }: { access: SharedDeckAccess | null }) {
  // Asked again, not answered from the request's cache: the link may be revoked meanwhile.
  if (access !== null && (await access.services.isAvailable())) notFound();
  return <SharedLinkGone />;
}
