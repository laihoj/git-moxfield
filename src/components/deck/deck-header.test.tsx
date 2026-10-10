// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { metaItemTexts } from '@/components/test-utils';

import { DeckHeader } from './deck-header';

describe('DeckHeader', () => {
  it('shows the name, the format as a badge and the commanders as a list', () => {
    render(
      <DeckHeader
        name="Blue Farm"
        commanders={["Kraum, Ludevic's Opus", 'Tymna the Weaver']}
        format="commander"
        url="https://moxfield.com/decks/abc"
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Blue Farm' })).toBeInTheDocument();
    expect(screen.getByText('Commander')).toBeInTheDocument();
    expect(metaItemTexts(screen.getByRole('list', { name: 'Commanders' }))).toEqual([
      "Kraum, Ludevic's Opus",
      'Tymna the Weaver',
    ]);
    expect(screen.getByRole('link', { name: /Moxfield/ })).toHaveAttribute('target', '_blank');
  });

  it('shows the Moxfield id as secondary text while the deck has no name', () => {
    render(
      <DeckHeader
        name="New Moxfield deck"
        unnamedId="7O1sCuIti0igU6Us_Jhadg"
        commanders={[]}
        format=""
        url="https://moxfield.com/decks/7O1sCuIti0igU6Us_Jhadg"
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'New Moxfield deck' })).toBeInTheDocument();
    expect(screen.getByText('7O1sCuIti0igU6Us_Jhadg')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
