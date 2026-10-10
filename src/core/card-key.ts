import type { CardKey } from './model';

/**
 * Derives the strategic identity key for a card from its English oracle name.
 *
 * Two names that refer to the same card produce the same key regardless of
 * capitalization, Unicode composition, curly vs. straight quotes, or spacing around
 * the `//` separator of split and double-faced cards. Diacritics are preserved
 * because they are part of official card names.
 */
export function cardKey(name: string): CardKey {
  // Lowercasing can reorder combining marks out of NFC in rare sequences; re-normalize
  // so keys are always NFC.
  return normalizeCardName(name).toLowerCase().normalize('NFC');
}

/** Normalizes a display name with the same rules as {@link cardKey}, keeping case. */
export function normalizeCardName(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'") // ‘ ’ ‛ ′
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"') // “ ” ‟ ″
    .replace(/\s*\/\/+\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();
}
