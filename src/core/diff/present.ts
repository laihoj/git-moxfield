/**
 * Presentation helpers for semantic deck diffs: grouping for the diff view, compact
 * summary chips for the status view, and a suggested commit message.
 *
 * Still pure core logic (no React, no I/O) so the wording is deterministic and tested
 * alongside the diff engine. Commanders get special treatment everywhere: any
 * strategic change touching the commanders zone is reported once, under
 * "Commanders", and not again under zones or moves.
 */
import { getOrCreate } from '../collections';
import type { DeckView } from '../deck-view';
import type { CardKey } from '../model';
import { MINUS_SIGN, pluralize, truncateWithEllipsis, upperFirst } from '../text';
import { zoneEntries, zoneLabel, type ZoneId } from '../zones';
import { changeTouchesZone } from './deck-diff';
import {
  primerHasChange,
  type AddedChange,
  type CardChange,
  type DeckDiff,
  type DeckInfoChange,
  type QuantityChange,
  type RemovedChange,
} from './types';

export type DiffSectionKind =
  | 'commanders'
  | 'zone'
  /** The cEDH view's mainboard sections: the cards to add to the sleeved deck, and the cards to cut. */
  | 'add'
  | 'cut'
  | 'moves'
  | 'printings'
  | 'tags'
  | 'renames';

/** A titled group of card changes for display. */
export interface DiffSection {
  /** Stable id: `commanders`, `zone:<zoneId>`, `add`, `cut`, `moves`, `printings`, `tags`, `renames`. */
  id: string;
  kind: DiffSectionKind;
  title: string;
  /** Set for `commanders` and `zone` sections. */
  zone?: ZoneId;
  /** Changes in {@link DeckDiff.changes} order. */
  changes: CardChange[];
}

/** Whether a strategic change puts copies into its zone (an addition or more copies) rather than taking them out. */
export function changeAddsCopies(change: AddedChange | RemovedChange | QuantityChange): boolean {
  return change.type === 'added' || (change.type === 'quantity' && change.to > change.from);
}

/**
 * Groups a diff's card changes into display sections. Every card change appears in
 * exactly one section; empty sections are omitted. Section order:
 *
 * 1. `commanders` — every strategic change touching the commanders zone: additions,
 *    removals and quantity changes there, and moves from or to it (present exactly
 *    when `diff.commanders.changed`).
 * 2. One `zone` section per other zone (canonical order) with its additions,
 *    removals and quantity changes.
 * 3. `moves` (“Moved”) — moves not involving the commanders zone.
 * 4. `printings`, `tags` (“Card tags”), `renames` (“Renamed”) — cosmetic changes from
 *    any zone, the commanders zone included.
 *
 * In the cEDH view (`view: 'cedh'`; the diff is then one of snapshots the view projected,
 * see `viewSnapshot`), the mainboard section is replaced, in its place, by `add` (“Add”:
 * additions and quantity increases) and `cut` (“Cut”: removals and quantity decreases):
 * the cards to put into and pull out of the sleeves.
 */
export function groupDiffForDisplay(diff: DeckDiff, view: DeckView = 'mtg'): DiffSection[] {
  const commanders: CardChange[] = [];
  const zones = new Map<ZoneId, CardChange[]>();
  const moves: CardChange[] = [];
  const printings: CardChange[] = [];
  const tags: CardChange[] = [];
  const renames: CardChange[] = [];

  for (const change of diff.changes) {
    switch (change.type) {
      case 'moved':
        (changeTouchesZone(change, 'commanders') ? commanders : moves).push(change);
        break;
      case 'added':
      case 'removed':
      case 'quantity':
        if (change.zone === 'commanders') commanders.push(change);
        else getOrCreate(zones, change.zone, (): CardChange[] => []).push(change);
        break;
      case 'printing':
        printings.push(change);
        break;
      case 'tags':
        tags.push(change);
        break;
      case 'renamed':
        renames.push(change);
        break;
    }
  }

  const zoneSections = (zone: ZoneId, changes: CardChange[]): DiffSection[] => {
    if (view === 'cedh' && zone === 'mainboard') {
      const strategic = changes.filter(
        (change): change is AddedChange | RemovedChange | QuantityChange => change.type !== 'moved',
      );
      return [
        { id: 'add', kind: 'add', title: 'Add', changes: strategic.filter(changeAddsCopies) },
        {
          id: 'cut',
          kind: 'cut',
          title: 'Cut',
          changes: strategic.filter((change) => !changeAddsCopies(change)),
        },
      ];
    }
    return [{ id: `zone:${zone}`, kind: 'zone', title: zoneLabel(zone), zone, changes }];
  };
  const sections: DiffSection[] = [
    {
      id: 'commanders',
      kind: 'commanders',
      title: zoneLabel('commanders'),
      zone: 'commanders',
      changes: commanders,
    },
    ...zoneEntries(zones).flatMap(([zone, changes]) => zoneSections(zone, changes)),
    { id: 'moves', kind: 'moves', title: 'Moved', changes: moves },
    { id: 'printings', kind: 'printings', title: 'Printings', changes: printings },
    { id: 'tags', kind: 'tags', title: 'Card tags', changes: tags },
    { id: 'renames', kind: 'renames', title: 'Renamed', changes: renames },
  ];
  return sections.filter((section) => section.changes.length > 0);
}

export type SummaryChipTone = 'add' | 'remove' | 'move' | 'neutral' | 'cosmetic';

/** A compact, already-worded summary item, e.g. `+2 Mainboard`. */
export interface SummaryChip {
  label: string;
  tone: SummaryChipTone;
}

/**
 * Compact summary chips for the status view, in this order: commanders, copies added
 * and removed per zone (canonical zone order, moves excluded), moves aggregated by
 * destination zone, primer, deck info, then cosmetic changes. For example:
 * `Commanders changed`, `+2 Mainboard`, `−2 Mainboard`, `2 moved to Considering`,
 * `Primer +14 / −6 lines`, `Deck info changed`, `3 printing changes`. In the cEDH view the
 * mainboard's copies read as the sleeving to do: `2 to add`, `1 to cut`.
 */
export function summarizeDiff(diff: DeckDiff, view: DeckView = 'mtg'): SummaryChip[] {
  const chips: SummaryChip[] = [];
  if (diff.commanders.changed) chips.push({ label: 'Commanders changed', tone: 'neutral' });

  for (const stats of diff.stats.zones) {
    if (stats.zone === 'commanders') continue;
    if (view === 'cedh' && stats.zone === 'mainboard') {
      if (stats.added > 0) chips.push({ label: `${stats.added} to add`, tone: 'add' });
      if (stats.removed > 0) chips.push({ label: `${stats.removed} to cut`, tone: 'remove' });
      continue;
    }
    const label = zoneLabel(stats.zone);
    if (stats.added > 0) chips.push({ label: `+${stats.added} ${label}`, tone: 'add' });
    if (stats.removed > 0) chips.push({ label: `${MINUS_SIGN}${stats.removed} ${label}`, tone: 'remove' });
  }

  const movedTo = new Map<ZoneId, number>();
  for (const move of diff.stats.moves) {
    if (move.from === 'commanders' || move.to === 'commanders') continue;
    movedTo.set(move.to, (movedTo.get(move.to) ?? 0) + move.quantity);
  }
  for (const [zone, quantity] of zoneEntries(movedTo)) {
    chips.push({ label: `${quantity} moved to ${zoneLabel(zone)}`, tone: 'move' });
  }

  if (diff.primer.status === 'changed') {
    const { addedLines, removedLines } = diff.primer;
    chips.push({ label: `Primer +${addedLines} / ${MINUS_SIGN}${removedLines} lines`, tone: 'neutral' });
  }
  if (diff.primer.status === 'captured') chips.push({ label: 'Primer captured', tone: 'neutral' });
  if (diff.deck.length > 0) chips.push({ label: 'Deck info changed', tone: 'neutral' });

  const cosmetic: [number, string][] = [
    [diff.stats.printingChanges, 'printing change'],
    [diff.stats.tagChanges, 'card tag change'],
    [diff.stats.renames, 'renamed card'],
  ];
  for (const [count, noun] of cosmetic) {
    if (count > 0) chips.push({ label: pluralize(count, noun), tone: 'cosmetic' });
  }
  return chips;
}

/** Target maximum length of a suggested commit message (Git's conventional subject width). */
export const COMMIT_MESSAGE_MAX_LENGTH = 72;

/** Suggested (and default) message of a deck's first version. */
export const INITIAL_VERSION_MESSAGE = 'Initial version';

/** Literal text, or a list of card names that may be shortened to `A, B +N more`. */
type ClausePart = string | readonly string[];
type Clause = readonly ClausePart[];

/**
 * Suggests a short commit message describing the diff, e.g.
 * `Add Beseech the Mirror, Final Fortune; cut Dress Down`,
 * `Move Dress Down to Considering`, `Swap commander Kraum, Ludevic's Opus for Tana, the Bloodsower`,
 * `Update primer` or `Change printings`.
 *
 * Clause order: commanders, additions and cuts per zone (quantity increases count as
 * additions, decreases as cuts; the zone is named unless it is the mainboard), moves
 * per destination zone, primer, deck info. Cosmetic changes are described only when
 * nothing else changed. The message is at most {@link COMMIT_MESSAGE_MAX_LENGTH}
 * characters: name lists are shortened to `A, B +N more` first; when even single names
 * do not fit, trailing (least important) clauses are dropped, and a lone clause that
 * is still too long is cut with `…`. Returns `''` for an empty diff. Deterministic.
 */
export function suggestCommitMessage(diff: DeckDiff): string {
  const clauses = commitClauses(diff);
  const [first] = clauses;
  if (first === undefined) return '';

  for (let count = clauses.length; count >= 1; count--) {
    const kept = clauses.slice(0, count);
    const longestList = Math.max(
      1,
      ...kept.flat().map((part) => (typeof part === 'string' ? 0 : part.length)),
    );
    for (let limit = longestList; limit >= 1; limit--) {
      const message = renderMessage(kept, limit);
      if (message.length <= COMMIT_MESSAGE_MAX_LENGTH) return message;
    }
  }
  return truncateWithEllipsis(renderMessage([first], 1), COMMIT_MESSAGE_MAX_LENGTH);
}

/** Number of individual differences: card changes, deck info fields, and the primer. */
export function diffChangeCount(diff: DeckDiff): number {
  return diff.changes.length + diff.deck.length + (primerHasChange(diff.primer) ? 1 : 0);
}

/**
 * How many differences a view leaves out: those of the diff over the full snapshots
 * (`full`) that the diff over the snapshots the view projected (`visible`) has no
 * counterpart for. A move between a hidden and a shown zone has one (an addition or a
 * removal), so it does not count; a change within hidden zones only does. `0` for the
 * MTG view, whose diff is the full one.
 */
export function hiddenChangeCount(full: DeckDiff, visible: DeckDiff): number {
  return Math.max(0, diffChangeCount(full) - diffChangeCount(visible));
}

const DECK_INFO_CLAUSES: Record<DeckInfoChange['field'], string> = {
  name: 'rename deck',
  format: 'change format',
  description: 'update description',
  tags: 'update deck tags',
};

/** Card names keyed by card key, in insertion order, without duplicates. */
type NameList = Map<CardKey, string>;

function addName(names: NameList, change: CardChange): void {
  if (!names.has(change.key)) names.set(change.key, change.name);
}

function commitClauses(diff: DeckDiff): Clause[] {
  const incoming: NameList = new Map<CardKey, string>();
  const outgoing: NameList = new Map<CardKey, string>();
  const additions = new Map<ZoneId, NameList>();
  const cuts = new Map<ZoneId, NameList>();
  const movesTo = new Map<ZoneId, NameList>();
  const zoneNames = (map: Map<ZoneId, NameList>, zone: ZoneId): NameList =>
    getOrCreate(map, zone, (): NameList => new Map<CardKey, string>());

  for (const change of diff.changes) {
    switch (change.type) {
      case 'moved':
        if (change.to === 'commanders') addName(incoming, change);
        if (change.from === 'commanders') addName(outgoing, change);
        if (!changeTouchesZone(change, 'commanders')) addName(zoneNames(movesTo, change.to), change);
        break;
      case 'added':
      case 'removed':
      case 'quantity': {
        const grows = change.type === 'added' || (change.type === 'quantity' && change.to > change.from);
        if (change.zone === 'commanders') addName(grows ? incoming : outgoing, change);
        else addName(zoneNames(grows ? additions : cuts, change.zone), change);
        break;
      }
      default:
        break;
    }
  }

  const clauses: Clause[] = [];
  if (incoming.size > 0 || outgoing.size > 0) {
    const noun = incoming.size > 1 || outgoing.size > 1 ? 'commanders' : 'commander';
    if (incoming.size > 0 && outgoing.size > 0) {
      clauses.push([`swap ${noun} `, [...outgoing.values()], ' for ', [...incoming.values()]]);
    } else if (incoming.size > 0) {
      clauses.push([`add ${noun} `, [...incoming.values()]]);
    } else {
      clauses.push([`remove ${noun} `, [...outgoing.values()]]);
    }
  }
  const perZone = (
    map: Map<ZoneId, NameList>,
    verb: string,
    preposition: string,
    omitMainboard: boolean,
  ): void => {
    for (const [zone, names] of zoneEntries(map)) {
      const where = omitMainboard && zone === 'mainboard' ? '' : ` ${preposition} ${zoneLabel(zone)}`;
      clauses.push([`${verb} `, [...names.values()], where]);
    }
  };
  perZone(additions, 'add', 'to', true);
  perZone(cuts, 'cut', 'from', true);
  perZone(movesTo, 'move', 'to', false);

  if (diff.primer.status === 'changed') clauses.push(['update primer']);
  if (diff.primer.status === 'captured') clauses.push(['capture primer']);
  for (const change of diff.deck) clauses.push([DECK_INFO_CLAUSES[change.field]]);

  if (clauses.length === 0) {
    if (diff.stats.printingChanges > 0) clauses.push(['change printings']);
    if (diff.stats.tagChanges > 0) clauses.push(['update card tags']);
    if (diff.changes.some((change) => change.type === 'renamed')) clauses.push(['update card names']);
  }
  return clauses;
}

function formatNames(names: readonly string[], limit: number): string {
  const shown = names.slice(0, limit).join(', ');
  const rest = names.length - limit;
  return rest > 0 ? `${shown} +${rest} more` : shown;
}

function renderMessage(clauses: readonly Clause[], limit: number): string {
  const text = clauses
    .map((parts) =>
      parts.map((part) => (typeof part === 'string' ? part : formatNames(part, limit))).join(''),
    )
    .join('; ');
  return upperFirst(text);
}
