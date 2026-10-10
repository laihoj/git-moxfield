import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { moxfieldPrimerToMarkdown } from './primer-markup';
import { v1Primer } from './test-fixtures';

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

describe('moxfieldPrimerToMarkdown', () => {
  it('converts the fixture primer', () => {
    expect(moxfieldPrimerToMarkdown(v1Primer().content)).toBe(
      [
        '# **Fixture Primer**',
        '*by fixture-user*',
        '',
        '***',
        '',
        '### Introduction',
        '',
        "This is a synthetic primer used for tests. It mentions **Thassa's Oracle** and **Underworld Breach**.",
        '',
        '- Point one',
        '- Point two',
        '',
        '## Mulligans',
        'Keep hands with fast mana.',
        '',
        "<script>alert('xss')</script>",
        '[bad link](javascript:alert(1))',
        '',
      ].join('\n'),
    );
  });

  it('does not add HTML to hostile content', () => {
    const input = v1Primer().content;
    const output = moxfieldPrimerToMarkdown(input);
    expect(count(output, '<')).toBe(count(input, '<'));
    expect(moxfieldPrimerToMarkdown('[[<img src=x onerror=alert(1)>]]')).toBe(
      '**\\<img src=x onerror=alert(1)\\>**\n',
    );
  });

  it('never increases the number of "<" characters (property)', () => {
    const directive = fc.constantFrom(
      '===center',
      '===endcenter',
      '===accordion',
      '===endaccordion',
      '===panel: <b>x</b>',
      '===endpanel',
      '```',
      '[[<script>]]',
      '`[[x]]`',
      '',
    );
    const line = fc.oneof(directive, fc.string({ maxLength: 40 }));
    fc.assert(
      fc.property(fc.array(line, { maxLength: 30 }), (lines) => {
        const input = lines.join('\n');
        expect(count(moxfieldPrimerToMarkdown(input), '<')).toBeLessThanOrEqual(count(input, '<'));
      }),
    );
  });

  it('keeps blocks separated where directives are removed', () => {
    expect(moxfieldPrimerToMarkdown('Para A\n===endcenter\nPara B')).toBe('Para A\n\nPara B\n');
    expect(moxfieldPrimerToMarkdown('===center\n\n\nText\n\n===endcenter\n\n')).toBe('Text\n');
  });

  it('turns panels into headings, case-insensitively and with odd spacing', () => {
    expect(moxfieldPrimerToMarkdown("===Panel:Combo [[Thassa's Oracle]]\nbody\n===ENDPANEL")).toBe(
      "### Combo **Thassa's Oracle**\n\nbody\n",
    );
    expect(moxfieldPrimerToMarkdown('  ===panel:   Spaced Title   \nx')).toBe('### Spaced Title\n\nx\n');
    expect(moxfieldPrimerToMarkdown('===panel:\nx\n===panel\ny')).toBe('x\n\ny\n');
  });

  it('leaves fenced code blocks and inline code untouched', () => {
    const fenced = '```\n===center\n[[Sol Ring]]\n```\n===center\nafter `[[Sol Ring]]` and [[Sol Ring]]';
    expect(moxfieldPrimerToMarkdown(fenced)).toBe(
      '```\n===center\n[[Sol Ring]]\n```\n\nafter `[[Sol Ring]]` and **Sol Ring**\n',
    );
    expect(moxfieldPrimerToMarkdown('~~~~\n```\n===center\n~~~~\nout')).toBe(
      '~~~~\n```\n===center\n~~~~\nout\n',
    );
  });

  it('escapes markdown in card names and ignores empty references', () => {
    expect(moxfieldPrimerToMarkdown('[[_____ Goblin]] [[ ]] [[a|b]]')).toBe(
      '**\\_\\_\\_\\_\\_ Goblin** [[ ]] **a\\|b**\n',
    );
  });

  it('keeps unknown directives, other markdown and normalizes line endings', () => {
    expect(moxfieldPrimerToMarkdown('===spoiler\r\n**bold** [link](https://example.com)\r\n')).toBe(
      '===spoiler\n**bold** [link](https://example.com)\n',
    );
  });

  it('returns an empty string for empty primers', () => {
    expect(moxfieldPrimerToMarkdown('')).toBe('');
    expect(moxfieldPrimerToMarkdown('===center\n===endcenter\n\n')).toBe('');
  });

  it('does not take a line-leading inline triple-backtick span for a code fence', () => {
    expect(
      moxfieldPrimerToMarkdown(
        '```Thoracle```\n\n===panel: Mulligans\nKeep [[Sol Ring]] hands.\n===endpanel',
      ),
    ).toBe('```Thoracle```\n\n### Mulligans\n\nKeep **Sol Ring** hands.\n');
    expect(moxfieldPrimerToMarkdown('```Thoracle + Consult``` wins.\n[[Sol Ring]]')).toBe(
      '```Thoracle + Consult``` wins.\n**Sol Ring**\n',
    );
    // A tilde fence's info string may contain backticks; a backtick fence's may not.
    expect(moxfieldPrimerToMarkdown('~~~a`b\n[[Sol Ring]]\n~~~\n[[Sol Ring]]')).toBe(
      '~~~a`b\n[[Sol Ring]]\n~~~\n**Sol Ring**\n',
    );
    expect(moxfieldPrimerToMarkdown('```ts\n[[Sol Ring]]\n``` x ```\n```\n[[Sol Ring]]')).toBe(
      '```ts\n[[Sol Ring]]\n``` x ```\n```\n**Sol Ring**\n',
    );
  });

  it('handles long whitespace runs in directive lines in linear time', () => {
    const run = ' '.repeat(200_000);
    const started = performance.now();
    const panel = moxfieldPrimerToMarkdown(`Intro\n===panel:x${run}y\n`);
    const bare = moxfieldPrimerToMarkdown(`Intro\n===panel${run}y\n===center${run}\n`);
    const elapsed = performance.now() - started;
    expect(panel.startsWith('Intro\n\n### x')).toBe(true);
    expect(panel.endsWith('y\n')).toBe(true);
    // Not a directive (text after the name without a colon): kept as is.
    expect(bare).toBe(`Intro\n===panel${run}y\n`);
    expect(elapsed).toBeLessThan(250);
  });
});
