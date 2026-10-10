/**
 * Deterministic, human-readable file representation of a snapshot.
 *
 * This is the format a deck history is exported to when writing a real Git
 * repository (one commit per version). It is designed for readable `git diff`
 * output: one file per zone, one line per printing, stable ordering, no volatile data.
 *
 *   deck.yaml          deck info (double-quoted scalars, loadable as YAML 1.1 and 1.2)
 *   commanders.txt     "1 Tymna the Weaver (C16) 48 *F*"
 *   mainboard.txt
 *   sideboard.txt
 *   considering.txt
 *   <zone>.txt         other zones, e.g. other-contraptions.txt
 *   card-tags.txt      "Dress Down: hate, stax"
 *   primer.md          absent when the deck has no primer (or it was not captured)
 */
import { compareStrings, snapshotZones, zoneCards } from './canonical';
import type { CanonicalCard, CanonicalPrinting, CanonicalSnapshot } from './model';
import { isKnownZone, type ZoneId } from './zones';

/** Relative path → file contents (LF line endings, trailing newline). */
export type FileTree = Record<string, string>;

export interface FileTreeOptions {
  /**
   * primer.md content to use when the snapshot's primer was not captured (`null`), e.g.
   * the last captured primer in a history export, where an uncaptured primer must not
   * read as a deletion. deck.yaml still says `primer: unavailable`. Default: no
   * primer.md.
   */
  unknownPrimer?: string;
}

export function zoneFileName(zone: ZoneId): string {
  return isKnownZone(zone)
    ? `${zone.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}.txt`
    : `${zone.replace(':', '-')}.txt`;
}

function finishMarker(finish: string): string {
  if (finish === 'nonfoil') return '';
  if (finish === 'foil') return ' *F*';
  if (finish === 'etched') return ' *E*';
  return ` *${finish}*`;
}

/** One line per printing: `<qty> <name> (<SET>) <collector number>[ *F*][ [lang]][ {flags}]`. */
export function printingLine(card: Pick<CanonicalCard, 'name'>, p: CanonicalPrinting): string {
  let line = `${p.quantity} ${card.name} (${p.set.toUpperCase()}) ${p.collectorNumber}${finishMarker(p.finish)}`;
  if (p.lang !== 'en') line += ` [${p.lang}]`;
  if (p.flags && p.flags.length > 0) line += ` {${p.flags.join(',')}}`;
  return line;
}

export function cardLines(card: CanonicalCard): string[] {
  if (card.printings.length === 0) return [`${card.quantity} ${card.name}`];
  return card.printings.map((p) => printingLine(card, p));
}

/**
 * A YAML double-quoted scalar. JSON string syntax is valid YAML, but YAML readers reject
 * raw DEL and C1 controls and escaped lone surrogates, and YAML 1.1 readers fold NEL, LS
 * and PS into line breaks. Lone surrogates cannot be represented and become U+FFFD; the
 * other characters YAML does not print as-is (DEL, C1 including NEL, LS, PS, BOM and the
 * noncharacters U+FFFE/U+FFFF) are `\u` escaped. JSON.stringify's own escapes are ASCII,
 * so the second pass never touches them.
 */
function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/\p{Cs}/gu, '\uFFFD')).replace(
    /[\u007F-\u009F\u2028\u2029\uFEFF\uFFFE\uFFFF]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function deckYaml(snapshot: CanonicalSnapshot): string {
  const lines = [
    `schema: ${snapshot.schemaVersion}`,
    `name: ${yamlScalar(snapshot.deck.name)}`,
    `format: ${yamlScalar(snapshot.deck.format)}`,
    `description: ${yamlScalar(snapshot.deck.description)}`,
  ];
  if (snapshot.deck.tags.length === 0) lines.push('tags: []');
  else lines.push('tags:', ...snapshot.deck.tags.map((t) => `  - ${yamlScalar(t)}`));
  lines.push(
    `primer: ${snapshot.primer === null ? 'unavailable' : snapshot.primer === '' ? 'none' : 'primer.md'}`,
  );
  return `${lines.join('\n')}\n`;
}

export function snapshotToFileTree(snapshot: CanonicalSnapshot, options: FileTreeOptions = {}): FileTree {
  const tree: FileTree = { 'deck.yaml': deckYaml(snapshot) };

  for (const zone of snapshotZones(snapshot)) {
    const lines = zoneCards(snapshot, zone).flatMap(cardLines);
    if (lines.length > 0) tree[zoneFileName(zone)] = `${lines.join('\n')}\n`;
  }

  const names = new Map<string, string>();
  for (const zone of snapshotZones(snapshot)) {
    for (const card of zoneCards(snapshot, zone)) if (!names.has(card.key)) names.set(card.key, card.name);
  }
  const tagLines = Object.keys(snapshot.cardTags)
    .sort(compareStrings)
    .map((key) => `${names.get(key) ?? key}: ${(snapshot.cardTags[key] ?? []).join(', ')}`);
  if (tagLines.length > 0) tree['card-tags.txt'] = `${tagLines.join('\n')}\n`;

  const primer = snapshot.primer ?? options.unknownPrimer ?? '';
  if (primer !== '') tree['primer.md'] = primer;

  return Object.fromEntries(Object.entries(tree).sort(([a], [b]) => compareStrings(a, b)));
}
