/**
 * Deck views: which zones a reader wants to see.
 *
 * - **MTG** (the default): every zone, as the source has it. Sideboard and Considering
 *   are part of the picture, and a card moving between the mainboard and Considering is a
 *   move.
 * - **cEDH**: the sleeved deck only. Commander decks have no sideboard, and the
 *   sideboard and Considering boards on Moxfield are a scratchpad of ideas. The view
 *   leaves every zone but the played ones out of sight, so a card moving from the
 *   mainboard to Considering is a cut, and one moving back is an add: exactly what to
 *   pull from and put into the sleeves.
 *
 * A view is a reading preference, applied to the read models only (diffs, lists, card
 * histories). What is stored, hashed, committed and restored is always the full snapshot.
 */
import type { ZoneQuantity } from './history/types';
import type { CanonicalSnapshot, ZoneMap } from './model';
import { isPlayedZone, type ZoneId } from './zones';

export type DeckView = 'mtg' | 'cedh';

export const DECK_VIEWS: readonly DeckView[] = ['mtg', 'cedh'];

/** The view everyone starts with: every zone. */
export const DEFAULT_DECK_VIEW: DeckView = 'mtg';

export const DECK_VIEW_LABELS: Record<DeckView, string> = { mtg: 'MTG', cedh: 'cEDH' };

/** What each view shows, for the toggle's descriptions. */
export const DECK_VIEW_DESCRIPTIONS: Record<DeckView, string> = {
  mtg: 'Every board: the sideboard and Considering included.',
  cedh: 'The sleeved deck only: cards in and out of the mainboard are adds and cuts.',
};

export function isDeckView(value: unknown): value is DeckView {
  return value === 'mtg' || value === 'cedh';
}

/** Whether `view` shows `zone`: every zone in the MTG view, played zones only in the cEDH view. */
export function viewShowsZone(view: DeckView, zone: ZoneId): boolean {
  return view === 'mtg' || isPlayedZone(zone);
}

/** The zones of `snapshot` that `view` shows, and the keys of the cards in them. */
function shownZones(snapshot: CanonicalSnapshot, view: DeckView): { zones: ZoneMap; keys: Set<string> } {
  const zones: ZoneMap = {};
  const keys = new Set<string>();
  for (const [zone, cards] of Object.entries(snapshot.zones) as [ZoneId, ZoneMap[ZoneId]][]) {
    if (cards === undefined || !viewShowsZone(view, zone)) continue;
    zones[zone] = cards;
    for (const card of cards) keys.add(card.key);
  }
  return { zones, keys };
}

function withCardTagsOf(
  snapshot: CanonicalSnapshot,
  zones: ZoneMap,
  keys: ReadonlySet<string>,
): CanonicalSnapshot {
  const cardTags = Object.fromEntries(Object.entries(snapshot.cardTags).filter(([key]) => keys.has(key)));
  return { ...snapshot, zones, cardTags };
}

/**
 * The snapshot as `view` sees it: without the zones the view hides, and without the card
 * tags of cards that are in no remaining zone. The MTG view returns the snapshot itself.
 * The result is canonical when the input is, but it is a projection for reading: never
 * hash, store or restore it. For a diff, use {@link viewSnapshotPair}.
 */
export function viewSnapshot(snapshot: CanonicalSnapshot, view: DeckView): CanonicalSnapshot {
  if (view === 'mtg') return snapshot;
  const { zones, keys } = shownZones(snapshot, view);
  return withCardTagsOf(snapshot, zones, keys);
}

/**
 * Two snapshots as `view` sees them, for diffing them: each without the zones the view
 * hides, and both with the card tags of exactly the cards that are in a shown zone of
 * either. So a tagged card cut to Considering takes its tags with it silently, instead of
 * reading as a card tag change, and a card only ever in hidden zones never reports one.
 * The MTG view returns the snapshots themselves.
 */
export function viewSnapshotPair(
  before: CanonicalSnapshot,
  after: CanonicalSnapshot,
  view: DeckView,
): [CanonicalSnapshot, CanonicalSnapshot] {
  if (view === 'mtg') return [before, after];
  const shownBefore = shownZones(before, view);
  const shownAfter = shownZones(after, view);
  const keys = new Set([...shownBefore.keys, ...shownAfter.keys]);
  return [withCardTagsOf(before, shownBefore.zones, keys), withCardTagsOf(after, shownAfter.zones, keys)];
}

/** The zones of a card that `view` shows (canonical order is kept). */
export function viewZoneQuantities(view: DeckView, zones: readonly ZoneQuantity[]): ZoneQuantity[] {
  return view === 'mtg' ? [...zones] : zones.filter(({ zone }) => viewShowsZone(view, zone));
}
