// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { metaItemTexts, renderWithProviders } from '@/components/test-utils';
import type { ObservationDTO, VersionRefDTO } from '@/server/services/types';

import { StatusPanel, type StatusPanelDeck } from './status-panel';

const refreshAction = vi.hoisted(() => vi.fn());
const routerRefresh = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions', () => ({ refreshAction }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const HEAD: VersionRefDTO = {
  commitId: 'c47',
  shortId: 'c47',
  sequence: 47,
  message: 'Testing Broodlord package',
  createdAt: '2026-10-07T12:00:00.000Z',
  sourceVersion: 137,
  sourceUpdatedAt: '2026-10-07T11:00:00.000Z',
};

const WORKING: ObservationDTO = {
  id: 'obs-1',
  fetchedAt: '2026-10-09T12:00:00.000Z',
  method: 'server',
  sourceVersion: 143,
  sourceUpdatedAt: '2026-10-09T11:37:00.000Z',
  snapshotHash: 'hash',
};

function deck(overrides: Partial<StatusPanelDeck> = {}): StatusPanelDeck {
  return {
    id: 'deck-1',
    url: 'https://moxfield.com/decks/abc',
    status: 'uncommitted',
    head: HEAD,
    working: WORKING,
    workingStats: null,
    lastFetchError: null,
    serverFetch: { state: 'available' },
    autoRefreshSuggested: false,
    ...overrides,
  };
}

describe('StatusPanel', () => {
  beforeEach(() => {
    refreshAction.mockResolvedValue({ ok: true, changed: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows uncommitted changes with Moxfield and version details', () => {
    // Relative times depend on "now": pin it shortly after the fixtures' timestamps.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:05:00.000Z'));
    renderWithProviders(<StatusPanel deck={deck()} />);
    expect(screen.getByRole('heading', { name: 'Uncommitted changes' })).toBeInTheDocument();
    expect(metaItemTexts(screen.getByRole('list', { name: 'Moxfield activity' }))).toEqual([
      expect.stringMatching(/^Moxfield edited .+ ago$/),
      expect.stringMatching(/^checked .+/),
    ]);
    expect(metaItemTexts(screen.getByRole('list', { name: 'Versions' }))).toEqual([
      'Moxfield version 143',
      'v47 committed at 137',
    ]);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it.each<[StatusPanelDeck['status'], string]>([
    ['clean', 'Up to date with v47'],
    ['cosmetic-only', 'Only printing changes'],
    ['no-versions', 'Not committed yet'],
    ['never-fetched', 'Waiting for the first snapshot from Moxfield'],
  ])('labels the %s state', (status, label) => {
    const overrides: Partial<StatusPanelDeck> =
      status === 'never-fetched'
        ? { status, working: null, head: null }
        : status === 'no-versions'
          ? { status, head: null }
          : { status };
    renderWithProviders(<StatusPanel deck={deck(overrides)} />);
    expect(screen.getByRole('heading', { name: label })).toBeInTheDocument();
  });

  it('says how the deck arrived when it came from the bookmarklet', () => {
    renderWithProviders(<StatusPanel deck={deck({ working: { ...WORKING, method: 'browser-capture' } })} />);
    expect(screen.getByText(/sent from your browser/)).toBeInTheDocument();
  });

  it('capitalizes how the deck arrived when Moxfield did not say when it was edited', () => {
    renderWithProviders(<StatusPanel deck={deck({ working: { ...WORKING, sourceUpdatedAt: null } })} />);
    expect(metaItemTexts(screen.getByRole('list', { name: 'Moxfield activity' }))).toEqual([
      expect.stringMatching(/^Checked /),
    ]);
  });

  it('turns refresh into "Update from Moxfield" when server fetching is blocked', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    renderWithProviders(
      <StatusPanel
        deck={deck({
          serverFetch: {
            state: 'blocked',
            reason: 'Blocked by Moxfield.',
            retryAt: '2026-10-09T13:00:00.000Z',
          },
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    // `13:00` as a local clock time (with the date only if the time zone puts it on another day).
    expect(screen.getByText(/so it is paused until/).textContent).toMatch(
      /paused until (\w{3} \d{1,2}, )?\d{1,2}:\d{2}\s[AP]M \(in 1 hour\)\. Use the bookmarklet/,
    );
    const update = screen.getByRole('link', { name: /^Update from Moxfield/ });
    expect(update).toHaveAttribute('href', 'https://moxfield.com/decks/abc');
    expect(update).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Setup' })).toHaveAttribute('href', '/setup');
  });

  it('explains how to get the first snapshot without server fetching', () => {
    renderWithProviders(
      <StatusPanel
        deck={deck({
          status: 'never-fetched',
          working: null,
          head: null,
          serverFetch: { state: 'disabled', reason: 'Off.' },
        })}
      />,
    );
    expect(screen.getByText('Send to git-moxfield')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'paste instead' })).toHaveAttribute(
      'href',
      '/capture?mode=paste',
    );
  });

  it('shows a current fetch error with its next step', () => {
    renderWithProviders(
      <StatusPanel
        deck={deck({
          lastFetchError: {
            code: 'blocked',
            message: 'Moxfield blocked server-side requests.',
            at: '2026-10-09T12:30:00.000Z',
            retryAfterSeconds: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Moxfield blocked the server')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Open deck in Moxfield/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Bookmarklet setup' })).toHaveAttribute('href', '/setup');
  });

  it('suggests changing the Moxfield deck when the deck is gone from Moxfield', () => {
    renderWithProviders(
      <StatusPanel
        deck={deck({
          lastFetchError: {
            code: 'not-found',
            message: 'The deck does not exist on Moxfield (deleted or wrong id).',
            at: '2026-10-09T12:30:00.000Z',
            retryAfterSeconds: null,
          },
        })}
      />,
    );
    expect(screen.getByText('Deck not found on Moxfield')).toBeInTheDocument();
    expect(screen.getByText(/Deleted it and made it again\?/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change the Moxfield deck' })).toHaveAttribute(
      'href',
      '#moxfield-deck',
    );
  });

  it('explains a block before the first snapshot without repeating the steps’ actions', () => {
    renderWithProviders(
      <StatusPanel
        deck={deck({
          status: 'never-fetched',
          working: null,
          head: null,
          serverFetch: { state: 'blocked', reason: 'Blocked.', retryAt: '2026-10-09T13:00:00.000Z' },
          lastFetchError: {
            code: 'blocked',
            message: 'Moxfield blocked server-side requests.',
            at: '2026-10-09T12:00:00.000Z',
            retryAfterSeconds: 3600,
          },
        })}
      />,
    );
    expect(screen.getByText('Moxfield blocked the server')).toBeInTheDocument();
    expect(screen.getByText('Moxfield blocked server-side requests.')).toBeInTheDocument();
    // One way to each next step: the steps' links, not the banner's buttons as well.
    expect(screen.getAllByRole('link', { name: /Moxfield/ }).map((link) => link.textContent)).toEqual([
      expect.stringMatching(/^Update from Moxfield/),
    ]);
    expect(screen.getByRole('link', { name: 'Set it up' })).toHaveAttribute('href', '/setup');
    expect(screen.getByRole('link', { name: 'paste instead' })).toHaveAttribute(
      'href',
      '/capture?mode=paste',
    );
    expect(screen.queryByRole('link', { name: 'Bookmarklet setup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Paste JSON' })).not.toBeInTheDocument();
  });

  it('hides fetch errors that a later capture has superseded', () => {
    renderWithProviders(
      <StatusPanel
        deck={deck({
          lastFetchError: {
            code: 'blocked',
            message: 'Blocked.',
            at: '2026-10-09T10:00:00.000Z',
            retryAfterSeconds: null,
          },
        })}
      />,
    );
    expect(screen.queryByText('Moxfield blocked the server')).not.toBeInTheDocument();
  });

  it('refreshes on demand and confirms the outcome', async () => {
    const user = userEvent.setup();
    refreshAction.mockResolvedValue({ ok: true, changed: true });
    renderWithProviders(<StatusPanel deck={deck()} />);
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(refreshAction).toHaveBeenCalledWith('deck-1', 'manual');
    expect(await screen.findByText('Updated from Moxfield')).toBeInTheDocument();
  });

  it('refreshes once in the background when suggested, then reloads the route', async () => {
    renderWithProviders(<StatusPanel deck={deck({ autoRefreshSuggested: true })} />);
    expect(screen.getByText('Checking Moxfield for changes…')).toBeInTheDocument();
    await waitFor(() => {
      expect(routerRefresh).toHaveBeenCalledTimes(1);
    });
    expect(refreshAction).toHaveBeenCalledTimes(1);
    expect(refreshAction).toHaveBeenCalledWith('deck-1', 'auto');
    expect(screen.queryByText('Checking Moxfield for changes…')).not.toBeInTheDocument();
  });
});
