import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { snapshotToFileTree } from '@/core/file-tree';
import type { CanonicalSnapshot } from '@/core/model';
import type { CommitRecord, DeckRecord, Repositories } from '@/server/repositories';
import {
  defaultExportDirectory,
  exportCommitMessage,
  exportDeckToGit,
  findDeckForExport,
  gitEnvironment,
  GitExportError,
  labelTagName,
  spawnGit,
  type GitExportErrorCode,
  type GitRunner,
} from '@/server/git-export';
import { baseDeckSpec, buildSnapshot } from '@tests/support/builders';
import { commitTestSnapshot, createTestDeck, createTestRepositories } from '@tests/support/db';

const gitAvailable = spawnSync('git', ['--version']).status === 0;

/** Runs git in an exported repository, isolated from the user's configuration. */
function git(dir: string, ...args: string[]): string {
  const result = spawnGit(args, { cwd: dir, env: gitEnvironment() });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

async function expectExportError(
  operation: Promise<unknown>,
  code: GitExportErrorCode,
): Promise<GitExportError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(GitExportError);
  expect(caught).toMatchObject({ code });
  return caught as GitExportError;
}

const V1 = buildSnapshot(baseDeckSpec());
/** v2: Dress Down moves to Considering, Mnemonic Betrayal comes in, the primer grows. */
const V2 = buildSnapshot({
  ...baseDeckSpec(),
  zones: {
    ...baseDeckSpec().zones,
    mainboard: [
      'Underworld Breach',
      "Thassa's Oracle",
      'Demonic Tutor',
      'Rhystic Study',
      '3 Island',
      'Sol Ring',
      'Mnemonic Betrayal',
    ],
    considering: ['Peer into the Abyss', 'Dress Down'],
  },
  primer: "# Blue Farm\n\nWin with Thassa's Oracle.\n\n## Mulligans\n\nKeep fast mana.\n",
});
/** v4: nothing in Considering any more, no primer. */
const V4 = buildSnapshot({
  ...baseDeckSpec(),
  zones: { ...baseDeckSpec().zones, considering: [] },
  primer: '',
});

describe.skipIf(!gitAvailable)('exportDeckToGit', () => {
  let workDir: string;
  let repos: Repositories;
  let deck: DeckRecord;
  let commits: CommitRecord[];

  async function commitVersion(
    snapshot: CanonicalSnapshot,
    message: string,
    createdAt: string,
    sourceVersion: number | null,
  ) {
    const commit = await commitTestSnapshot(repos, deck, snapshot, { message, createdAt, sourceVersion });
    commits.push(commit);
    return commit;
  }

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'git-moxfield-export-'));
    ({ repos } = await createTestRepositories());
    deck = await createTestDeck(repos, { externalId: 'ExportDeck000000000001', name: 'Blue Farm' });
    commits = [];
    await commitVersion(V1, 'Initial list', '2026-03-01T10:00:00.250Z', 100);
    await commitVersion(
      V2,
      'Test Mnemonic Betrayal\n\nDress Down to Considering.\r\n# not a comment',
      '2026-03-05T18:30:00.000Z',
      104,
    );
    // Same snapshot again (only the message differs): still one commit per version.
    await commitVersion(V2, 'Tournament list', '2026-03-07T09:00:00.000Z', null);
    await commitVersion(V4, '', '2026-04-01T12:00:00.000Z', 110);
    await repos.tags.add(commits[2]?.id ?? '', 'tournament');
    await repos.tags.add(commits[2]?.id ?? '', 'pre ban');
    await repos.tags.add(commits[3]?.id ?? '', 'v1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('replays the main lineage oldest to newest with messages, trailers, identity and dates', async () => {
    const outDir = join(workDir, 'repo');
    const result = await exportDeckToGit({
      repos,
      deckId: deck.id,
      outDir,
      now: () => new Date('2026-10-09T00:00:00Z'),
    });

    expect(result.outDir).toBe(outDir);
    expect(result.versions.map((version) => [version.sequence, version.commitId])).toEqual(
      commits.map((commit) => [commit.sequence, commit.id]),
    );
    expect(result.head).toBe(git(outDir, 'rev-parse', 'HEAD').trim());
    expect(git(outDir, 'symbolic-ref', 'HEAD').trim()).toBe('refs/heads/main');
    expect(git(outDir, 'status', '--porcelain')).toBe('');

    const log = git(
      outDir,
      'log',
      '--reverse',
      '--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%at%x1f%ct%x1f%B%x1e',
    )
      .split('\x1e')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.split('\x1f'));
    expect(log.map(([hash]) => hash)).toEqual(result.versions.map((version) => version.gitCommit));
    for (const [, author, committer] of log) {
      expect(author).toBe('git-moxfield <git-moxfield@localhost>');
      expect(committer).toBe('git-moxfield <git-moxfield@localhost>');
    }
    // Git keeps whole seconds: v1's 10:00:00.250 becomes 10:00:00.
    const seconds = (iso: string): string => String(Date.parse(iso) / 1000);
    expect(log.map(([, , , authorDate, committerDate]) => [authorDate, committerDate])).toEqual(
      ['2026-03-01T10:00:00Z', '2026-03-05T18:30:00Z', '2026-03-07T09:00:00Z', '2026-04-01T12:00:00Z'].map(
        (iso) => [seconds(iso), seconds(iso)],
      ),
    );
    expect(log.map(([, , , , , body]) => body)).toEqual([
      `Initial list\n\nGit-Moxfield-Version: v1\nGit-Moxfield-Commit: ${commits[0]?.id}\nMoxfield-Version: 100`,
      'Test Mnemonic Betrayal\n\nDress Down to Considering.\n# not a comment\n\n' +
        `Git-Moxfield-Version: v2\nGit-Moxfield-Commit: ${commits[1]?.id}\nMoxfield-Version: 104`,
      `Tournament list\n\nGit-Moxfield-Version: v3\nGit-Moxfield-Commit: ${commits[2]?.id}`,
      `Version v4\n\nGit-Moxfield-Version: v4\nGit-Moxfield-Commit: ${commits[3]?.id}\nMoxfield-Version: 110`,
    ]);
    expect(
      git(outDir, 'log', '-1', '--format=%(trailers:key=Git-Moxfield-Version,valueonly)', 'v2').trim(),
    ).toBe('v2');
  });

  it('commits exactly the snapshot file tree of every version and deletes files that disappear', async () => {
    const outDir = join(workDir, 'repo');
    await exportDeckToGit({ repos, deckId: deck.id, outDir });

    for (const [tag, snapshot] of [
      ['v1', V1],
      ['v2', V2],
      ['v3', V2],
      ['v4', V4],
    ] as const) {
      const tree = snapshotToFileTree(snapshot);
      expect(git(outDir, 'ls-tree', '--name-only', tag).trim().split('\n')).toEqual(Object.keys(tree));
      for (const [path, content] of Object.entries(tree))
        expect(git(outDir, 'show', `${tag}:${path}`)).toBe(content);
    }
    expect(git(outDir, 'show', 'v1:mainboard.txt')).toBe(snapshotToFileTree(V1)['mainboard.txt']);
    expect(git(outDir, 'show', 'HEAD:mainboard.txt')).toBe(snapshotToFileTree(V4)['mainboard.txt']);

    // Considering and the primer are gone at HEAD, in the tree and in the working directory.
    expect(existsSync(join(outDir, 'considering.txt'))).toBe(false);
    expect(existsSync(join(outDir, 'primer.md'))).toBe(false);
    expect(readdirSync(outDir).sort()).toEqual(['.git', ...Object.keys(snapshotToFileTree(V4))].sort());

    // v3 has the same tree as v2 but is still its own commit.
    expect(git(outDir, 'rev-parse', 'v3^{tree}')).toBe(git(outDir, 'rev-parse', 'v2^{tree}'));
    expect(git(outDir, 'rev-list', '--count', 'HEAD').trim()).toBe('4');
    expect(git(outDir, 'diff', '--name-status', 'v1', 'v2')).toBe(
      'M\tconsidering.txt\nM\tmainboard.txt\nM\tprimer.md\n',
    );
  });

  it('keeps the last captured primer.md through versions whose primer was not captured', async () => {
    const lineDeck = await createTestDeck(repos, {
      externalId: 'PrimerGapDeck000000001',
      name: 'Primer gap',
    });
    const primerA = '# Plan\n\nWin with the Oracle.\n';
    const primerB = '# Plan\n\nWin with the Oracle.\n\n## Mulligans\n\nKeep fast mana.\n';
    const at = (day: number): string => `2026-05-0${day}T12:00:00.000Z`;
    await commitTestSnapshot(
      repos,
      lineDeck,
      { ...V1, primer: primerA },
      {
        message: 'With primer',
        createdAt: at(1),
      },
    );
    // The primer request failed while a card moved: v2's primer is unknown, not deleted.
    await commitTestSnapshot(
      repos,
      lineDeck,
      { ...V2, primer: null },
      {
        message: 'Primer unavailable',
        createdAt: at(2),
      },
    );
    await commitTestSnapshot(
      repos,
      lineDeck,
      { ...V2, primer: primerB },
      {
        message: 'Primer edited',
        createdAt: at(3),
      },
    );
    const outDir = join(workDir, 'primer-gap');
    await exportDeckToGit({ repos, deckId: lineDeck.id, outDir });

    expect(git(outDir, 'log', '--reverse', '--format=%s', '--name-status', '--', 'primer.md')).toBe(
      'With primer\n\nA\tprimer.md\nPrimer edited\n\nM\tprimer.md\n',
    );
    expect(git(outDir, 'diff', 'v1', 'v2', '--', 'primer.md')).toBe('');
    expect(git(outDir, 'show', 'v2:primer.md')).toBe(primerA);
    expect(git(outDir, 'show', 'v2:deck.yaml')).toContain('\nprimer: unavailable\n');
    expect(git(outDir, 'diff', '--numstat', 'v2', 'v3', '--', 'primer.md')).toBe('4\t0\tprimer.md\n');
  });

  it('writes no primer.md for leading versions whose primer was never captured', async () => {
    const lineDeck = await createTestDeck(repos, {
      externalId: 'NoPrimerYetDeck0000001',
      name: 'No primer yet',
    });
    await commitTestSnapshot(
      repos,
      lineDeck,
      { ...V1, primer: null },
      {
        message: 'Pasted without primer',
        createdAt: '2026-05-01T12:00:00.000Z',
      },
    );
    const outDir = join(workDir, 'no-primer-yet');
    await exportDeckToGit({ repos, deckId: lineDeck.id, outDir });

    expect(git(outDir, 'ls-tree', '--name-only', 'v1')).not.toContain('primer.md');
    expect(git(outDir, 'show', 'v1:deck.yaml')).toContain('\nprimer: unavailable\n');
  });

  it('tags every version and every version tag with a valid ref name', async () => {
    const outDir = join(workDir, 'repo');
    const result = await exportDeckToGit({ repos, deckId: deck.id, outDir });

    expect(result.versions.map((version) => version.tags)).toEqual([
      ['v1'],
      ['v2'],
      ['v3', 'pre-ban/v3', 'tournament/v3'],
      ['v4', 'tag-v1/v4'],
    ]);
    expect(git(outDir, 'tag', '--list').trim().split('\n').sort()).toEqual(
      ['pre-ban/v3', 'tag-v1/v4', 'tournament/v3', 'v1', 'v2', 'v3', 'v4'].sort(),
    );
    // Lightweight tags point straight at the commits.
    expect(git(outDir, 'cat-file', '-t', 'tournament/v3').trim()).toBe('commit');
    expect(git(outDir, 'rev-parse', 'tournament/v3').trim()).toBe(result.versions[2]?.gitCommit);
    expect(result.warnings).toEqual([]);
  });

  it('exports version tags whose ref names collide under numbered names, with warnings', async () => {
    const v2 = commits[1]?.id ?? '';
    for (const tag of ['pre ban', 'pre-ban', 'stable', 'stable.', 'a..b', 'a.b', 'a.b-2'])
      await repos.tags.add(v2, tag);
    const outDir = join(workDir, 'repo');
    const result = await exportDeckToGit({ repos, deckId: deck.id, outDir });

    // Tags that are valid ref names as they are keep their names; the others are numbered.
    expect(result.versions[1]?.tags).toEqual([
      'v2',
      'a.b-3/v2',
      'a.b/v2',
      'a.b-2/v2',
      'pre-ban-2/v2',
      'pre-ban/v2',
      'stable/v2',
      'stable-2/v2',
    ]);
    expect(git(outDir, 'tag', '--list', '*/v2').trim().split('\n').sort()).toEqual(
      ['a.b-2/v2', 'a.b-3/v2', 'a.b/v2', 'pre-ban-2/v2', 'pre-ban/v2', 'stable-2/v2', 'stable/v2'].sort(),
    );
    expect(result.warnings).toEqual([
      'Exported version tag "a..b" of v2 as "a.b-3/v2", because "a.b/v2" is taken by "a.b".',
      'Exported version tag "pre ban" of v2 as "pre-ban-2/v2", because "pre-ban/v2" is taken by "pre-ban".',
      'Exported version tag "stable." of v2 as "stable-2/v2", because "stable/v2" is taken by "stable".',
    ]);
    // Version tags of other versions are unaffected.
    expect(result.versions[2]?.tags).toEqual(['v3', 'pre-ban/v3', 'tournament/v3']);
  });

  it('records which deck a repository is an export of and refuses to export into it again', async () => {
    const outDir = join(workDir, 'repo');
    await exportDeckToGit({ repos, deckId: deck.id, outDir, now: () => new Date('2026-10-09T00:00:00Z') });
    expect(git(outDir, 'config', '--get', 'gitMoxfield.deck').trim()).toBe('moxfield:ExportDeck000000000001');
    expect(git(outDir, 'config', '--get', 'gitMoxfield.exportedAt').trim()).toBe('2026-10-09T00:00:00.000Z');
    expect(readFileSync(join(outDir, '.git', 'description'), 'utf8')).toBe(
      'git-moxfield export of Blue Farm (moxfield:ExportDeck000000000001)\n',
    );

    const head = git(outDir, 'rev-parse', 'HEAD');
    const error = await expectExportError(
      exportDeckToGit({ repos, deckId: deck.id, outDir }),
      'already-exported',
    );
    expect(error.message).toContain('fresh directory');
    expect(git(outDir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('exports into an existing empty directory but refuses other non-empty directories untouched', async () => {
    const empty = join(workDir, 'empty');
    mkdirSync(empty);
    expect((await exportDeckToGit({ repos, deckId: deck.id, outDir: empty })).versions).toHaveLength(4);

    const occupied = join(workDir, 'occupied');
    mkdirSync(occupied);
    writeFileSync(join(occupied, 'notes.txt'), 'mine');
    await expectExportError(
      exportDeckToGit({ repos, deckId: deck.id, outDir: occupied }),
      'target-not-empty',
    );
    expect(readdirSync(occupied)).toEqual(['notes.txt']);

    const file = join(workDir, 'file');
    writeFileSync(file, '');
    await expectExportError(exportDeckToGit({ repos, deckId: deck.id, outDir: file }), 'invalid-target');
  });

  it('refuses unknown decks and decks without versions before writing anything', async () => {
    const outDir = join(workDir, 'repo');
    await expectExportError(exportDeckToGit({ repos, deckId: 'no-such-deck', outDir }), 'deck-not-found');
    const fresh = await createTestDeck(repos);
    await expectExportError(exportDeckToGit({ repos, deckId: fresh.id, outDir }), 'no-versions');
    expect(existsSync(outDir)).toBe(false);
  });

  it('removes a partially written export when git fails', async () => {
    const outDir = join(workDir, 'repo');
    let commitsMade = 0;
    const failingGit: GitRunner = (args, options) => {
      if (args[0] === 'commit' && ++commitsMade === 3)
        return { status: 128, stdout: '', stderr: 'fatal: disk full' };
      return spawnGit(args, options);
    };
    const error = await expectExportError(
      exportDeckToGit({ repos, deckId: deck.id, outDir, git: failingGit }),
      'git-failed',
    );
    expect(error.message).toContain('fatal: disk full');
    expect(existsSync(outDir)).toBe(false);

    const empty = join(workDir, 'empty');
    mkdirSync(empty);
    commitsMade = 0;
    await expectExportError(
      exportDeckToGit({ repos, deckId: deck.id, outDir: empty, git: failingGit }),
      'git-failed',
    );
    expect(readdirSync(empty)).toEqual([]);
  });

  it('reports a missing git executable without touching the target', async () => {
    const outDir = join(workDir, 'repo');
    const missingGit: GitRunner = () => {
      throw new GitExportError('git-unavailable', 'Could not run git: spawn git ENOENT');
    };
    await expectExportError(
      exportDeckToGit({ repos, deckId: deck.id, outDir, git: missingGit }),
      'git-unavailable',
    );
    expect(existsSync(outDir)).toBe(false);
  });

  it('ignores GIT_* variables of the surrounding environment, such as those set inside git hooks', async () => {
    const decoy = join(workDir, 'decoy');
    vi.stubEnv('GIT_DIR', join(decoy, '.git'));
    vi.stubEnv('GIT_INDEX_FILE', join(decoy, 'index'));
    vi.stubEnv('GIT_AUTHOR_NAME', 'Someone Else');
    const outDir = join(workDir, 'repo');
    await exportDeckToGit({ repos, deckId: deck.id, outDir });
    vi.unstubAllEnvs();

    expect(existsSync(decoy)).toBe(false);
    expect(git(outDir, 'log', '-1', '--format=%an').trim()).toBe('git-moxfield');
  });
});

describe('git export helpers', () => {
  it('builds commit messages with trailers and a fallback subject', () => {
    expect(
      exportCommitMessage({
        id: 'abc',
        sequence: 3,
        message: '\n\nCut Dress Down  \r\n\r\n',
        sourceVersion: 7,
      }),
    ).toBe('Cut Dress Down\n\nGit-Moxfield-Version: v3\nGit-Moxfield-Commit: abc\nMoxfield-Version: 7\n');
    expect(exportCommitMessage({ id: 'abc', sequence: 1, message: '   ', sourceVersion: null })).toBe(
      'Version v1\n\nGit-Moxfield-Version: v1\nGit-Moxfield-Commit: abc\n',
    );
  });

  it.each([
    ['tournament', 'tournament/v2'],
    ['pre ban', 'pre-ban/v2'],
    ['  spaced   out ', 'spaced-out/v2'],
    ['.hidden', 'hidden/v2'],
    ['ends.', 'ends/v2'],
    ['a..b', 'a.b/v2'],
    ['x.lock', 'x-lock/v2'],
    ['v12', 'tag-v12/v2'],
    ['ünïcödé', 'ünïcödé/v2'],
    ['a/b:c?d*e[f\\g~h^i', 'a-b-c-d-e-f-g-h-i/v2'],
    ['...', 'tag/v2'],
  ])('turns the version tag %j into the Git tag %j', (tag, expected) => {
    expect(labelTagName(tag, 2)).toBe(expected);
  });

  it('finds decks by id, Moxfield id or URL', async () => {
    const { repos } = await createTestRepositories();
    const deck = await createTestDeck(repos, { externalId: 'FindMe0000000000000001' });
    expect((await findDeckForExport(repos, deck.id))?.id).toBe(deck.id);
    expect((await findDeckForExport(repos, ' FindMe0000000000000001 '))?.id).toBe(deck.id);
    expect(
      (await findDeckForExport(repos, 'https://moxfield.com/decks/FindMe0000000000000001/primer'))?.id,
    ).toBe(deck.id);
    expect(
      (
        await findDeckForExport(repos, 'http://localhost:4010/decks/FindMe0000000000000001', {
          siteOrigins: ['http://localhost:4010'],
        })
      )?.id,
    ).toBe(deck.id);
    expect(await findDeckForExport(repos, 'https://example.com/decks/FindMe0000000000000001')).toBeNull();
    expect(await findDeckForExport(repos, 'Unknown000000000000001')).toBeNull();
    expect(await findDeckForExport(repos, '')).toBeNull();
  });

  it('derives the default export directory from the deck id', () => {
    expect(defaultExportDirectory({ externalId: 'MockBlueFarm0000000001' })).toBe(
      join('export', 'MockBlueFarm0000000001'),
    );
    expect(defaultExportDirectory({ externalId: '../evil' })).toBe(join('export', '___evil'));
  });

  it('strips GIT_* variables and isolates git from user configuration', () => {
    const env = gitEnvironment({ PATH: '/bin', GIT_DIR: '/x', git_index_file: '/y', HOME: '/home/me' });
    expect(env).toMatchObject({
      PATH: '/bin',
      HOME: '/home/me',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.git_index_file).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeTruthy();
  });
});
