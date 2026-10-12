/**
 * The Moxfield HTTP client is the single choke point for server-side requests to Moxfield,
 * and every request it sends was admitted by the installation-wide request limiter
 * (ADR 0009). This test fails when a call path bypasses it:
 *
 * - statically: no server code but `http-client.ts` makes HTTP requests, only the deck
 *   source builds the client, and only the source registry builds the deck source (with
 *   the limiter it requires);
 * - at run time: through every service that fetches (track, refresh, fetch-on-commit,
 *   relink, retries, primer), each request reaching the fake Moxfield was admitted by the
 *   limiter first, and none is sent while the limiter refuses.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DeckSourceError } from '@/integrations/deck-source';
import type { DatabaseMoxfieldLimiter } from '@/server/moxfield-limiter';
import {
  blueFarmSpec,
  BLUE_FARM_URL,
  commitReviewed,
  committed,
  createServiceHarness,
  publishAndRefresh,
} from '@tests/support/services';

const ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(ROOT, path)] : [];
  });
}

const FILES = [...sourceFiles(join(ROOT, 'src')), ...sourceFiles(join(ROOT, 'scripts'))];

/** Files whose code matches `pattern`, comments stripped. */
function filesMatching(pattern: RegExp): string[] {
  return FILES.filter((file) => {
    const code = readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return pattern.test(code);
  }).sort();
}

describe('the Moxfield HTTP client is the only way to Moxfield', () => {
  it('is the only server code that makes HTTP requests', () => {
    expect(
      filesMatching(/(?<![\w.])fetch\s*\(|globalThis\.fetch|XMLHttpRequest|from 'node:https?'|from 'undici'/),
    ).toEqual([
      // Client component: posts captures to git-moxfield's own API.
      'src/components/capture/capture-api.ts',
      // The bookmarklet's source, which runs in the user's browser on moxfield.com.
      'src/integrations/moxfield/capture.ts',
      // The choke point.
      'src/integrations/moxfield/http-client.ts',
    ]);
  });

  it('is built only by the deck source, which only the registry builds, always with a limiter', () => {
    expect(filesMatching(/new MoxfieldHttpClient\b/)).toEqual([
      'src/integrations/moxfield/moxfield-deck-source.ts',
    ]);
    expect(filesMatching(/new MoxfieldDeckSource\b/)).toEqual(['src/server/sources.ts']);
    expect(filesMatching(/new DatabaseMoxfieldLimiter\b/)).toEqual([
      'scripts/moxfield.ts',
      'src/server/sources.ts',
    ]);
  });
});

/** Counts what the limiter admitted; `refuse` makes it refuse every request. */
function countAdmissions(limiter: DatabaseMoxfieldLimiter): { admitted: () => number; refuse: () => void } {
  let admitted = 0;
  let refusing = false;
  const admit = limiter.admit.bind(limiter);
  limiter.admit = async (signal) => {
    if (refusing) throw new DeckSourceError('unavailable', 'refused by the test', { source: 'moxfield' });
    await admit(signal);
    admitted += 1;
  };
  return {
    admitted: () => admitted,
    refuse: () => {
      refusing = true;
    },
  };
}

describe('every request the services send is admitted by the limiter first', () => {
  it('for tracking, refreshing, retrying, fetch-on-commit and relinking', async () => {
    const harness = await createServiceHarness();
    const { services, api, moxfieldLimiter } = harness;
    const counter = countAdmissions(moxfieldLimiter);
    api.setDeck(blueFarmSpec());

    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    const { deckId } = tracked;
    await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 2 }));
    committed(await commitReviewed(harness, deckId, 'v1'));
    api.mode = 'primer-down'; // 503 and its retry
    await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 3 }));
    api.mode = 'down';
    await publishAndRefresh(harness, deckId, blueFarmSpec({ version: 4 }));
    api.mode = 'ok';
    const other = blueFarmSpec({ publicId: 'RelinkTargetDeck000001', name: 'Relinked' });
    api.setDeck(other);
    harness.clock.advance(60);
    expect(await services.relinkDeck(deckId, `https://moxfield.com/decks/${other.publicId}`)).toMatchObject({
      ok: true,
    });

    expect(api.requests.length).toBeGreaterThan(8);
    expect(counter.admitted()).toBe(api.requests.length);
  });

  it('sends nothing on any path while the limiter refuses', async () => {
    const harness = await createServiceHarness();
    const { services, api, moxfieldLimiter } = harness;
    api.setDeck(blueFarmSpec());
    const tracked = await services.trackDeck(BLUE_FARM_URL);
    if (!tracked.ok) throw new Error(tracked.reason);
    const before = api.requests.length;
    const counter = countAdmissions(moxfieldLimiter);
    counter.refuse();

    await publishAndRefresh(harness, tracked.deckId, blueFarmSpec({ version: 2 }));
    expect(committed(await commitReviewed(harness, tracked.deckId, 'v1')).sequence).toBe(1);
    const other = blueFarmSpec({ publicId: 'AnotherDeckToTrack0001', name: 'Another' });
    api.setDeck(other);
    await services.trackDeck(`https://moxfield.com/decks/${other.publicId}`);
    expect(api.requests).toHaveLength(before);
  });
});
