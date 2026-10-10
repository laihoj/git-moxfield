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
import type { MoxCardSpec, MoxDeckSpec } from '../support/moxfield-deck-builder';

/** Public id (as in `/decks/{publicId}`) of the seeded Blue Farm deck. */
export const BLUE_FARM_PUBLIC_ID = 'MockBlueFarm0000000001';

/** Public id of the seeded second, small deck. */
export const SECOND_DECK_PUBLIC_ID = 'MockSecondDeck00000002';

/** Moxfield revision of the seeded Blue Farm deck. */
export const BLUE_FARM_VERSION = 100;

const SEEDED_AT = '2026-10-01T12:00:00.000Z';

/** `[name, type line, mana cost, quantity?]`. */
type CardRow = readonly [name: string, typeLine: string, manaCost: string, quantity?: number];

function cards(rows: readonly CardRow[]): MoxCardSpec[] {
  return rows.map(([name, typeLine, manaCost, quantity]) =>
    quantity === undefined ? { name, typeLine, manaCost } : { name, typeLine, manaCost, quantity },
  );
}

const BLUE_FARM_COMMANDERS: MoxCardSpec[] = [
  {
    name: 'Tymna the Weaver',
    typeLine: 'Legendary Creature — Human Cleric',
    manaCost: '{1}{W}{B}',
    set: 'c16',
    collectorNumber: '48',
    finish: 'foil',
  },
  {
    name: "Kraum, Ludevic's Opus",
    typeLine: 'Legendary Creature — Zombie Horror',
    manaCost: '{3}{U}{R}',
    set: 'c16',
    collectorNumber: '28',
  },
];

const BLUE_FARM_LANDS: readonly CardRow[] = [
  ['Command Tower', 'Land', ''],
  ['Island', 'Basic Land — Island', '', 2],
  ['Swamp', 'Basic Land — Swamp', ''],
  ['Plains', 'Basic Land — Plains', ''],
  ['Mountain', 'Basic Land — Mountain', ''],
  ['Polluted Delta', 'Land', ''],
  ['Flooded Strand', 'Land', ''],
  ['Scalding Tarn', 'Land', ''],
  ['Bloodstained Mire', 'Land', ''],
  ['Marsh Flats', 'Land', ''],
  ['Arid Mesa', 'Land', ''],
  ['Misty Rainforest', 'Land', ''],
  ['Underground Sea', 'Land — Island Swamp', ''],
  ['Volcanic Island', 'Land — Island Mountain', ''],
  ['Tundra', 'Land — Plains Island', ''],
  ['Badlands', 'Land — Swamp Mountain', ''],
  ['Scrubland', 'Land — Plains Swamp', ''],
  ['Plateau', 'Land — Mountain Plains', ''],
  ['Watery Grave', 'Land — Island Swamp', ''],
  ['Steam Vents', 'Land — Island Mountain', ''],
  ['Hallowed Fountain', 'Land — Plains Island', ''],
  ['Godless Shrine', 'Land — Plains Swamp', ''],
  ['Ancient Tomb', 'Land', ''],
  ['City of Brass', 'Land', ''],
  ['Mana Confluence', 'Land', ''],
  ['Exotic Orchard', 'Land', ''],
];

const BLUE_FARM_MANA: readonly CardRow[] = [
  ['Sol Ring', 'Artifact', '{1}'],
  ['Mana Vault', 'Artifact', '{1}'],
  ['Mana Crypt', 'Artifact', '{0}'],
  ['Chrome Mox', 'Artifact', '{0}'],
  ['Mox Diamond', 'Artifact', '{0}'],
  ['Mox Opal', 'Legendary Artifact', '{0}'],
  ['Lotus Petal', 'Artifact', '{0}'],
  ['Jeweled Lotus', 'Artifact', '{0}'],
  ['Arcane Signet', 'Artifact', '{2}'],
  ['Talisman of Dominance', 'Artifact', '{2}'],
  ['Fellwar Stone', 'Artifact', '{2}'],
  ['Grim Monolith', 'Artifact', '{2}'],
  ["Lion's Eye Diamond", 'Artifact', '{0}'],
  ['Dark Ritual', 'Instant', '{B}'],
  ['Cabal Ritual', 'Instant', '{1}{B}'],
  ['Rite of Flame', 'Sorcery', '{R}'],
  ['Simian Spirit Guide', 'Creature — Ape Spirit', '{2}{R}'],
];

const BLUE_FARM_TUTORS: readonly CardRow[] = [
  ['Demonic Tutor', 'Sorcery', '{1}{B}'],
  ['Vampiric Tutor', 'Instant', '{B}'],
  ['Imperial Seal', 'Sorcery', '{B}'],
  ['Mystical Tutor', 'Instant', '{U}'],
  ['Enlightened Tutor', 'Instant', '{W}'],
  ['Gamble', 'Sorcery', '{R}'],
  ['Grim Tutor', 'Sorcery', '{1}{B}{B}'],
  ['Wishclaw Talisman', 'Artifact', '{1}{B}'],
  ['Tainted Pact', 'Instant', '{1}{B}'],
];

const BLUE_FARM_COMBO: readonly CardRow[] = [
  ["Thassa's Oracle", 'Creature — Merfolk Wizard', '{U}{U}'],
  ['Underworld Breach', 'Enchantment', '{1}{R}'],
  ['Brain Freeze', 'Instant', '{1}{U}'],
  ['Demonic Consultation', 'Instant', '{B}'],
  ['Ad Nauseam', 'Instant', '{3}{B}{B}'],
  ['Necropotence', 'Enchantment', '{B}{B}{B}'],
  ['Dramatic Reversal', 'Instant', '{1}{U}'],
  ['Isochron Scepter', 'Artifact', '{2}'],
  ['Timetwister', 'Sorcery', '{2}{U}'],
  ['Windfall', 'Sorcery', '{2}{U}'],
  ['Wheel of Fortune', 'Sorcery', '{2}{R}'],
  ['Notion Thief', 'Creature — Human Rogue', '{2}{U}{B}'],
];

const BLUE_FARM_STAX: readonly CardRow[] = [
  ['Dress Down', 'Enchantment', '{1}{U}'],
  ['Drannith Magistrate', 'Creature — Human Wizard', '{1}{W}'],
  ['Grand Abolisher', 'Creature — Human Cleric', '{W}{W}'],
  ['Silence', 'Instant', '{W}'],
  ["Orim's Chant", 'Instant', '{W}'],
  ['Opposition Agent', 'Creature — Human Rogue', '{2}{B}'],
  ['Deafening Silence', 'Enchantment', '{W}'],
];

const BLUE_FARM_INTERACTION: readonly CardRow[] = [
  ['Force of Will', 'Instant', '{3}{U}{U}'],
  ['Force of Negation', 'Instant', '{1}{U}{U}'],
  ['Pact of Negation', 'Instant', '{0}'],
  ['Mental Misstep', 'Instant', '{U/P}'],
  ['Flusterstorm', 'Instant', '{U}'],
  ['Mindbreak Trap', 'Instant — Trap', '{2}{U}{U}'],
  ['Swords to Plowshares', 'Instant', '{W}'],
  ['Fierce Guardianship', 'Instant', '{2}{U}'],
  ['Deflecting Swat', 'Instant', '{2}{R}'],
  ['Red Elemental Blast', 'Instant', '{R}'],
  ['Pyroblast', 'Instant', '{R}'],
  ["An Offer You Can't Refuse", 'Instant', '{U}'],
  ['Snapback', 'Instant', '{1}{U}'],
  ['Stern Scolding', 'Instant', '{U}'],
  ['Swan Song', 'Instant', '{U}'],
  ['Mana Drain', 'Instant', '{U}{U}'],
  ['Orcish Bowmasters', 'Creature — Orc Archer', '{1}{B}'],
];

const BLUE_FARM_DRAW: readonly CardRow[] = [
  ['Rhystic Study', 'Enchantment', '{2}{U}'],
  ['Mystic Remora', 'Enchantment', '{U}'],
  ['Esper Sentinel', 'Artifact Creature — Human Soldier', '{W}'],
  ['Gitaxian Probe', 'Sorcery', '{U/P}'],
  ['Gush', 'Instant', '{4}{U}'],
  ['Brainstorm', 'Instant', '{U}'],
  ['Ponder', 'Sorcery', '{U}'],
  ['Preordain', 'Sorcery', '{U}'],
  ['Faerie Mastermind', 'Creature — Faerie Rogue', '{1}{U}'],
];

const BLUE_FARM_CONSIDERING: readonly CardRow[] = [
  ['Mnemonic Betrayal', 'Sorcery', '{1}{U}{B}'],
  ['Peer into the Abyss', 'Sorcery', '{4}{B}{B}{B}'],
  ['Beseech the Mirror', 'Sorcery', '{1}{B}{B}{B}'],
  ['Final Fortune', 'Instant', '{R}{R}'],
  ['Snuff Out', 'Instant', '{3}{B}'],
  ['Borne Upon a Wind', 'Instant', '{1}{U}'],
  ["Praetor's Grasp", 'Sorcery', '{1}{B}{B}'],
  ['Culling the Weak', 'Instant', '{B}'],
  ['Spellseeker', 'Creature — Human Wizard', '{2}{U}'],
  ['Silent Clearing', 'Land', ''],
  ['Talion, the Kindly Lord', 'Legendary Creature — Faerie Noble', '{2}{U}{U}'],
  ['Archivist of Oghma', 'Creature — Human Cleric', '{1}{W}'],
];

const BLUE_FARM_SIDEBOARD: readonly CardRow[] = [
  ["Tormod's Crypt", 'Artifact', '{0}'],
  ['Null Rod', 'Artifact', '{2}'],
];

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
    commanders: [
      { name: 'Tana, the Bloodsower', typeLine: 'Legendary Creature — Elf Druid', manaCost: '{2}{R}{G}' },
    ],
    mainboard: cards([
      ['Forest', 'Basic Land — Forest', '', 4],
      ['Mountain', 'Basic Land — Mountain', '', 3],
      ['Command Tower', 'Land', ''],
      ['Sol Ring', 'Artifact', '{1}'],
      ['Arcane Signet', 'Artifact', '{2}'],
      ['Beast Within', 'Instant', '{2}{G}'],
      ['Craterhoof Behemoth', 'Creature — Beast', '{5}{G}{G}{G}'],
    ]),
    hubs: ['Tokens'],
    primer: '',
  };
}

/** Every seeded deck, freshly built. */
export function seedScenarios(): MoxDeckSpec[] {
  return [blueFarmDeck(), secondDeck()];
}
