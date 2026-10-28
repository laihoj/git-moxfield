'use server';

/**
 * The deck view toggle's server action (MTG · cEDH, see `@/core/deck-view`). It sets a
 * cookie of the browser and nothing else, so it needs no session: share link viewers
 * toggle too, and nothing about the link (never its token) is sent. Then every open deck
 * page is rendered again in the new view.
 */
import { revalidatePath } from 'next/cache';

import { isDeckView } from '@/core/deck-view';
import { setDeckViewCookie } from '@/server/deck-view';

/** Remembers `view`; an unknown value changes nothing. */
export async function setDeckViewAction(view: unknown): Promise<void> {
  if (!isDeckView(view)) return;
  await setDeckViewCookie(view);
  revalidatePath('/', 'layout');
}
