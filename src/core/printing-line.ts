/**
 * Deck-list lines in the Moxfield import style, `<qty> <Name> (<SET>) <collector number>`
 * with ` *F*` for foils and ` *E*` for etched cards. The Git export (lossless: unknown
 * finishes, languages and flags are written too) and the Moxfield restore text (lossy: what
 * Moxfield's Bulk Edit understands) spell their lines through here, each with an explicit
 * {@link LineFormat}, so a change to one contract never leaks into the other.
 */
import type { CanonicalCard, CanonicalPrinting } from './model';

export interface LineFormat {
  /** A finish other than nonfoil, foil and etched: written as ` *finish*`, or left out. */
  unknownFinish: 'verbatim' | 'omit';
  /** A language other than English: written as ` [lang]`, or left out. */
  lang: boolean;
  /** Printing flags: written as ` {a,b}`, or left out. */
  flags: boolean;
}

/** The marker after the collector number for a finish (`''` for nonfoil). */
export function finishMarker(finish: string, unknownFinish: LineFormat['unknownFinish']): string {
  if (finish === 'nonfoil') return '';
  if (finish === 'foil') return ' *F*';
  if (finish === 'etched') return ' *E*';
  return unknownFinish === 'verbatim' ? ` *${finish}*` : '';
}

/** One line per printing: `<qty> <name> (<SET>) <collector number>[ *F*][ [lang]][ {flags}]`. */
export function formatPrintingLine(name: string, printing: CanonicalPrinting, format: LineFormat): string {
  let line = `${printing.quantity} ${name} (${printing.set.toUpperCase()}) ${printing.collectorNumber}${finishMarker(printing.finish, format.unknownFinish)}`;
  if (format.lang && printing.lang !== 'en') line += ` [${printing.lang}]`;
  if (format.flags && printing.flags && printing.flags.length > 0) line += ` {${printing.flags.join(',')}}`;
  return line;
}

/** The lines of one card: one per printing, or `<qty> <name>` for a card without printings. */
export function formatCardLines(
  card: Pick<CanonicalCard, 'name' | 'quantity' | 'printings'>,
  format: LineFormat,
  name: string = card.name,
): string[] {
  if (card.printings.length === 0) return [`${card.quantity} ${name}`];
  return card.printings.map((printing) => formatPrintingLine(name, printing, format));
}

/** Lines as a file's text: newline-terminated, and empty for no lines. */
export function linesText(lines: readonly string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
