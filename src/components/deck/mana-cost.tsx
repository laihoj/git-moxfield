import clsx from 'clsx';
import { Fragment, type CSSProperties } from 'react';

import { describeManaCost, parseManaCost, type ManaColor, type ManaSymbol } from '@/lib/mana';

const COLOR_VARS: Record<ManaColor, string> = {
  W: 'var(--mana-w)',
  U: 'var(--mana-u)',
  B: 'var(--mana-b)',
  R: 'var(--mana-r)',
  G: 'var(--mana-g)',
  C: 'var(--mana-c)',
};

function split(left: string, right: string): CSSProperties {
  return { background: `linear-gradient(135deg, ${left} 50%, ${right} 50%)` };
}

/** Background and glyph of one pip. */
function pip(symbol: ManaSymbol): { style: CSSProperties; text: string } {
  switch (symbol.kind) {
    case 'generic':
      return { style: { background: COLOR_VARS.C }, text: String(symbol.amount) };
    case 'color':
      return {
        style: { background: COLOR_VARS[symbol.color] },
        text: symbol.color === 'C' ? '◇' : symbol.color,
      };
    case 'hybrid':
      return typeof symbol.left === 'number'
        ? { style: split(COLOR_VARS.C, COLOR_VARS[symbol.right]), text: String(symbol.left) }
        : { style: split(COLOR_VARS[symbol.left], COLOR_VARS[symbol.right]), text: '' };
    case 'phyrexian':
      return {
        style:
          symbol.right === undefined
            ? { background: COLOR_VARS[symbol.color] }
            : split(COLOR_VARS[symbol.color], COLOR_VARS[symbol.right]),
        text: 'ϕ',
      };
    case 'variable':
      return { style: { background: COLOR_VARS.C }, text: symbol.letter };
    case 'snow':
      return { style: { background: COLOR_VARS.C }, text: 'S' };
    case 'other':
      return { style: { background: COLOR_VARS.C }, text: symbol.text.slice(0, 2) };
  }
}

export interface ManaCostProps {
  /** Scryfall-style cost, e.g. `{1}{B}{B}` or `{1}{U} // {2}{R}`. */
  cost: string;
  className?: string;
}

/**
 * Mana cost as small round pips in the mana colors. Hybrid symbols are split
 * diagonally, phyrexian symbols show ϕ. The visual is hidden from screen readers in
 * favor of a readable label ("Mana cost: 1 generic, 3 black"). Renders nothing for
 * cards without a cost (lands).
 */
export function ManaCost({ cost, className }: ManaCostProps) {
  const faces = parseManaCost(cost);
  if (faces.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={describeManaCost(cost)}
      className={clsx('inline-flex items-center gap-px', className)}
    >
      {faces.map((symbols, faceIndex) => (
        <Fragment key={faceIndex}>
          {faceIndex > 0 && <span className="px-0.5 text-xs text-subtle">/</span>}
          {symbols.map((symbol, index) => {
            const { style, text } = pip(symbol);
            return (
              <span
                key={index}
                title={symbol.raw}
                style={style}
                className="inline-flex size-4 items-center justify-center rounded-full text-[0.625rem] leading-none font-bold text-mana-ink shadow-[inset_0_-1px_0_rgb(0_0_0/0.18)]"
              >
                {text}
              </span>
            );
          })}
        </Fragment>
      ))}
    </span>
  );
}
