/**
 * Restore export: text the user pastes into Moxfield to make a deck match a version.
 *
 * git-moxfield never writes to Moxfield. Restoring means pasting into Moxfield's Bulk
 * Edit dialog, which has one textarea per board (Main Deck, Sideboard, Considering,
 * Other › …) and replaces each board's contents with its textarea text on save.
 * Commanders, companions and signature spells are not in Bulk Edit; they are set via
 * dedicated deck-page actions, so their sections are listed for reference.
 *
 * Line format accepted by Moxfield: `<qty> <Card Name> (<SET>) <collectorNumber>`
 * followed by ` *F*` for foil or ` *E*` for etched. Tags (`#tag` deck tags, `#!tag`
 * global tags) are never emitted because Moxfield's JSON cannot tell them apart.
 */
import { snapshotZones, zoneCards, zoneCount } from '@/core/canonical';
import type { CanonicalCard, CanonicalPrinting, CanonicalSnapshot } from '@/core/model';
import { isKnownZone, sortZones, zoneLabel, type KnownZone, type ZoneId } from '@/core/zones';

import type { RestoreExport, RestoreSection, RestoreTarget } from '../deck-source';

import { MOXFIELD_SOURCE_ID } from './constants';

/** Bulk Edit tab per zone; zones without a tab cannot be restored by pasting. */
const BULK_EDIT_TABS: Partial<Record<KnownZone, string>> = {
  mainboard: 'Main Deck',
  sideboard: 'Sideboard',
  considering: 'Considering',
  attractions: 'Other › Attraction Deck',
  contraptions: 'Other › Contraption Deck',
  stickers: 'Other › Sticker Sheets',
  planes: 'Other › Planar Deck',
  schemes: 'Other › Schemes',
};

/** Zones whose deck-page action restores them (they are not part of Bulk Edit). */
const DECK_PAGE_TARGETS: Partial<Record<KnownZone, string>> = {
  commanders: 'Deck page › More › Change Commander / Add Partner',
  companions: 'Card menu › Set as Companion (the card must be in the Sideboard)',
  signatureSpells: 'Deck page › More › Change Signature Spell',
};

/**
 * Zones always exported, even when empty: saving Bulk Edit replaces these boards, so an
 * empty section tells the user to clear the tab rather than leave stale cards in it.
 */
const ALWAYS_EXPORTED: readonly ZoneId[] = ['mainboard', 'sideboard', 'considering'];

const STANDARD_FINISHES: ReadonlySet<string> = new Set(['nonfoil', 'foil', 'etched']);

/**
 * Applies the character substitutions Moxfield's own import performs, so pasted names
 * match: curly quotes → straight quotes, en/em dashes → `-`, `…` → `...`, `Æ` → `Ae`.
 */
export function moxfieldAsciiName(name: string): string {
  return name
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/Æ/g, 'Ae');
}

function finishMarker(finish: string): string {
  if (finish === 'foil') return ' *F*';
  if (finish === 'etched') return ' *E*';
  return '';
}

/** Import lines of one card: one per printing, or `<qty> <Name>` without printings. */
export function moxfieldCardLines(card: Pick<CanonicalCard, 'name' | 'quantity' | 'printings'>): string[] {
  const name = moxfieldAsciiName(card.name);
  if (card.printings.length === 0) return [`${card.quantity} ${name}`];
  return card.printings.map(
    (p) => `${p.quantity} ${name} (${p.set.toUpperCase()}) ${p.collectorNumber}${finishMarker(p.finish)}`,
  );
}

function zoneText(snapshot: CanonicalSnapshot, zone: ZoneId): string {
  const lines = zoneCards(snapshot, zone).flatMap(moxfieldCardLines);
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function bulkEditTab(zone: ZoneId): string | undefined {
  return isKnownZone(zone) ? BULK_EDIT_TABS[zone] : undefined;
}

function deckPageTarget(zone: ZoneId): string | undefined {
  return isKnownZone(zone) ? DECK_PAGE_TARGETS[zone] : undefined;
}

function sectionTarget(zone: ZoneId, empty: boolean): string {
  const deckPage = deckPageTarget(zone);
  if (deckPage !== undefined) return deckPage;
  const tab = bulkEditTab(zone);
  if (tab !== undefined) {
    return empty
      ? `Bulk Edit › ${tab} (clear the tab: this version has no cards there)`
      : `Bulk Edit › ${tab}`;
  }
  if (zone === 'tokens') {
    return 'Not restorable via Bulk Edit (the Tokens tab cannot be edited); listed for reference';
  }
  return 'Not restorable via Bulk Edit (Moxfield has no Bulk Edit tab for this board); listed for reference';
}

function buildSections(snapshot: CanonicalSnapshot): RestoreSection[] {
  const zones = sortZones(new Set<ZoneId>([...snapshotZones(snapshot), ...ALWAYS_EXPORTED]));
  return zones.map((zone) => {
    const cardCount = zoneCount(snapshot, zone);
    return {
      zone,
      label: zoneLabel(zone),
      target: sectionTarget(zone, cardCount === 0),
      text: zoneText(snapshot, zone),
      cardCount,
    };
  });
}

/** `a`, `a and b`, `a, b and c`. */
function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

/** Card names, quoted (names may contain commas) and deduplicated, as a list. */
function cardList(cards: readonly Pick<CanonicalCard, 'name'>[]): string {
  return listText([...new Set(cards.map((card) => card.name))].map((name) => `"${name}"`));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The first step: open the deck to restore into, freshly loaded. */
const OPEN_DECK_STEP: Record<RestoreTarget, string> = {
  'source-deck': 'Open the deck on Moxfield and reload the page, so you edit its latest state.',
  'own-deck':
    'Open a deck of your own on Moxfield (or create one) and reload its page, so you edit its latest state.',
};

function buildInstructions(
  snapshot: CanonicalSnapshot,
  sections: readonly RestoreSection[],
  target: RestoreTarget,
): string[] {
  const steps = [OPEN_DECK_STEP[target]];

  const commanders = zoneCards(snapshot, 'commanders');
  if (commanders.length > 0) {
    const partner = commanders.length > 1 ? ' (use Add Partner for the second one)' : '';
    steps.push(
      `Set the commanders first: Deck page › More › Change Commander${partner}: ${cardList(commanders)}.`,
    );
  }
  if (zoneCount(snapshot, 'signatureSpells') > 0) {
    steps.push(
      `Set the signature spells: Deck page › More › Change Signature Spell: ${cardList(zoneCards(snapshot, 'signatureSpells'))}.`,
    );
  }

  steps.push('Open Bulk Edit on the deck page.');
  const listedTabs = new Set<string>();
  for (const section of sections) {
    const tab = bulkEditTab(section.zone);
    if (tab === undefined) continue;
    listedTabs.add(tab);
    steps.push(
      section.cardCount > 0
        ? `In the "${tab}" tab, select all text and replace it with the ${section.label} section (${plural(section.cardCount, 'card')}).`
        : `In the "${tab}" tab, select all text and delete it: this version has no ${section.label} cards.`,
    );
  }
  const otherTabs = Object.values(BULK_EDIT_TABS).filter((tab) => !listedTabs.has(tab));
  if (otherTabs.length > 0) {
    steps.push(
      `If any other Bulk Edit tab (${listText(otherTabs)}) contains cards, clear it too: this version has none there.`,
    );
  }
  steps.push('Click Save once, after all tabs are filled in.');
  steps.push(
    'If Moxfield reports "Error on line N", fix or remove that line in the tab it names and save again.',
  );

  if (zoneCount(snapshot, 'companions') > 0) {
    steps.push(
      `Set the companion: make sure ${cardList(zoneCards(snapshot, 'companions'))} is in the Sideboard, then use its card menu › Set as Companion.`,
    );
  }
  if (snapshot.primer !== null) {
    steps.push(
      snapshot.primer === ''
        ? `This version has no primer: if the deck has one now, clear it (${PRIMER_TARGET}).`
        : `Restore the primer: ${PRIMER_TARGET}, select all text, paste the Primer block and save.`,
    );
  }
  steps.push(
    'Compare the deck name, format, description and hubs with this version and edit them by hand if they differ.',
  );
  const counts = sections
    .filter((section) => section.cardCount > 0 || ALWAYS_EXPORTED.includes(section.zone))
    .map((section) => `${section.label} ${section.cardCount}`);
  steps.push(`Check the card counts on the deck page: ${counts.join(', ')}.`);
  return steps;
}

function allPrintings(snapshot: CanonicalSnapshot): { card: CanonicalCard; printing: CanonicalPrinting }[] {
  return snapshotZones(snapshot).flatMap((zone) =>
    zoneCards(snapshot, zone).flatMap((card) => card.printings.map((printing) => ({ card, printing }))),
  );
}

function buildLimitations(snapshot: CanonicalSnapshot, hasCombined: boolean): string[] {
  const limitations: string[] = [];
  const printings = allPrintings(snapshot);
  const cards = snapshotZones(snapshot).flatMap((zone) => zoneCards(snapshot, zone));

  const deckFields = ['deck name', 'format'];
  if (snapshot.deck.tags.length > 0) deckFields.push('hubs');
  if (snapshot.deck.description !== '') deckFields.push('description');
  limitations.push(
    `The ${listText(deckFields)} are not part of the pasted text and must be restored by hand.`,
  );
  if (snapshot.primer === null) {
    limitations.push('The primer was not captured for this version, so it cannot be restored from here.');
  }

  if (hasCombined && zoneCount(snapshot, 'considering') > 0) {
    limitations.push(
      'The combined list for a new deck does not include Considering; add it afterwards via Bulk Edit › Considering.',
    );
  }

  const flagged = printings.filter(({ printing }) => (printing.flags ?? []).length > 0);
  if (flagged.length > 0) {
    limitations.push(
      `Alter and proxy markings cannot be expressed in import text; mark them again by hand: ${cardList(flagged.map(({ card }) => card))}.`,
    );
  }

  const foreign = printings.filter(({ printing }) => printing.lang !== 'en');
  if (foreign.length > 0) {
    limitations.push(
      `Non-English printings cannot be added via Bulk Edit; Moxfield adds these cards in English: ${cardList(foreign.map(({ card }) => card))}.`,
    );
  }

  const multiple = cards.filter((card) => card.printings.length > 1);
  if (multiple.length > 0) {
    limitations.push(
      `Several printings of one card (${cardList(multiple)}) need the "Allow multiple printings" deck preference; otherwise Moxfield keeps only one printing.`,
    );
  }

  const unusual = printings.filter(({ printing }) => !STANDARD_FINISHES.has(printing.finish));
  if (unusual.length > 0) {
    limitations.push(
      `Finishes other than foil and etched cannot be expressed; these printings are restored as non-foil: ${cardList(unusual.map(({ card }) => card))}.`,
    );
  }

  const unprinted = cards.filter((card) => card.printings.length === 0);
  if (unprinted.length > 0) {
    limitations.push(
      `No printing is recorded for ${cardList(unprinted)}, so Moxfield picks its default printing.`,
    );
  }

  const unrestorable = snapshotZones(snapshot).filter(
    (zone) => bulkEditTab(zone) === undefined && deckPageTarget(zone) === undefined,
  );
  if (unrestorable.length > 0) {
    limitations.push(
      `${listText(unrestorable.map(zoneLabel))} cannot be restored via Bulk Edit; those sections are for reference only.`,
    );
  }

  if (Object.keys(snapshot.cardTags).length > 0) {
    limitations.push(
      "Card tags are not restored: Moxfield's data does not tell deck tags (#tag) from global tags (#!tag). Add them again by hand if needed.",
    );
  }

  limitations.push(
    'Per-card overrides in Moxfield (custom mana cost, mana value, color identity or card type) are not part of the text and are not restored.',
  );
  return limitations;
}

/** Where a primer is edited on Moxfield (the deck page's Primer tab, `/decks/{id}/primer`). */
const PRIMER_TARGET = 'Deck page › Primer › Edit';

/**
 * Builds the Moxfield restore export for a snapshot. Pure and deterministic.
 *
 * Sections follow canonical zone order. Main Deck, Sideboard and Considering are always
 * present (empty text and `cardCount: 0` mean "clear this tab"), other zones only when
 * they have cards. `combined` is the Main Deck plus a `SIDEBOARD:` block for Moxfield's
 * "Create New Deck › Paste in List" form, or `null` when there is no mainboard.
 *
 * `target` only changes the first step: open the deck the snapshot was captured from
 * (`source-deck`, the default), or a deck of the reader's own (`own-deck`).
 */
export function moxfieldRestoreExport(
  snapshot: CanonicalSnapshot,
  target: RestoreTarget = 'source-deck',
): RestoreExport {
  const sections = buildSections(snapshot);
  const main = zoneText(snapshot, 'mainboard');
  const side = zoneText(snapshot, 'sideboard');
  const combined =
    main === ''
      ? null
      : {
          text: side === '' ? main : `${main}\nSIDEBOARD:\n${side}`,
          note: 'For Create New Deck › Paste in List: set the commanders in the form, uncheck "Override with preferred printings" to keep these printings, and add Considering via Bulk Edit afterwards.',
        };
  return {
    source: MOXFIELD_SOURCE_ID,
    sections,
    // The primer is kept verbatim in Moxfield's own markup, so pasting it into
    // Moxfield's primer editor reproduces it exactly (directives and [[Card]] links).
    primer: snapshot.primer === null ? null : { text: snapshot.primer, target: PRIMER_TARGET },
    combined,
    instructions: buildInstructions(snapshot, sections, target),
    limitations: buildLimitations(snapshot, combined !== null),
  };
}
