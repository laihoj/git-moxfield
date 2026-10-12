/**
 * Deck zones (Moxfield calls them "boards").
 *
 * Zone ids are platform-neutral and normalized: Moxfield's `maybeboard` becomes
 * `considering` (the name Moxfield's UI uses). Zones that git-moxfield does not
 * know about are preserved as `other:<slug>` instead of being dropped.
 */

import { upperFirst } from './text';

/** Canonical zone order. Serialization, diffs and UI all follow this order. */
export const KNOWN_ZONES = [
  'commanders',
  'companions',
  'signatureSpells',
  'mainboard',
  'sideboard',
  'considering',
  'attractions',
  'stickers',
  'contraptions',
  'planes',
  'schemes',
  'tokens',
] as const;

export type KnownZone = (typeof KNOWN_ZONES)[number];

/** A zone that the source platform exposes but git-moxfield has no special knowledge of. */
export type OtherZone = `other:${string}`;

export type ZoneId = KnownZone | OtherZone;

const KNOWN_ZONE_SET: ReadonlySet<string> = new Set(KNOWN_ZONES);

const ZONE_LABELS: Record<KnownZone, string> = {
  commanders: 'Commanders',
  companions: 'Companion',
  signatureSpells: 'Signature spells',
  mainboard: 'Mainboard',
  sideboard: 'Sideboard',
  considering: 'Considering',
  attractions: 'Attractions',
  stickers: 'Stickers',
  contraptions: 'Contraptions',
  planes: 'Planes',
  schemes: 'Schemes',
  tokens: 'Tokens',
};

/** The command zone: set with deck-page actions rather than listed, and shown flat (few cards). */
const COMMAND_ZONES = ['commanders', 'companions', 'signatureSpells'] as const satisfies readonly KnownZone[];

/** True for the zones of the command zone (see {@link COMMAND_ZONES}). */
export function isCommandZone(zone: ZoneId): boolean {
  return (COMMAND_ZONES as readonly ZoneId[]).includes(zone);
}

/**
 * Zones whose cards are part of the playable deck. Sideboard and considering are
 * "tracked but not played" zones; they act as the user's record of explored cards.
 */
const PLAYED_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>([...COMMAND_ZONES, 'mainboard']);

export function isKnownZone(zone: string): zone is KnownZone {
  return KNOWN_ZONE_SET.has(zone);
}

/**
 * True for known zones and for well-formed `other:` zones: a slug of lowercase ASCII
 * letters and digits in hyphen-separated words, exactly the shape {@link otherZone}
 * produces (so `otherZone(slug)` round-trips every valid slug).
 */
export function isZoneId(zone: string): zone is ZoneId {
  return isKnownZone(zone) || /^other:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(zone);
}

/**
 * Builds an `other:` zone id from an arbitrary source board name: diacritics removed,
 * camelCase split into words, lowercased, every run of other characters collapsed to
 * one hyphen. Falls back to `other:unnamed` when nothing usable remains.
 */
export function otherZone(sourceBoardName: string): OtherZone {
  const slug = sourceBoardName
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `other:${slug || 'unnamed'}`;
}

/** Human label: the fixed label of a known zone, or the sentence-cased words of an `other:` slug. */
export function zoneLabel(zone: ZoneId): string {
  if (isKnownZone(zone)) return ZONE_LABELS[zone];
  const slug = zone.slice('other:'.length);
  return upperFirst(slug.split('-').filter(Boolean).join(' '));
}

/** True for zones whose cards are part of the playable deck (commanders, companions, signature spells, mainboard). */
export function isPlayedZone(zone: ZoneId): boolean {
  return PLAYED_ZONES.has(zone);
}

/** Total order over zone ids: known zones in canonical order, then `other:` zones alphabetically. */
export function compareZones(a: ZoneId, b: ZoneId): number {
  const ia = isKnownZone(a) ? KNOWN_ZONES.indexOf(a) : Number.POSITIVE_INFINITY;
  const ib = isKnownZone(b) ? KNOWN_ZONES.indexOf(b) : Number.POSITIVE_INFINITY;
  if (ia !== ib) return ia < ib ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Returns a new array of the zones in canonical order (see {@link compareZones}). */
export function sortZones<T extends ZoneId>(zones: Iterable<T>): T[] {
  return [...zones].sort(compareZones);
}

/** The entries of a zone-keyed map as a new array in canonical zone order (see {@link compareZones}). */
export function zoneEntries<V>(map: ReadonlyMap<ZoneId, V>): [ZoneId, V][] {
  return [...map].sort(([a], [b]) => compareZones(a, b));
}
