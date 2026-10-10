// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { describeManaCost, parseManaCost } from '@/lib/mana';
import '@/components/test-utils';

import { ManaCost } from './mana-cost';

describe('ManaCost', () => {
  it('renders one pip per symbol with a readable label', () => {
    const { container } = render(<ManaCost cost="{1}{B}{B}{B}" />);
    const cost = screen.getByRole('img', { name: 'Mana cost: 1 generic, 3 black' });
    expect(cost).toBeInTheDocument();
    expect([...container.querySelectorAll('[title]')].map((pip) => pip.textContent)).toEqual([
      '1',
      'B',
      'B',
      'B',
    ]);
  });

  it('renders hybrid, phyrexian, variable and colorless symbols gracefully', () => {
    const { container } = render(<ManaCost cost="{X}{W/U}{2/G}{B/P}{C}" />);
    expect(
      screen.getByRole('img', {
        name: 'Mana cost: X, white or blue, 2 generic or green, phyrexian black, colorless',
      }),
    ).toBeInTheDocument();
    const pips = [...container.querySelectorAll('[title]')];
    expect(pips.map((pip) => pip.getAttribute('title'))).toEqual(['{X}', '{W/U}', '{2/G}', '{B/P}', '{C}']);
    expect(pips[1]?.getAttribute('style')).toContain('linear-gradient');
    expect(pips[3]?.textContent).toBe('ϕ');
  });

  it('separates the faces of multi-faced cards', () => {
    render(<ManaCost cost="{2}{R} // {4}{R}" />);
    expect(
      screen.getByRole('img', { name: 'Mana cost: 2 generic, red; other face: 4 generic, red' }),
    ).toBeInTheDocument();
  });

  it('renders nothing for cards without a mana cost', () => {
    const { container } = render(<ManaCost cost="" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('parseManaCost', () => {
  it('keeps unknown symbols verbatim instead of dropping them', () => {
    expect(parseManaCost('{HW}{1}')).toEqual([
      [
        { kind: 'other', text: 'HW', raw: '{HW}' },
        { kind: 'generic', amount: 1, raw: '{1}' },
      ],
    ]);
  });

  it('describes a missing cost', () => {
    expect(describeManaCost('')).toBe('No mana cost');
  });
});
