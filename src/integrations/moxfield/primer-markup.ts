/**
 * Conversion of Moxfield primer markup into portable markdown.
 *
 * Moxfield primers are markdown plus block directives on their own lines
 * (`===center`, `===accordion`, `===panel: Title`, and their `===end…` counterparts)
 * and inline card references (`[[Card Name]]`). The converter drops layout-only
 * directives, turns panel titles into `###` headings and card references into bold
 * text, and leaves all other markdown untouched. It never adds HTML: the output is as
 * untrusted as the input and must still be rendered without raw HTML.
 */

/**
 * Start of a directive line: `===name`, optionally indented. The rest of the line is
 * parsed by {@link parseDirective} without a regex: primers are untrusted, and a regex
 * with several whitespace quantifiers around a lazy argument backtracks quadratically
 * on long whitespace runs.
 */
const DIRECTIVE_HEAD_PATTERN = /^\s{0,3}===([a-z]+)/i;

/** Directives that only affect Moxfield's layout and are dropped. */
const LAYOUT_DIRECTIVES: ReadonlySet<string> = new Set([
  'center',
  'endcenter',
  'accordion',
  'endaccordion',
  'endpanel',
]);

/**
 * Opening or closing line of a fenced code block (``` or ~~~, at most 3 spaces indented).
 * As in CommonMark, a backtick fence's info string may not contain a backtick, so a line
 * starting with an inline span like ```code``` is not a fence.
 */
const FENCE_PATTERN = /^\s{0,3}(`{3,}(?=[^`]*$)|~{3,})/;

/** `[[Card Name]]` with a single-line name of reasonable length. */
const CARD_REFERENCE_PATTERN = /\[\[([^[\]\n]{1,200})\]\]/g;

/** Inline code spans, which are left untouched. */
const CODE_SPAN_PATTERN = /(`+)[^`]*?\1/g;

/**
 * Backslash-escapes the markdown punctuation that could change how a card name
 * renders inside `**…**` (emphasis, code, links, autolinks/HTML, tables, strikethrough).
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>|~]/g, (char) => `\\${char}`);
}

/** Parses `===name` or `===name: argument` (surrounding whitespace ignored); `null` otherwise. */
function parseDirective(line: string): { name: string; argument: string } | null {
  const head = DIRECTIVE_HEAD_PATTERN.exec(line);
  const name = head?.[1];
  if (head === null || name === undefined) return null;
  const rest = line.slice(head[0].length).trim();
  if (rest.length === 0) return { name: name.toLowerCase(), argument: '' };
  if (!rest.startsWith(':')) return null;
  return { name: name.toLowerCase(), argument: rest.slice(1).trim() };
}

function convertCardReferences(text: string): string {
  return text.replace(CARD_REFERENCE_PATTERN, (match, name: string) => {
    const trimmed = name.trim();
    return trimmed.length === 0 ? match : `**${escapeMarkdown(trimmed)}**`;
  });
}

/** Converts card references in a line, outside of inline code spans. */
function convertInline(line: string): string {
  let result = '';
  let last = 0;
  for (const match of line.matchAll(CODE_SPAN_PATTERN)) {
    result += convertCardReferences(line.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return result + convertCardReferences(line.slice(last));
}

/**
 * Converts Moxfield primer markup to GitHub-flavored markdown:
 *
 * - `===center`, `===endcenter`, `===accordion`, `===endaccordion`, `===endpanel` are
 *   dropped (their content is kept);
 * - `===panel: Title` becomes `### Title` (a panel without a title is dropped);
 * - `[[Card Name]]` becomes `**Card Name**`;
 * - removed directive lines still separate the blocks around them, so paragraphs on
 *   either side do not merge; fenced code blocks are left verbatim;
 * - unknown `===` directives and everything else are kept as is.
 *
 * Line endings become `\n`; the result ends with one newline when non-empty. Pure.
 */
export function moxfieldPrimerToMarkdown(primer: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let pendingBreak = false;

  const emit = (line: string): void => {
    if (pendingBreak && out.length > 0 && out.at(-1) !== '') out.push('');
    pendingBreak = false;
    out.push(line);
  };

  for (const line of primer.replace(/\r\n?/g, '\n').split('\n')) {
    if (fence !== null) {
      out.push(line);
      const closing = FENCE_PATTERN.exec(line)?.[1];
      if (closing?.startsWith(fence) === true && line.trim() === closing) fence = null;
      continue;
    }

    const opening = FENCE_PATTERN.exec(line)?.[1];
    if (opening !== undefined) {
      emit(line);
      fence = opening;
      continue;
    }

    const directive = parseDirective(line);
    if (directive !== null && (LAYOUT_DIRECTIVES.has(directive.name) || directive.name === 'panel')) {
      const title = directive.name === 'panel' ? directive.argument : '';
      if (title.length > 0) {
        pendingBreak = true;
        emit(`### ${convertInline(title)}`);
      }
      pendingBreak = true;
      continue;
    }

    if (line.trim().length === 0) {
      if (!pendingBreak && out.length > 0) out.push('');
      continue;
    }
    emit(convertInline(line));
  }

  while (out.at(-1) === '') out.pop();
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
