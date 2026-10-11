import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { THEME, type ThemeTokens } from './brand';

const globalsCss = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const iconSvg = readFileSync(new URL('../app/icon.svg', import.meta.url), 'utf8');

/** The custom properties declared in the block that starts at `opener` and ends at `closer`. */
function declarationsBetween(opener: string, closer: string): Map<string, string> {
  const start = globalsCss.indexOf(opener);
  expect(start, `${opener} in globals.css`).toBeGreaterThanOrEqual(0);
  const end = globalsCss.indexOf(closer, start);
  expect(end, `the end of ${opener}`).toBeGreaterThan(start);
  const block = globalsCss.slice(start, end);
  return new Map(
    [...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1] ?? '', match[2] ?? '']),
  );
}

/** The theme's tokens as `globals.css` names them. */
function cssNames(theme: ThemeTokens): [string, string][] {
  return [
    ['--bg', theme.bg],
    ['--surface', theme.surface],
    ['--border', theme.border],
    ['--fg', theme.fg],
    ['--muted', theme.muted],
    ['--accent', theme.accent],
    ['--accent-hover', theme.accentHover],
    ['--accent-fg', theme.accentFg],
  ];
}

describe('brand colors', () => {
  it('match the light theme of globals.css', () => {
    const light = declarationsBetween(':root {', '\n}\n');
    for (const [name, value] of cssNames(THEME.light)) expect(light.get(name), name).toBe(value);
  });

  it('match the dark theme of globals.css', () => {
    const dark = declarationsBetween('@media (prefers-color-scheme: dark) {\n  :root {', '\n  }\n}');
    for (const [name, value] of cssNames(THEME.dark)) expect(dark.get(name), name).toBe(value);
  });

  it('are the accent and glyph colors of the static icon', () => {
    expect(iconSvg).toContain(`fill="${THEME.light.accent}"`);
    expect(iconSvg).toContain(`stroke="${THEME.light.accentFg}"`);
  });
});
