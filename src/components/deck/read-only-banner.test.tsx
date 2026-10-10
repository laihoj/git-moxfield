// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import '@/components/test-utils';
import { SiteChrome } from '@/components/app/site-chrome';
import { sharedDeckRoutes } from '@/lib/routes';

import { ReadOnlyBanner } from './read-only-banner';
import { VersionNote } from './version-note';
import { VersionTags } from './version-tags';

const TOKEN = `gmv_${'A'.repeat(43)}`;

describe('ReadOnlyBanner', () => {
  it('says whose deck it is and that it is read-only', () => {
    render(<ReadOnlyBanner ownerName="Mikko Laine" />);
    expect(screen.getByText(/Shared by/).closest('p')).toHaveTextContent('Shared by Mikko Laine · read-only');
  });

  it('sits in the frame of a share link page, whose wordmark leads to the shared deck', () => {
    render(
      <SiteChrome
        homeHref={sharedDeckRoutes(TOKEN).overview()}
        banner={<ReadOnlyBanner ownerName="Mikko Laine" />}
      >
        <p>Deck</p>
      </SiteChrome>,
    );
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('link', { name: 'git-moxfield' })).toHaveAttribute('href', `/s/${TOKEN}`);
    expect(header).toHaveTextContent('Shared by Mikko Laine · read-only');
    expect(within(header).getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveTextContent('Deck');
  });

  it('frames a dead link without any way into the app', () => {
    render(
      <SiteChrome>
        <p>This link doesn’t work anymore</p>
      </SiteChrome>,
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('git-moxfield');
  });
});

describe('read-only version annotations', () => {
  it('lists tags as plain text, and nothing without tags', () => {
    const { rerender } = render(<VersionTags tags={['stable', 'tournament']} />);
    const list = screen.getByRole('list', { name: 'Tags' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['stable', 'tournament']);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<VersionTags tags={[]} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows a note as text, keeping its lines, and says when there is none', () => {
    const { rerender } = render(
      <VersionNote text={'Went 4-1.\n<b>Cut Broodlord</b>'} updatedAt="2026-10-09T12:00:00.000Z" />,
    );
    const note = screen.getByText(/Went 4-1/);
    expect(note.textContent).toBe('Went 4-1.\n<b>Cut Broodlord</b>');
    expect(note.querySelector('b')).toBeNull();
    expect(screen.getByText(/Updated/)).toBeInTheDocument();
    rerender(<VersionNote text="" updatedAt={null} />);
    expect(screen.getByText('No notes on this version.')).toBeInTheDocument();
  });
});
