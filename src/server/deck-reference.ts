/**
 * Decks as the operator names them on the command line (`pnpm export:git`, `pnpm
 * import:local`): by git-moxfield deck id, Moxfield public deck id or Moxfield deck URL,
 * on the configured Moxfield site or the default one.
 */
import type { DeckRef } from '@/integrations/deck-source';
import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';
import { parseMoxfieldDeckInput } from '@/integrations/moxfield/url';

import type { AppConfig } from './config';

/** The Moxfield site origins an operator's deck URL may point to. */
export function operatorSiteOrigins(config: Pick<AppConfig, 'moxfieldSiteOrigin'>): string[] {
  return [...new Set([config.moxfieldSiteOrigin, DEFAULT_MOXFIELD_SITE_ORIGIN])];
}

/** What a typed deck reference can name. */
export interface DeckReference {
  /** The trimmed input, which may be a git-moxfield deck id. */
  id: string;
  /** The Moxfield deck the input names (a public id or a URL on one of the origins), if it does. */
  moxfield: DeckRef | null;
}

/**
 * Reads what an operator typed. `null` for blank input. The Moxfield deck is the same
 * whichever origin parses the input, so the first that does decides.
 */
export function parseDeckReference(input: string, siteOrigins: readonly string[]): DeckReference | null {
  const id = input.trim();
  if (id === '') return null;
  for (const origin of siteOrigins) {
    const parsed = parseMoxfieldDeckInput(id, origin);
    if (parsed.ok) return { id, moxfield: parsed.ref };
  }
  return { id, moxfield: null };
}

/** `“Blue Farm” (moxfield:AbCdEf…)`, for naming a deck in messages. */
export function describeDeckRef(deck: { name: string; source: string; externalId: string }): string {
  return `“${deck.name}” (${deck.source}:${deck.externalId})`;
}
