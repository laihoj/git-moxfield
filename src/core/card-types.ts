/**
 * The card type groups a deck list is split into (Moxfield's groups) and the order in
 * which a card's type line is classified. The adapter stores the group of a card as its
 * `primary_type` (`CardFacts.primaryType`); the deck list groups by it, so both ends
 * share this vocabulary. The two orders differ on purpose: precedence decides which
 * type wins for a card with several (`Artifact Land` is a Land), display order is the
 * order of the groups on a page (Land last).
 */

/** The groups in display order. Cards of any other primary type go to `Other`. */
export const CARD_TYPE_GROUPS = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
  'Land',
] as const;

export type CardTypeGroup = (typeof CARD_TYPE_GROUPS)[number];

/**
 * Card types in grouping precedence: a card is grouped under the first type in this list
 * that appears on its (front face) type line. Creature wins over everything, so
 * `Artifact Creature` and `Land Creature` (Dryad Arbor) are creatures; Land wins over
 * Artifact, so artifact lands count as lands; Artifact wins over Enchantment for the
 * rare `Enchantment Artifact`.
 */
export const PRIMARY_TYPE_PRECEDENCE = [
  'Creature',
  'Planeswalker',
  'Battle',
  'Land',
  'Instant',
  'Sorcery',
  'Artifact',
  'Enchantment',
] as const satisfies readonly CardTypeGroup[];

/** Group headings. */
export const CARD_TYPE_GROUP_PLURALS: Record<CardTypeGroup | 'Other', string> = {
  Creature: 'Creatures',
  Planeswalker: 'Planeswalkers',
  Battle: 'Battles',
  Instant: 'Instants',
  Sorcery: 'Sorceries',
  Artifact: 'Artifacts',
  Enchantment: 'Enchantments',
  Land: 'Lands',
  Other: 'Other',
};

/** The group a stored primary type belongs to: itself when it is one of the groups, else `Other`. */
export function cardTypeGroup(primaryType: string): CardTypeGroup | 'Other' {
  return CARD_TYPE_GROUPS.find((group) => group === primaryType) ?? 'Other';
}
