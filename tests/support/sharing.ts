/**
 * Helpers for tests of share links (ADR 0007): the owner's share link services and the
 * viewer scope, on a {@link ServiceHarness}'s database, clock and logger, plus a deck
 * history with committed and uncommitted state to share.
 */
import type { SessionUser, SignIn } from '@/server/auth/types';
import {
  createShareLinkServices,
  openSharedDeck,
  type DeckServices,
  type SharedDeckAccess,
  type ShareLinkServices,
} from '@/server/services';
import { signUp } from '@tests/support/auth';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  defined,
  moveCard,
  publishAndRefresh,
  type ServiceHarness,
} from '@tests/support/services';
import type { MoxDeckSpec } from '@tests/support/moxfield-deck-builder';

export const APP_URL = 'https://decks.example.com';

/** The owner's share link services for `user` (as `shareLinkServicesFor(user)` in the app). */
export function shareLinksOf(harness: ServiceHarness, user: SessionUser): ShareLinkServices {
  return createShareLinkServices({ db: harness.db, user, now: harness.clock.now, logger: harness.logger });
}

/** The viewer scope of `token` (as `sharedDeckServices(token)` in the app). */
export function openShared(harness: ServiceHarness, token: unknown): Promise<SharedDeckAccess | null> {
  return openSharedDeck(token, {
    db: harness.db,
    sources: harness.sources,
    now: harness.clock.now,
    logger: harness.logger,
  });
}

/** The token at the end of a share link URL (`…/s/gmv_…`). */
export function tokenOfShareUrl(url: string): string {
  const token = new URL(url).pathname.split('/').at(-1);
  if (!token?.startsWith('gmv_')) throw new Error(`No share token in ${url}`);
  return token;
}

/** Commits Moxfield's current state of `spec` on the deck, the way the deck page does. */
export async function publishAndCommit(
  harness: ServiceHarness,
  services: DeckServices,
  deckId: string,
  spec: MoxDeckSpec,
  message: string,
  tags?: string[],
) {
  await publishAndRefresh({ ...harness, services }, deckId, spec);
  return committed(await commitReviewed({ ...harness, services }, deckId, message, tags));
}

export interface SharedHistory {
  owner: SignIn;
  services: DeckServices;
  shareLinks: ShareLinkServices;
  deckId: string;
}

/**
 * Mikko's Blue Farm with two versions and uncommitted changes on top:
 *
 * - v1 `First list` (tagged `tournament`, with the note `Top 4 at the local`);
 * - v2 `Cut Dress Down` (Dress Down moved to Considering);
 * - uncommitted: the deck renamed to `Blue Farm (secret tech)`, the commanders changed
 *   to Tymna and Thrasios, Mystic Remnant added and Pyroclasm cut.
 */
export async function sharedHistory(harness: ServiceHarness, name = 'Mikko'): Promise<SharedHistory> {
  const owner = await signUp(harness.auth, name);
  const services = harness.servicesForWorkspace(owner.user.workspaceId);
  harness.api.setDeck(blueFarmSpec());
  const tracked = await services.trackDeck('https://moxfield.com/decks/' + blueFarmSpec().publicId);
  if (!tracked.ok) throw new Error(tracked.reason);
  const { deckId } = tracked;
  committed(await commitReviewed({ ...harness, services }, deckId, 'First list', ['tournament']));
  await services.setNote(deckId, 1, 'Top 4 at the local');
  const v2 = moveCard(blueFarmSpec({ version: 2 }), 'Dress Down', 'mainboard', 'considering');
  await publishAndCommit(harness, services, deckId, v2, 'Cut Dress Down');
  await publishAndRefresh({ ...harness, services }, deckId, {
    ...v2,
    version: 3,
    name: 'Blue Farm (secret tech)',
    commanders: ['Tymna the Weaver', 'Thrasios, Triton Hero'],
    mainboard: [...(v2.mainboard ?? []), 'Mystic Remnant'],
    sideboard: [],
  });
  const overview = defined(await services.getOverview(deckId));
  if (overview.status !== 'uncommitted') throw new Error('Expected uncommitted changes');
  return { owner, services, shareLinks: shareLinksOf(harness, owner.user), deckId };
}
