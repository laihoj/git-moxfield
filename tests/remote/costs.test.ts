/**
 * What the hottest paths cost in rows read and written on a remote libSQL server (Turso
 * bills both, and its free plan allows 500 million rows read and 10 million written a
 * month): a capture, the deck page, the version page and the deck list, for a deck of 100
 * cards in a workspace with other decks. Each bound sits a little above what sqld 0.24.32
 * measured; the comments give the cost before the fix the bound guards.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { ensureLocalWorkspace } from '@/server/db/client';
import { applyMigrations } from '@/server/db/migration-state';
import type { DeckServices } from '@/server/services';
import { captureOnlyServices, captureSpec, commitWorkingState } from '@tests/support/flows';
import type { MoxCardSpec, MoxDeckSpec } from '@tests/support/moxfield-deck-builder';
import { defined, recordingLogger } from '@tests/support/services';

import { measure, openMetered, openRemote, wipeRemoteDatabase, type Usage } from './support';

const TYPES = ['Instant', 'Sorcery', 'Creature — Elf Druid', 'Artifact', 'Enchantment', 'Land'];

/** 100 distinct cards with distinct facts. */
const CARDS: MoxCardSpec[] = Array.from({ length: 100 }, (_, i) => ({
  name: `Measured Card ${String(i).padStart(3, '0')}`,
  typeLine: TYPES[i % TYPES.length] ?? 'Instant',
  manaCost: `{${(i % 5) + 1}}{G}`,
}));

/** A 100-card deck (plus two commanders and basic lands), its cards shifted by `shift`. */
function deckSpec(publicId: string, shift = 0): MoxDeckSpec {
  const cards = [...CARDS.slice(shift), ...CARDS.slice(0, shift)];
  return {
    publicId,
    name: publicId,
    format: 'commander',
    commanders: ['Tymna the Weaver', "Kraum, Ludevic's Opus"],
    mainboard: [...cards.slice(0, 90), '8 Island'],
    considering: cards.slice(90),
    primer: '# Primer\n\nSome text.',
  };
}

/** Moves one card of `spec` from the mainboard to Considering. */
function withOneCardMoved(spec: MoxDeckSpec): MoxDeckSpec {
  const [moved, ...mainboard] = spec.mainboard ?? [];
  return { ...spec, mainboard, considering: [...(spec.considering ?? []), defined(moved, 'card')] };
}

const usage: Usage = { rowsRead: 0, rowsWritten: 0 };
let services: DeckServices;
let version = 0;

function capture(spec: MoxDeckSpec): Promise<string> {
  return captureSpec(
    services,
    { ...spec, version: ++version },
    new Date(Date.UTC(2026, 9, 1, 0, 0, version)).toISOString(),
  );
}

/** Captures `spec` and commits it as the deck's next version. */
async function commitState(spec: MoxDeckSpec): Promise<string> {
  const deckId = await capture(spec);
  const outcome = await commitWorkingState(services, deckId, { message: `Version ${version}` });
  if (!outcome.ok) throw new Error(`Commit failed: ${outcome.reason}`);
  return deckId;
}

/** Tracks `count` more decks of three versions each. */
async function addOtherDecks(count: number, from: number): Promise<void> {
  for (let n = from; n < from + count; n++) {
    const publicId = `OtherDeck${String(n).padStart(13, '0')}`;
    for (let shift = 0; shift < 3; shift++) await commitState(deckSpec(publicId, shift));
  }
}

const MEASURED = 'MeasuredDeck0000000001';
const VERSIONS = 5;
let deckId: string;

beforeAll(async () => {
  await wipeRemoteDatabase();
  const handle = await openRemote();
  try {
    await applyMigrations(handle.db);
    await ensureLocalWorkspace(handle.db);
  } finally {
    handle.close();
  }
  services = captureOnlyServices(openMetered(usage), { logger: recordingLogger() });
  for (let shift = 0; shift < VERSIONS; shift++) deckId = await commitState(deckSpec(MEASURED, shift));
  await addOtherDecks(3, 0);
}, 300_000);

describe('rows a capture writes', () => {
  it('writes only its observation when the deck is unchanged, not the card facts again', async () => {
    const spec = withOneCardMoved(deckSpec(MEASURED, VERSIONS - 1));
    await capture(spec);
    const again = await measure(usage, () => capture(spec));
    // Measured: 8 (raw payload 2 with its index, observation 5 with its indexes, the pruned
    // observation 1). Before: 111, the facts of all 103 cards rewritten on every capture.
    expect(again.rowsWritten, `rows written: ${again.rowsWritten}`).toBeLessThanOrEqual(12);
  });

  it('writes the new state and its card index, but no unchanged card facts', async () => {
    const changed = await measure(usage, () => capture(deckSpec(MEASURED, VERSIONS + 1)));
    // Measured: 320 (the card index of the new state, 103 rows with two indexes each: 309;
    // the snapshot, raw payload and observation: 11). Before: 421 (103 card facts rewritten).
    expect(changed.rowsWritten, `rows written: ${changed.rowsWritten}`).toBeLessThanOrEqual(330);
  });
});

describe('rows a page reads', () => {
  it('the deck page reads about one row per version, whatever else the workspace holds', async () => {
    const before = await measure(usage, () => services.getOverview(deckId));
    expect(before.value?.versionCount).toBe(VERSIONS);
    await addOtherDecks(3, 3);
    const after = await measure(usage, () => services.getOverview(deckId));
    // Measured: 32. Before: every deck query also read every deck of the workspace, about
    // five more rows per deck (173 rows with 30 decks of 11 versions).
    expect(after.rowsRead, `rows read: ${before.rowsRead}, then ${after.rowsRead}`).toBe(before.rowsRead);
    expect(after.rowsRead).toBeLessThanOrEqual(40);
  });

  it('the version page reads each card fact once', async () => {
    const page = await measure(usage, () => services.getVersion(deckId, VERSIONS));
    const cards = Object.keys(defined(page.value).catalog).length;
    expect(cards).toBeGreaterThan(100);
    // Measured: 133 for 103 cards. Before: three rows per card fact (`key IN (...)` builds a
    // temporary table that is read too), and every deck of the workspace per query: 333
    // rows with one deck in the workspace, 501 with 30.
    expect(page.rowsRead, `rows read: ${page.rowsRead}`).toBeLessThanOrEqual(cards + 35);
  });

  it('the deck list reads a bounded number of rows per deck', async () => {
    const list = await measure(usage, () => services.listDecks());
    const decks = list.value.length;
    expect(decks).toBe(7);
    // Measured: 99 for 7 decks (14 per deck). Before: every deck's queries read every deck of
    // the workspace (decks × decks): 2,371 rows for 30 decks of 11 versions, 631 after.
    expect(list.rowsRead / decks, `rows read: ${list.rowsRead}`).toBeLessThanOrEqual(VERSIONS + 15);
  });
});
