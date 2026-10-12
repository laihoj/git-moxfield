/**
 * Decks the mock Moxfield server starts with (and returns to on `POST /__control/reset`).
 *
 * `Blue Farm` is a realistic Tymna + Kraum cEDH list: 100 cards (2 commanders and 98 in
 * the mainboard), 12 cards being considered, a small sideboard, author tags and a primer
 * that uses Moxfield's primer directives. Every card carries its type line and mana cost
 * so the UI groups cards like Moxfield does. The second deck is small and has no primer.
 *
 * Builders return fresh objects on every call, so callers may modify them.
 */
import { cardWithFacts } from '../support/card-facts';
import type { MoxCardSpec, MoxDeckSpec } from '../support/moxfield-deck-builder';

/** Public id (as in `/decks/{publicId}`) of the seeded Blue Farm deck. */
export const BLUE_FARM_PUBLIC_ID = 'MockBlueFarm0000000001';

/** Public id of the seeded second, small deck. */
export const SECOND_DECK_PUBLIC_ID = 'MockSecondDeck00000002';

/** Moxfield revision of the seeded Blue Farm deck. */
export const BLUE_FARM_VERSION = 100;

const SEEDED_AT = '2026-10-01T12:00:00.000Z';

/** A card by name, or `[name, quantity]`; its type line and mana cost come from the shared table. */
type CardRow = string | readonly [name: string, quantity: number];

function cards(rows: readonly CardRow[]): MoxCardSpec[] {
  return rows.map((row) =>
    typeof row === 'string' ? cardWithFacts(row) : cardWithFacts(row[0], { quantity: row[1] }),
  );
}

const BLUE_FARM_COMMANDERS: MoxCardSpec[] = [
  cardWithFacts('Tymna the Weaver', { set: 'c16', collectorNumber: '48', finish: 'foil' as const }),
  cardWithFacts("Kraum, Ludevic's Opus", { set: 'c16', collectorNumber: '28' }),
];

const BLUE_FARM_LANDS: readonly CardRow[] = [
  'Command Tower',
  ['Island', 2],
  'Swamp',
  'Plains',
  'Mountain',
  'Polluted Delta',
  'Flooded Strand',
  'Scalding Tarn',
  'Bloodstained Mire',
  'Marsh Flats',
  'Arid Mesa',
  'Misty Rainforest',
  'Underground Sea',
  'Volcanic Island',
  'Tundra',
  'Badlands',
  'Scrubland',
  'Plateau',
  'Watery Grave',
  'Steam Vents',
  'Hallowed Fountain',
  'Godless Shrine',
  'Ancient Tomb',
  'City of Brass',
  'Mana Confluence',
  'Exotic Orchard',
];

const BLUE_FARM_MANA: readonly CardRow[] = [
  'Sol Ring',
  'Mana Vault',
  'Mana Crypt',
  'Chrome Mox',
  'Mox Diamond',
  'Mox Opal',
  'Lotus Petal',
  'Jeweled Lotus',
  'Arcane Signet',
  'Talisman of Dominance',
  'Fellwar Stone',
  'Grim Monolith',
  "Lion's Eye Diamond",
  'Dark Ritual',
  'Cabal Ritual',
  'Rite of Flame',
  'Simian Spirit Guide',
];

const BLUE_FARM_TUTORS: readonly CardRow[] = [
  'Demonic Tutor',
  'Vampiric Tutor',
  'Imperial Seal',
  'Mystical Tutor',
  'Enlightened Tutor',
  'Gamble',
  'Grim Tutor',
  'Wishclaw Talisman',
  'Tainted Pact',
];

const BLUE_FARM_COMBO: readonly CardRow[] = [
  "Thassa's Oracle",
  'Underworld Breach',
  'Brain Freeze',
  'Demonic Consultation',
  'Ad Nauseam',
  'Necropotence',
  'Dramatic Reversal',
  'Isochron Scepter',
  'Timetwister',
  'Windfall',
  'Wheel of Fortune',
  'Notion Thief',
];

const BLUE_FARM_STAX: readonly CardRow[] = [
  'Dress Down',
  'Drannith Magistrate',
  'Grand Abolisher',
  'Silence',
  "Orim's Chant",
  'Opposition Agent',
  'Deafening Silence',
];

const BLUE_FARM_INTERACTION: readonly CardRow[] = [
  'Force of Will',
  'Force of Negation',
  'Pact of Negation',
  'Mental Misstep',
  'Flusterstorm',
  'Mindbreak Trap',
  'Swords to Plowshares',
  'Fierce Guardianship',
  'Deflecting Swat',
  'Red Elemental Blast',
  'Pyroblast',
  "An Offer You Can't Refuse",
  'Snapback',
  'Stern Scolding',
  'Swan Song',
  'Mana Drain',
  'Orcish Bowmasters',
];

const BLUE_FARM_DRAW: readonly CardRow[] = [
  'Rhystic Study',
  'Mystic Remora',
  'Esper Sentinel',
  'Gitaxian Probe',
  'Gush',
  'Brainstorm',
  'Ponder',
  'Preordain',
  'Faerie Mastermind',
];

const BLUE_FARM_CONSIDERING: readonly CardRow[] = [
  'Mnemonic Betrayal',
  'Peer into the Abyss',
  'Beseech the Mirror',
  'Final Fortune',
  'Snuff Out',
  'Borne Upon a Wind',
  "Praetor's Grasp",
  'Culling the Weak',
  'Spellseeker',
  'Silent Clearing',
  'Talion, the Kindly Lord',
  'Archivist of Oghma',
];

const BLUE_FARM_SIDEBOARD: readonly CardRow[] = ["Tormod's Crypt", 'Null Rod'];

const BLUE_FARM_PRIMER = `===center
# Blue Farm
*Tymna the Weaver + Kraum, Ludevic's Opus*
===endcenter

Blue Farm is a turbo-leaning midrange deck: it draws cards off [[Tymna the Weaver]] and
[[Kraum, Ludevic's Opus]], protects its engines with free interaction and wins with a
compact combo package as soon as the table is tapped out.

## Win conditions

===accordion
===panel: Thassa's Oracle + Demonic Consultation
Cast [[Demonic Consultation]] or [[Tainted Pact]] to exile the library, then resolve
[[Thassa's Oracle]]. Protect the Oracle trigger with [[Silence]] or [[Grand Abolisher]].
===endpanel
===panel: Underworld Breach + Brain Freeze
With [[Lion's Eye Diamond]] in play, [[Underworld Breach]] loops [[Brain Freeze]] until
every library is empty.
===endpanel
===panel: Ad Nauseam
[[Ad Nauseam]] at the end of the turn before ours draws into the combo with a full grip.
===endpanel
===endaccordion

## Mulligans

- Keep hands with fast mana and a way to find the combo.
- Ship hands without blue sources or without any interaction.
- [[Rhystic Study]] and [[Mystic Remora]] are keepable engines in slower pods.

## Flex slots

| Card | Why |
| --- | --- |
| [[Dress Down]] | Turns off opposing [[Orcish Bowmasters]] and creature combos. |
| [[Mnemonic Betrayal]] | Being tested in Considering as an alternative to [[Necropotence]]. |
`;

/** The seeded Blue Farm deck (Moxfield version {@link BLUE_FARM_VERSION}). */
export function blueFarmDeck(): MoxDeckSpec {
  return {
    publicId: BLUE_FARM_PUBLIC_ID,
    name: 'Blue Farm',
    description: 'Tymna + Kraum turbo midrange for cEDH. Thoracle and Breach lines.',
    format: 'commander',
    version: BLUE_FARM_VERSION,
    lastUpdatedAtUtc: SEEDED_AT,
    commanders: structuredClone(BLUE_FARM_COMMANDERS),
    mainboard: cards([
      ...BLUE_FARM_LANDS,
      ...BLUE_FARM_MANA,
      ...BLUE_FARM_TUTORS,
      ...BLUE_FARM_COMBO,
      ...BLUE_FARM_STAX,
      ...BLUE_FARM_INTERACTION,
      ...BLUE_FARM_DRAW,
    ]),
    considering: cards(BLUE_FARM_CONSIDERING),
    sideboard: cards(BLUE_FARM_SIDEBOARD),
    hubs: ['cEDH', 'Turbo'],
    authorTags: {
      "Thassa's Oracle": ['win-con'],
      'Underworld Breach': ['win-con'],
      'Demonic Consultation': ['win-con'],
      'Dress Down': ['stax'],
      'Drannith Magistrate': ['stax'],
    },
    primer: BLUE_FARM_PRIMER,
  };
}

/** A small second deck without a primer. */
export function secondDeck(): MoxDeckSpec {
  return {
    publicId: SECOND_DECK_PUBLIC_ID,
    name: 'Tana Tokens',
    description: 'A casual Gruul tokens list.',
    format: 'commander',
    version: 7,
    lastUpdatedAtUtc: '2026-09-15T08:30:00.000Z',
    commanders: [cardWithFacts('Tana, the Bloodsower')],
    mainboard: cards([
      ['Forest', 4],
      ['Mountain', 3],
      'Command Tower',
      'Sol Ring',
      'Arcane Signet',
      'Beast Within',
      'Craterhoof Behemoth',
    ]),
    hubs: ['Tokens'],
    primer: '',
  };
}

/** Every seeded deck, freshly built. */
export function seedScenarios(): MoxDeckSpec[] {
  return [blueFarmDeck(), secondDeck()];
}
