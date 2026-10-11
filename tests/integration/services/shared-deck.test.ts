/**
 * The viewer scope (ADR 0007): a share link token opens one deck's committed history,
 * read-only, for anyone who holds it.
 *
 * - Committed only: no uncommitted Moxfield state reaches a viewer, not even the deck's
 *   current name, commanders or cards; `working` is refused; card history has no working
 *   point. Nor where the deck lives on Moxfield (its URL opens the live deck).
 * - One deck: ids, commit id prefixes and card names of other decks (of the same
 *   workspace or another) resolve to nothing.
 * - Notes only when the link includes them.
 * - Access ends at once when the link is revoked, the deck untracked or the owner
 *   disabled, for services obtained before too; such links are indistinguishable from
 *   unknown tokens, and malformed tokens never reach the database.
 * - Read-only by type and at runtime; the token is never logged or stored.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { restoreText } from '@/app/restore-download';
import type { Db } from '@/server/db/client';
import type { DeckServices, SharedDeckServices } from '@/server/services';
import { countRows } from '@tests/support/db';
import { signUp } from '@tests/support/auth';
import {
  blueFarmSpec,
  commitReviewed,
  committed,
  createServiceHarness,
  defined,
  type ServiceHarness,
} from '@tests/support/services';
import {
  APP_URL,
  openShared,
  sharedHistory,
  tokenOfShareUrl,
  type SharedHistory,
} from '@tests/support/sharing';

/** What the scenario's uncommitted Moxfield state has and no version has. */
const UNCOMMITTED = ['secret tech', 'Thrasios', 'Mystic Remnant'];

async function share(
  harness: ServiceHarness,
  history: SharedHistory,
  options: { includeNotes?: boolean } = {},
): Promise<{ token: string; viewer: SharedDeckServices; linkId: string }> {
  const created = await history.shareLinks.createShareLink(
    history.deckId,
    { label: 'For Pekka', includeNotes: options.includeNotes ?? false },
    APP_URL,
  );
  const token = tokenOfShareUrl(created.url);
  const access = defined(await openShared(harness, token), 'shared deck');
  return { token, viewer: access.services, linkId: created.link.id };
}

/** Tracks and commits another deck for `services`; returns its first version's commit id. */
async function otherDeck(
  harness: ServiceHarness,
  services: DeckServices,
  publicId: string,
  cards: string[],
): Promise<{ deckId: string; commitId: string }> {
  harness.api.setDeck(blueFarmSpec({ publicId, name: 'Other deck', mainboard: cards, considering: [] }));
  const tracked = await services.trackDeck(`https://moxfield.com/decks/${publicId}`);
  if (!tracked.ok) throw new Error(tracked.reason);
  const version = committed(await commitReviewed({ ...harness, services }, tracked.deckId, 'Other v1'));
  return { deckId: tracked.deckId, commitId: version.commitId };
}

function expectNoUncommittedState(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of UNCOMMITTED) expect(text).not.toContain(secret);
}

describe('opening a share link', () => {
  it('grants one deck, naming its owner and what the link includes', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const created = await history.shareLinks.createShareLink(
      history.deckId,
      { label: 'For Pekka', includeNotes: true },
      APP_URL,
    );
    const access = defined(await openShared(harness, tokenOfShareUrl(created.url)));
    expect(access.share).toEqual({
      label: 'For Pekka',
      includeNotes: true,
      ownerDisplayName: 'Mikko',
      deckId: history.deckId,
    });
  });

  it('rejects malformed tokens before any database lookup', async () => {
    const harness = await createServiceHarness();
    const untouchable = new Proxy({} as Db, {
      get(_target, property) {
        throw new Error(`The database was used (${String(property)})`);
      },
    });
    const valid = 'gmv_' + 'A'.repeat(43);
    for (const token of [
      undefined,
      null,
      42,
      {},
      '',
      'gmv_',
      'gmv_' + 'A'.repeat(42),
      'gmv_' + 'A'.repeat(44),
      'gmv_' + 'A'.repeat(42) + '+',
      'gms_' + 'A'.repeat(43),
      ` ${valid}`,
      valid.toUpperCase(),
    ]) {
      const result = await openShared({ ...harness, db: untouchable }, token);
      expect(result).toBeNull();
    }
    // A well-formed token that was never issued: looked up, and nothing found.
    expect(await openShared(harness, valid)).toBeNull();
  });

  it('never logs or stores the token, also when recording the view fails', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token, viewer } = await share(harness, history);
    await viewer.getOverview();
    await viewer.compare('v1', 'v2');
    await viewer.restoreExport(1);
    await harness.db.run(
      sql.raw(
        "CREATE TRIGGER refuse_views BEFORE UPDATE ON share_links BEGIN SELECT RAISE(ABORT, 'no writes'); END",
      ),
    );
    harness.clock.advance(2 * 3600);
    const again = defined(await openShared(harness, token), 'viewing despite a failed view record');
    expect(await again.services.getOverview()).not.toBeNull();
    expect(harness.logger.entries).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'Could not record a share link view' }),
    );
    expect(JSON.stringify(harness.logger.entries)).not.toContain(token);
    const tables = ['share_links', 'sessions', 'credentials', 'app_settings'];
    for (const table of tables) {
      expect(JSON.stringify(await harness.db.all(sql`SELECT * FROM ${sql.identifier(table)}`))).not.toContain(
        token,
      );
    }
  });

  it('records views at most hourly', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token } = await share(harness, history);
    const firstView = harness.clock.iso();
    const lastViewed = async () => (await history.shareLinks.listShareLinks(history.deckId))[0]?.lastViewedAt;
    expect(await lastViewed()).toBe(firstView);
    harness.clock.advance(59 * 60);
    await openShared(harness, token);
    expect(await lastViewed()).toBe(firstView);
    harness.clock.advance(61);
    await openShared(harness, token);
    expect(await lastViewed()).toBe(harness.clock.iso());
  });

  it('sends no write at all for a view within the hour', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token } = await share(harness, history);
    // From now on, any write to the link fails (and is logged).
    await harness.db.run(
      sql.raw(
        "CREATE TRIGGER refuse_views BEFORE UPDATE ON share_links BEGIN SELECT RAISE(ABORT, 'no writes'); END",
      ),
    );
    const failedRecords = () =>
      harness.logger.entries.filter((entry) => entry.message === 'Could not record a share link view');
    harness.clock.advance(30 * 60);
    expect(await openShared(harness, token)).not.toBeNull();
    expect(failedRecords()).toEqual([]);
    harness.clock.advance(31 * 60);
    expect(await openShared(harness, token)).not.toBeNull();
    expect(failedRecords()).toHaveLength(1);
  });
});

describe('the shared deck', () => {
  it('shows the committed deck only: name, format and commanders of the latest version', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    const owners = defined(await history.services.getOverview(history.deckId));
    expect(owners.name).toBe('Blue Farm (secret tech)');

    const overview = defined(await viewer.getOverview());
    expect(Object.keys(overview).sort()).toEqual(
      ['id', 'source', 'name', 'format', 'commanders', 'head', 'versionCount', 'recentVersions'].sort(),
    );
    expect(overview).toMatchObject({
      id: history.deckId,
      name: 'Blue Farm',
      format: 'commander',
      commanders: ["Kraum, Ludevic's Opus", 'Tymna the Weaver'],
      head: { sequence: 2, message: 'Cut Dress Down' },
      versionCount: 2,
    });
    expect(overview.recentVersions.map((version) => [version.sequence, version.tags])).toEqual([
      [2, []],
      [1, ['tournament']],
    ]);
    expectNoUncommittedState(overview);
  });

  it('lists versions, also by tag', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    expect(await viewer.listVersions()).toEqual(await history.services.listVersions(history.deckId));
    expect((await viewer.listVersions({ tag: 'tournament' })).map((version) => version.sequence)).toEqual([
      1,
    ]);
    expect(await viewer.listVersions({ tag: 'nope' })).toEqual([]);
    expect(await viewer.listTags()).toEqual([{ name: 'tournament', count: 1 }]);
  });

  it('shows versions as the owner sees them, without notes unless the link includes them', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const owners = defined(await history.services.getVersion(history.deckId, 1));
    expect(owners.notes).toHaveLength(1);

    const withoutNotes = defined(await (await share(harness, history)).viewer.getVersion(1));
    expect(withoutNotes.notes).toEqual([]);
    expect(JSON.stringify(withoutNotes)).not.toContain('Top 4');
    // Everything but the deck summary, the notes and the source metadata (which names the
    // deck on Moxfield, see 'where the deck lives on Moxfield').
    const { deck: _ownersDeck, sourceMetadata: _sourceMetadata, ...ownersVersion } = owners;
    const { deck, ...version } = withoutNotes;
    expect(version).toEqual({ ...ownersVersion, notes: [] });
    expect(deck).toMatchObject({ name: 'Blue Farm', head: { sequence: 2 } });
    expectNoUncommittedState(withoutNotes);

    const withNotes = defined(
      await (await share(harness, history, { includeNotes: true })).viewer.getVersion(1),
    );
    expect(withNotes.notes).toEqual(owners.notes);

    const viewer = (await share(harness, history)).viewer;
    for (const sequence of [3, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await viewer.getVersion(sequence)).toBeNull();
    }
  });

  it('compares committed states and refuses the working state', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    const [v2, v1] = await history.services.listVersions(history.deckId);

    const compared = defined(await viewer.compare('v1', 'head'));
    expect(compared.from).toMatchObject({ kind: 'version', version: { sequence: 1 } });
    expect(compared.to).toMatchObject({ kind: 'version', version: { sequence: 2 } });
    expect(compared.hasWorking).toBe(false);
    expect(compared.versions.map((version) => version.sequence)).toEqual([2, 1]);
    expect(compared.diff).toEqual(defined(await history.services.compare(history.deckId, 'v1', 'v2')).diff);
    expectNoUncommittedState(compared);

    expect(defined(await viewer.compare('empty', '1')).from).toEqual({ kind: 'empty' });
    expect(
      defined(await viewer.compare(defined(v1).commitId.slice(0, 6), defined(v2).commitId)).to,
    ).toMatchObject({
      kind: 'version',
      version: { sequence: 2 },
    });
    for (const ref of ['working', 'WORKING', ' working ']) {
      expect(await viewer.compare('v1', ref)).toBeNull();
      expect(await viewer.compare(ref, 'head')).toBeNull();
    }
    expect(await viewer.compare('v1', 'v3')).toBeNull();
    expect(await viewer.compare('v1', 'nonsense')).toBeNull();
  });

  it('resolves no commit of another deck, in its own workspace or another', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    const sibling = await otherDeck(harness, history.services, 'OtherDeckTestDeck00001', ['Lightning Bolt']);
    const bob = await signUp(harness.auth, 'Bob');
    const bobs = await otherDeck(
      harness,
      harness.servicesForWorkspace(bob.user.workspaceId),
      'BobsDeckTestDeck000001',
      ['Lightning Bolt'],
    );

    for (const commitId of [sibling.commitId, bobs.commitId]) {
      for (const ref of [commitId, commitId.slice(0, 4), commitId.slice(0, 12)]) {
        expect(await viewer.compare(ref, 'head')).toBeNull();
        expect(await viewer.compare('empty', ref)).toBeNull();
      }
    }
    expect(await viewer.searchCards('Lightning')).toEqual([]);
    expect(await viewer.cardHistory('Lightning Bolt')).toBeNull();
    // The owner's own services find them, so the scenario is real.
    expect(await history.services.compare(sibling.deckId, sibling.commitId, 'head')).not.toBeNull();
  });

  it('searches the committed versions’ cards only', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    expect((await history.services.searchCards(history.deckId, 'Mystic')).map((hit) => hit.name)).toEqual([
      'Mystic Remnant',
    ]);

    expect(await viewer.searchCards('Mystic')).toEqual([]);
    expect(await viewer.searchCards('Thrasios')).toEqual([]);
    const [pyroclasm] = await viewer.searchCards('Pyroclasm');
    expect(pyroclasm).toMatchObject({
      name: 'Pyroclasm',
      headZones: [{ zone: 'sideboard', quantity: 1 }],
      versionsPresent: 2,
      lastSeenSequence: 2,
    });
    expect(await viewer.searchCards('Dress', 1000)).toHaveLength(1);
  });

  it('shows card history over the committed versions, never the working state', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    // The owner sees Pyroclasm cut in the working state; viewers only see v1 and v2.
    const owners = defined(await history.services.cardHistory(history.deckId, 'Pyroclasm'));
    expect(owners.history.entries.map((entry) => entry.sequence)).toEqual([1, 2, null]);

    const shared = defined(await viewer.cardHistory('Pyroclasm'));
    expect(shared.history.entries.map((entry) => entry.sequence)).toEqual([1, 2]);
    expect(shared.history.entries.every((entry) => entry.commitId !== null)).toBe(true);
    expect(shared.history.summary.currentZones).toEqual([{ zone: 'sideboard', quantity: 1 }]);
    expect(shared.history.name).toBe('Pyroclasm');
    expect(shared.deck).toMatchObject({ name: 'Blue Farm' });
    expectNoUncommittedState(shared);
    expect(await viewer.cardHistory('Mystic Remnant')).toBeNull();
    expect(await viewer.cardHistory('')).toBeNull();
  });

  it('exports committed versions for restoring', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    const owners = defined(await history.services.restoreExport(history.deckId, 1));
    const shared = defined(await viewer.restoreExport(1));
    // The same text, except that viewers restore into a deck of their own, not the owner's.
    const { instructions: ownersSteps, ...ownersExport } = owners.export;
    const { instructions: sharedSteps, ...sharedExport } = shared.export;
    expect(sharedExport).toEqual(ownersExport);
    expect(ownersSteps[0]).toMatch(/^Open the deck on Moxfield/);
    expect(sharedSteps[0]).toMatch(/^Open a deck of your own on Moxfield/);
    expect(sharedSteps.slice(1)).toEqual(ownersSteps.slice(1));
    expect(shared.version).toEqual(owners.version);
    expect(shared.deck.name).toBe('Blue Farm');
    for (const sequence of [3, 0, -2, Number.NaN]) expect(await viewer.restoreExport(sequence)).toBeNull();
  });

  it('never says where the deck lives on Moxfield, nor whose Moxfield account it is', async () => {
    // The deck's Moxfield URL opens its live state, uncommitted changes included, and for an
    // unlisted deck it is the only key to it; it would also outlive the share link.
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history, { includeNotes: true });
    const owners = defined(await history.services.getVersion(history.deckId, 2));
    const { externalId, url, internalId, authors } = owners.sourceMetadata;
    expect(externalId).toBe(blueFarmSpec().publicId);
    const secrets = [externalId, url, owners.deck.url, ...authors];
    if (internalId !== undefined) secrets.push(internalId);
    expect(authors.length).toBeGreaterThan(0);

    const restore = defined(await viewer.restoreExport(2));
    const answers: Record<string, unknown> = {
      overview: await viewer.getOverview(),
      versions: await viewer.listVersions(),
      version1: await viewer.getVersion(1),
      version2: await viewer.getVersion(2),
      compare: await viewer.compare('empty', 'head'),
      search: await viewer.searchCards('a'),
      cardHistory: await viewer.cardHistory('Dress Down'),
      restore,
      restoreText: restoreText(restore),
      tags: await viewer.listTags(),
    };
    for (const [name, answer] of Object.entries(answers)) {
      expect(answer, name).not.toBeNull();
      const text = JSON.stringify(answer);
      for (const secret of secrets) expect(text, `${name} contains ${secret}`).not.toContain(secret);
    }
  });

  it('converts primers like the owner’s services', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history);
    const owner = defined(await history.services.getVersion(history.deckId, 1));
    const shared = defined(await viewer.getVersion(1));
    expect(shared.primerMarkdown).toBe(owner.primerMarkdown);
    expect(shared.primerMarkdown).toContain('Mulligans');
    expect(shared.primerMarkdown).not.toContain('===panel');
  });

  it('is read-only by type and at runtime: viewing changes no deck data', async () => {
    expectTypeOf<SharedDeckServices>().not.toHaveProperty('commit');
    expectTypeOf<SharedDeckServices>().not.toHaveProperty('refresh');
    expectTypeOf<SharedDeckServices>().not.toHaveProperty('addTag');
    expectTypeOf<SharedDeckServices>().not.toHaveProperty('setNote');
    expectTypeOf<SharedDeckServices>().not.toHaveProperty('untrackDeck');
    expectTypeOf<SharedDeckServices['getVersion']>().parameters.toEqualTypeOf<[sequence: number]>();

    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { viewer } = await share(harness, history, { includeNotes: true });
    const writes = [
      'commit',
      'refresh',
      'ingestCapture',
      'trackDeck',
      'untrackDeck',
      'addTag',
      'removeTag',
      'setNote',
      'listDecks',
      'getSetupInfo',
    ];
    for (const name of writes) expect(name in viewer).toBe(false);

    const tables = [
      'decks',
      'branches',
      'commits',
      'observations',
      'version_tags',
      'commit_notes',
      'card_catalog',
    ];
    const dump = () =>
      Promise.all(tables.map((table) => harness.db.all(sql`SELECT * FROM ${sql.identifier(table)}`)));
    const before = await dump();
    harness.clock.advance(3600);
    await viewer.getOverview();
    await viewer.listVersions({ tag: 'tournament' });
    await viewer.getVersion(1);
    await viewer.compare('empty', 'head');
    await viewer.searchCards('a');
    await viewer.cardHistory('Dress Down');
    await viewer.restoreExport(2);
    await viewer.listTags();
    expect(await dump()).toEqual(before);
  });
});

describe('ending access', () => {
  /** Every method of `viewer`, answering as for a missing deck. */
  async function expectNoAccess(viewer: SharedDeckServices): Promise<void> {
    expect(await viewer.isAvailable()).toBe(false);
    expect(await viewer.getOverview()).toBeNull();
    expect(await viewer.listVersions()).toEqual([]);
    expect(await viewer.getVersion(1)).toBeNull();
    expect(await viewer.compare('v1', 'v2')).toBeNull();
    expect(await viewer.searchCards('Dress')).toEqual([]);
    expect(await viewer.cardHistory('Dress Down')).toBeNull();
    expect(await viewer.restoreExport(1)).toBeNull();
    expect(await viewer.listTags()).toEqual([]);
  }

  it('revoking the link ends it at once, for services obtained before too', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token, viewer, linkId } = await share(harness, history);
    expect(await viewer.isAvailable()).toBe(true);
    expect(await viewer.getOverview()).not.toBeNull();
    await history.shareLinks.revokeShareLink(history.deckId, linkId);
    expect(await openShared(harness, token)).toBeNull();
    await expectNoAccess(viewer);
  });

  it('untracking the deck ends every link to it', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token, viewer } = await share(harness, history);
    await history.services.untrackDeck(history.deckId);
    expect(await openShared(harness, token)).toBeNull();
    await expectNoAccess(viewer);
    expect(await countRows(harness.db, 'share_links')).toBe(0);

    // Tracking the same Moxfield deck again starts a new deck: old links stay dead.
    await history.services.trackDeck('https://moxfield.com/decks/' + blueFarmSpec().publicId);
    expect(await openShared(harness, token)).toBeNull();
  });

  it('disabling the owner suspends their links until they are enabled again', async () => {
    const harness = await createServiceHarness();
    const history = await sharedHistory(harness);
    const { token, viewer } = await share(harness, history);
    const admin = await signUp(harness.auth, 'Admin', { role: 'admin' });
    expect((await harness.auth.disableUser(admin.user, history.owner.user.id)).ok).toBe(true);
    expect(await openShared(harness, token)).toBeNull();
    await expectNoAccess(viewer);

    expect((await harness.auth.enableUser(admin.user, history.owner.user.id)).ok).toBe(true);
    expect(await openShared(harness, token)).not.toBeNull();
    expect(await viewer.isAvailable()).toBe(true);
    expect(await viewer.getOverview()).not.toBeNull();
  });
});
