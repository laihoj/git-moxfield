/**
 * Parsing of Scryfall-style mana costs (`{2}{U}{U}`, `{W/U}`, `{B/P}`, `{X}`) into
 * symbols for display, plus a readable description for assistive technology.
 *
 * Costs of multi-faced cards arrive as `{1}{U} // {2}{R}`; every face is parsed
 * separately. Unknown symbols are kept verbatim so nothing is silently dropped.
 */

export type ManaColor = 'W' | 'U' | 'B' | 'R' | 'G' | 'C';

const COLORS: ReadonlySet<string> = new Set(['W', 'U', 'B', 'R', 'G', 'C']);

const COLOR_NAMES: Record<ManaColor, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
  C: 'colorless',
};

export type ManaSymbol =
  /** Generic mana: `{0}`…`{20}`. */
  | { kind: 'generic'; amount: number; raw: string }
  /** One colored (or `{C}` colorless) mana. */
  | { kind: 'color'; color: ManaColor; raw: string }
  /** Hybrid of two colors `{W/U}` or of generic and a color `{2/W}`. */
  | { kind: 'hybrid'; left: ManaColor | number; right: ManaColor; raw: string }
  /** Phyrexian `{B/P}`, or hybrid phyrexian `{G/W/P}` (second color in `right`). */
  | { kind: 'phyrexian'; color: ManaColor; right?: ManaColor; raw: string }
  /** `{X}`, `{Y}`, `{Z}`. */
  | { kind: 'variable'; letter: string; raw: string }
  /** `{S}` snow mana. */
  | { kind: 'snow'; raw: string }
  /** Anything else, kept verbatim. */
  | { kind: 'other'; text: string; raw: string };

function isColor(value: string): value is ManaColor {
  return COLORS.has(value);
}

function parseSymbol(inner: string): ManaSymbol {
  const raw = `{${inner}}`;
  const text = inner.toUpperCase();
  if (/^\d{1,2}$/.test(text)) return { kind: 'generic', amount: Number(text), raw };
  if (isColor(text)) return { kind: 'color', color: text, raw };
  if (text === 'X' || text === 'Y' || text === 'Z') return { kind: 'variable', letter: text, raw };
  if (text === 'S') return { kind: 'snow', raw };

  const parts = text.split('/');
  if (parts.length === 2) {
    const [left = '', right = ''] = parts;
    if (right === 'P' && isColor(left)) return { kind: 'phyrexian', color: left, raw };
    if (isColor(right) && isColor(left)) return { kind: 'hybrid', left, right, raw };
    if (isColor(right) && /^\d{1,2}$/.test(left)) return { kind: 'hybrid', left: Number(left), right, raw };
  }
  if (parts.length === 3 && parts[2] === 'P') {
    const [left = '', right = ''] = parts;
    if (isColor(left) && isColor(right)) return { kind: 'phyrexian', color: left, right, raw };
  }
  return { kind: 'other', text: inner, raw };
}

/** Parses one face's cost. Text outside `{…}` is ignored. */
function parseFace(face: string): ManaSymbol[] {
  return [...face.matchAll(/\{([^{}]{1,8})\}/g)].map((match) => parseSymbol(match[1] ?? ''));
}

/**
 * Parses a mana cost into faces of symbols. Empty faces are dropped, so a land
 * (`''`) yields `[]` and a modal DFC with one castable face yields one face.
 */
export function parseManaCost(cost: string): ManaSymbol[][] {
  return cost
    .split('//')
    .map((face) => parseFace(face))
    .filter((symbols) => symbols.length > 0);
}

function describeSymbol(symbol: ManaSymbol): string {
  switch (symbol.kind) {
    case 'generic':
      return `${symbol.amount} generic`;
    case 'color':
      return COLOR_NAMES[symbol.color];
    case 'hybrid':
      return `${typeof symbol.left === 'number' ? `${symbol.left} generic` : COLOR_NAMES[symbol.left]} or ${COLOR_NAMES[symbol.right]}`;
    case 'phyrexian':
      return symbol.right === undefined
        ? `phyrexian ${COLOR_NAMES[symbol.color]}`
        : `phyrexian ${COLOR_NAMES[symbol.color]} or ${COLOR_NAMES[symbol.right]}`;
    case 'variable':
      return symbol.letter;
    case 'snow':
      return 'snow';
    case 'other':
      return symbol.text;
  }
}

/** Groups identical consecutive descriptions: `black, black` → `2 black`. */
function describeFace(symbols: readonly ManaSymbol[]): string {
  const parts: { text: string; count: number }[] = [];
  for (const symbol of symbols) {
    const text = describeSymbol(symbol);
    const last = parts.at(-1);
    if (last?.text === text && symbol.kind !== 'generic') last.count += 1;
    else parts.push({ text, count: 1 });
  }
  return parts.map(({ text, count }) => (count > 1 ? `${count} ${text}` : text)).join(', ');
}

/**
 * Readable description for screen readers: `Mana cost: 1 generic, 3 black`. Faces of
 * multi-faced cards are joined with `; other face: `. Returns `No mana cost` for `''`.
 */
export function describeManaCost(cost: string): string {
  const faces = parseManaCost(cost);
  if (faces.length === 0) return 'No mana cost';
  return `Mana cost: ${faces.map(describeFace).join('; other face: ')}`;
}
