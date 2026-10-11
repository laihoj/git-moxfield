// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '@/components/test-utils';
import type { DeckScope } from '@/lib/routes';
import type { VersionListItemDTO } from '@/server/services/types';

import { VersionTimeline } from './version-timeline';

const TOKEN = `gmv_${'A'.repeat(43)}`;

function version(sequence: number, message: string): VersionListItemDTO {
  return {
    commitId: `commit-${sequence}`,
    shortId: `c${sequence}`,
    sequence,
    message,
    createdAt: '2026-10-01T12:00:00.000Z',
    sourceVersion: 100 + sequence,
    sourceUpdatedAt: null,
    parentSequence: sequence === 1 ? null : sequence - 1,
    tags: [],
    stats: { zones: [], moves: [], printingChanges: 0, tagChanges: 0 },
    primer: { status: 'unchanged' },
    commanders: [],
    commandersChanged: false,
    playedCardCount: 100,
    ingestMethod: 'server',
  };
}

const VERSIONS = [version(3, 'Back to Dress Down'), version(2, 'Testing Broodlord'), version(1, 'Initial')];

async function selectionLinks(scope: DeckScope, hasWorking: boolean, select: string[]): Promise<string[]> {
  const user = userEvent.setup();
  renderWithProviders(
    <VersionTimeline scope={scope} versions={VERSIONS} headSequence={3} hasWorking={hasWorking} selectable />,
  );
  for (const label of select)
    await user.click(screen.getByRole('checkbox', { name: `Select ${label} to compare` }));
  const bar = screen.getByRole('region', { name: 'Compare selected versions' });
  return within(bar)
    .getAllByRole('link')
    .map((link) => `${link.textContent} ${link.getAttribute('href')}`);
}

describe('VersionTimeline', () => {
  it('links every version within the owner’s pages', () => {
    renderWithProviders(
      <VersionTimeline scope={{ kind: 'owner', deckId: 'd1' }} versions={VERSIONS} headSequence={3} />,
    );
    expect(screen.getByRole('link', { name: 'v2: Testing Broodlord' })).toHaveAttribute(
      'href',
      '/decks/d1/versions/2',
    );
  });

  it('links every version within a share link’s pages', () => {
    renderWithProviders(
      <VersionTimeline scope={{ kind: 'shared', token: TOKEN }} versions={VERSIONS} headSequence={3} />,
    );
    expect(screen.getByRole('link', { name: 'v2: Testing Broodlord' })).toHaveAttribute(
      'href',
      `/s/${TOKEN}/versions/2`,
    );
  });

  it('offers the owner comparisons with the previous version and the current Moxfield deck', async () => {
    expect(await selectionLinks({ kind: 'owner', deckId: 'd1' }, true, ['v2'])).toEqual([
      'With previous /decks/d1/compare?from=v1&to=v2',
      'With current Moxfield deck /decks/d1/compare?from=v2&to=working',
    ]);
  });

  it('offers viewers committed comparisons only, within the link’s pages', async () => {
    const scope = { kind: 'shared', token: TOKEN } as const;
    expect(await selectionLinks(scope, false, ['v2'])).toEqual([
      `With previous /s/${TOKEN}/compare?from=v1&to=v2`,
    ]);
  });

  it('compares two selected versions within the scope', async () => {
    const scope = { kind: 'shared', token: TOKEN } as const;
    expect(await selectionLinks(scope, false, ['v3', 'v1'])).toEqual([
      `Compare selected /s/${TOKEN}/compare?from=v1&to=v3`,
    ]);
  });
});
