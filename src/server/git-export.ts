/**
 * One-way export of a deck's version history into a real Git repository (ADR 0003).
 *
 * The main-branch lineage is replayed oldest → newest into a new repository: every
 * version becomes one commit whose tree is `snapshotToFileTree(snapshot)`
 * (`deck.yaml`, `mainboard.txt`, `primer.md`, ...), with the version's message, its
 * timestamp as author and committer date, and trailers linking back to git-moxfield.
 * A version whose primer was not captured keeps the previous version's primer.md (its
 * deck.yaml says `primer: unavailable`), so an unknown primer never reads as deleted.
 * Versions with an identical tree are still committed, so `vN` maps 1:1 to commits.
 * Lightweight tags `v<N>` mark every version and `<tag>/v<N>` every version tag
 * (`<tag>-2/v<N>`, with a warning, when two version tags map to the same name).
 *
 * Git runs as a child process without a shell, isolated from the user's Git
 * configuration and from `GIT_*` environment variables, so the result depends only on
 * the deck history (no signing prompts, hooks, CRLF conversion or redirected repos).
 * An export never touches existing data: it refuses non-empty target directories and
 * removes what it wrote if it fails halfway.
 */
import 'server-only';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join, resolve } from 'node:path';

import { snapshotToFileTree, type FileTree } from '@/core/file-tree';
import { deckReference } from '@/core/hash';
import { DEFAULT_MOXFIELD_SITE_ORIGIN } from '@/integrations/moxfield/constants';
import { parseMoxfieldDeckInput } from '@/integrations/moxfield/url';
import type { CommitRecord, DeckLocation, DeckRecord, Repositories } from '@/server/repositories';

/** Author and committer of every exported commit. */
export const EXPORT_AUTHOR = { name: 'git-moxfield', email: 'git-moxfield@localhost' } as const;

/** Branch the exported history is written to. */
export const EXPORT_BRANCH = 'main';

/** Git config key marking a repository as an export of a deck (value: `<source>:<externalId>`). */
export const EXPORT_MARKER_KEY = 'gitMoxfield.deck';

/** Environment variables of a git process. */
export type GitEnvironment = Readonly<Record<string, string | undefined>>;

export interface GitRunOptions {
  cwd: string;
  env: GitEnvironment;
  /** Written to the process's stdin. */
  input?: string;
}

export interface GitRunResult {
  /** Exit code; non-zero (or a signal) means failure. */
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `git` with the given arguments (never through a shell).
 * @throws {GitExportError} `git-unavailable` when git cannot be started at all.
 */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => GitRunResult;

export type GitExportErrorCode =
  /** No deck with this id. */
  | 'deck-not-found'
  /** The deck has no versions on its main branch. */
  | 'no-versions'
  /** The target exists but is not a directory. */
  | 'invalid-target'
  /** The target directory has content that is not an export of this deck. */
  | 'target-not-empty'
  /** The target directory already holds an export of this deck. */
  | 'already-exported'
  /** The `git` executable could not be run. */
  | 'git-unavailable'
  /** A git command failed. */
  | 'git-failed'
  /** The stored history is inconsistent (missing snapshot, invalid timestamp). */
  | 'corrupt-history';

export class GitExportError extends Error {
  override readonly name = 'GitExportError';
  readonly code: GitExportErrorCode;

  constructor(code: GitExportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export interface ExportedVersion {
  /** `vN` → N. */
  sequence: number;
  /** git-moxfield commit id. */
  commitId: string;
  /** Git commit hash in the exported repository. */
  gitCommit: string;
  /** Git tags pointing at the commit, e.g. `['v3', 'tournament/v3']`. */
  tags: string[];
}

export interface ExportResult {
  /** Absolute path of the new repository. */
  outDir: string;
  deck: Pick<DeckRecord, 'id' | 'source' | 'externalId' | 'name'>;
  /** Oldest first. */
  versions: ExportedVersion[];
  /** Git hash of the newest commit (`main`). */
  head: string;
  /**
   * Problems that did not stop the export, e.g. a version tag with no valid ref name, or
   * one exported under a numbered name because another version tag has its name.
   */
  warnings: string[];
}

export interface ExportDeckToGitOptions {
  repos: Repositories;
  deckId: string;
  /** Directory of the new repository. Created when missing; must be empty otherwise. */
  outDir: string;
  /** Default: {@link spawnGit}. */
  git?: GitRunner;
  /** Clock for the export timestamp recorded in the repository's config. Default: system time. */
  now?: () => Date;
}

/** {@link GitRunner} backed by `child_process.spawnSync`. */
export const spawnGit: GitRunner = (args, { cwd, env, input }) => {
  const result = spawnSync('git', args, {
    cwd,
    // `NodeJS.ProcessEnv` is augmented with a required NODE_ENV; git does not need it.
    env: env as NodeJS.ProcessEnv,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new GitExportError('git-unavailable', `Could not run git: ${result.error.message}`, {
      cause: result.error,
    });
  }
  const stderr = result.signal === null ? result.stderr : `${result.stderr}\n(killed by ${result.signal})`;
  return { status: result.status ?? 1, stdout: result.stdout, stderr };
};

/**
 * The environment every git command runs with: the process environment without any
 * `GIT_*` variable (`GIT_DIR` or `GIT_INDEX_FILE` from a surrounding hook would redirect
 * writes into another repository), with system and global config disabled, and with a
 * fixed identity.
 */
export function gitEnvironment(base: GitEnvironment = process.env): GitEnvironment {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.toUpperCase().startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: EXPORT_AUTHOR.name,
    GIT_AUTHOR_EMAIL: EXPORT_AUTHOR.email,
    GIT_COMMITTER_NAME: EXPORT_AUTHOR.name,
    GIT_COMMITTER_EMAIL: EXPORT_AUTHOR.email,
  };
}

/**
 * The Git commit message of a version: its message (line endings normalized, surrounding
 * blank lines trimmed; `Version vN` when empty), a blank line, and trailers
 * `Git-Moxfield-Version`, `Git-Moxfield-Commit` and, when known, `Moxfield-Version`.
 */
export function exportCommitMessage(
  commit: Pick<CommitRecord, 'id' | 'sequence' | 'message' | 'sourceVersion'>,
): string {
  const message = commit.message.replace(/\r\n?/g, '\n').replace(/^\s*\n|\s+$/g, '');
  const trailers = [`Git-Moxfield-Version: v${commit.sequence}`, `Git-Moxfield-Commit: ${commit.id}`];
  if (commit.sourceVersion !== null) trailers.push(`Moxfield-Version: ${commit.sourceVersion}`);
  return `${message === '' ? `Version v${commit.sequence}` : message}\n\n${trailers.join('\n')}\n`;
}

/** Lightweight tag name of a version: `v<N>`. */
export function versionTagName(sequence: number): string {
  return `v${sequence}`;
}

/**
 * Git tag name for a version tag: `<tag>/v<N>`, with the tag turned into a valid ref
 * component (whitespace and characters Git forbids become `-`, no `..`, no leading or
 * trailing `.`, no `.lock` suffix). A tag that looks like a version tag (`v12`) is
 * prefixed with `tag-`, because `refs/tags/v12` and `refs/tags/v12/v3` cannot coexist.
 * Different tags can map to the same name; {@link labelTagNames} keeps them apart.
 */
export function labelTagName(tag: string, sequence: number): string {
  let component = tag
    .normalize('NFC')
    .replace(/[\s\u0000-\u001f\u007f~^:?*[\\/]+/gu, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/@\{/g, '@-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/\.lock$/i, '-lock');
  if (component === '' || component === '@') component = 'tag';
  if (/^v\d+$/i.test(component)) component = `tag-${component}`;
  return `${component}/${versionTagName(sequence)}`;
}

/** Git tag name of one version tag of a version, see {@link labelTagNames}. */
export interface LabelTagName {
  label: string;
  /** The exported name. */
  name: string;
  /** {@link labelTagName} of the label; differs from `name` when another tag took it. */
  preferred: string;
  /** The label that took `preferred`, when `name` differs from it. */
  takenBy?: string;
}

/**
 * Distinct Git tag names for the version tags of one version, in the order of `labels`.
 * Different tags can share a {@link labelTagName} (`pre ban` and `pre-ban` both become
 * `pre-ban/v3`). Tags that are valid ref components as they are keep their name; every
 * other tag whose name is taken gets the first free numbered one (`pre-ban-2/v3`).
 * Deterministic for the same set of labels in the same order.
 */
export function labelTagNames(labels: readonly string[], sequence: number): LabelTagName[] {
  const version = versionTagName(sequence);
  const entries = labels.map((label) => ({ label, preferred: labelTagName(label, sequence) }));
  const isExact = ({ label, preferred }: { label: string; preferred: string }): boolean =>
    preferred === `${label}/${version}`;
  const owners = new Map<string, string>();
  const names = new Map<string, string>();
  for (const { label, preferred } of [...entries.filter(isExact), ...entries.filter((e) => !isExact(e))]) {
    // `labelTagName` never ends the tag part with `.`, `-` or `.lock`, so a `-<n>`
    // suffix keeps the name valid; `/v<N>` stays last.
    let name = preferred;
    for (let n = 2; owners.has(name); n++)
      name = `${preferred.slice(0, -version.length - 1)}-${n}/${version}`;
    owners.set(name, label);
    names.set(label, name);
  }
  return entries.map(({ label, preferred }) => {
    const name = names.get(label) ?? preferred;
    return name === preferred
      ? { label, name, preferred }
      : { label, name, preferred, takenBy: owners.get(preferred) };
  });
}

/** Default export directory of a deck, relative to the working directory: `export/<externalId>`. */
export function defaultExportDirectory(deck: Pick<DeckRecord, 'externalId'>): string {
  return join('export', deck.externalId.replace(/[^A-Za-z0-9_-]/g, '_'));
}

/**
 * Resolves what a user typed on the command line to a tracked deck: a git-moxfield deck
 * id, a Moxfield public deck id, or a Moxfield deck URL on one of `siteOrigins`
 * (default: moxfield.com). Returns `null` when nothing matches.
 */
export async function findDeckForExport(
  repos: Repositories,
  reference: string,
  options: { siteOrigins?: readonly string[] } = {},
): Promise<DeckRecord | null> {
  const input = reference.trim();
  if (input === '') return null;
  const byId = await repos.decks.getById(input);
  if (byId) return byId;
  for (const origin of options.siteOrigins ?? [DEFAULT_MOXFIELD_SITE_ORIGIN]) {
    const parsed = parseMoxfieldDeckInput(input, origin);
    if (!parsed.ok) continue;
    const deck = await repos.decks.getBySourceExternal(parsed.ref.source, parsed.ref.externalId);
    if (deck) return deck;
  }
  return null;
}

/**
 * Like {@link findDeckForExport}, but across every workspace (for the command line, which
 * acts for the operator, not for a user): the decks a reference names, with their
 * workspace and owner. A git-moxfield deck id names one deck; a Moxfield deck id or URL
 * names every user's copy of that Moxfield deck.
 */
export async function locateDecksForExport(
  repos: Repositories,
  reference: string,
  options: { siteOrigins?: readonly string[] } = {},
): Promise<DeckLocation[]> {
  const input = reference.trim();
  if (input === '') return [];
  const byId = await repos.workspaces.locateDeck(input);
  if (byId) return [byId];
  for (const origin of options.siteOrigins ?? [DEFAULT_MOXFIELD_SITE_ORIGIN]) {
    const parsed = parseMoxfieldDeckInput(input, origin);
    if (!parsed.ok) continue;
    const decks = await repos.workspaces.locateDecksBySource(parsed.ref.source, parsed.ref.externalId);
    if (decks.length > 0) return decks;
  }
  return [];
}

interface PlannedVersion {
  commit: CommitRecord;
  tree: FileTree;
  labels: string[];
}

/** Reads everything the export needs before anything is written. */
async function planExport(
  repos: Repositories,
  deckId: string,
): Promise<{ deck: DeckRecord; versions: PlannedVersion[] }> {
  const [deck, main] = await Promise.all([repos.decks.getById(deckId), repos.branches.getMain(deckId)]);
  if (!deck) throw new GitExportError('deck-not-found', `No deck with id ${deckId}`);
  const head = main?.headCommitId ?? null;
  if (head === null) {
    throw new GitExportError('no-versions', `${deck.name} has no versions yet; commit one before exporting.`);
  }
  const lineage = await repos.commits.lineage(deck.id, head);
  if (lineage.length === 0) {
    throw new GitExportError(
      'corrupt-history',
      `The main branch of ${deck.name} points at an unknown version`,
    );
  }
  const [snapshots, labels] = await Promise.all([
    repos.snapshots.getMany(lineage.map((commit) => commit.snapshotHash)),
    repos.tags.listForCommits(lineage.map((commit) => commit.id)),
  ]);
  // An uncaptured primer (null) is unknown, not deleted: keep the last captured primer.md.
  let knownPrimer = '';
  const versions = lineage.map((commit): PlannedVersion => {
    const snapshot = snapshots.get(commit.snapshotHash);
    if (!snapshot) {
      throw new GitExportError(
        'corrupt-history',
        `Snapshot ${commit.snapshotHash} of v${commit.sequence} is missing from the database`,
      );
    }
    if (snapshot.primer !== null) knownPrimer = snapshot.primer;
    return {
      commit,
      tree: snapshotToFileTree(snapshot, { unknownPrimer: knownPrimer }),
      labels: labels.get(commit.id) ?? [],
    };
  });
  return { deck, versions };
}

/** Exported file names are flat, so a tree can never write outside the repository or into `.git`. */
function assertSafeFileName(path: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)) {
    throw new GitExportError(
      'corrupt-history',
      `Refusing to write unexpected file name ${JSON.stringify(path)}`,
    );
  }
}

/** Makes the working tree equal to `tree`, given that it currently equals `previous`. */
function writeTree(dir: string, tree: FileTree, previous: FileTree): void {
  for (const path of Object.keys(previous)) {
    if (!Object.hasOwn(tree, path)) rmSync(join(dir, path), { force: true });
  }
  for (const [path, content] of Object.entries(tree)) {
    assertSafeFileName(path);
    if (previous[path] !== content) writeFileSync(join(dir, path), content, 'utf8');
  }
}

/** Git's raw date format (`@<epoch seconds> +0000`); sub-second precision is dropped. */
function gitDate(iso: string, sequence: number): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new GitExportError(
      'corrupt-history',
      `v${sequence} has an invalid timestamp ${JSON.stringify(iso)}`,
    );
  }
  return `@${Math.floor(ms / 1000)} +0000`;
}

/** Git commands bound to one directory and the isolated environment. */
class GitRepository {
  private readonly env = gitEnvironment();

  constructor(
    private readonly runner: GitRunner,
    readonly dir: string,
  ) {}

  /**
   * Runs a command and returns its stdout.
   * @throws {GitExportError} `git-failed` on a non-zero exit code.
   */
  run(args: readonly string[], options: { input?: string; env?: GitEnvironment } = {}): string {
    const result = this.attempt(args, options);
    if (result.status !== 0) {
      const detail = (result.stderr.trim() || result.stdout.trim() || 'no output').slice(0, 2000);
      throw new GitExportError(
        'git-failed',
        `git ${args.join(' ')} failed with exit code ${result.status}: ${detail}`,
      );
    }
    return result.stdout;
  }

  /** Runs a command and returns the raw result, whatever its exit code. */
  attempt(args: readonly string[], options: { input?: string; env?: GitEnvironment } = {}): GitRunResult {
    return this.runner(args, { cwd: this.dir, env: { ...this.env, ...options.env }, input: options.input });
  }

  isValidTagName(name: string): boolean {
    return this.attempt(['check-ref-format', `refs/tags/${name}`]).status === 0;
  }
}

/** Reads the export marker of an existing repository at `dir`, or `null`. */
function readExportMarker(git: GitRepository): string | null {
  const configFile = join(git.dir, '.git', 'config');
  if (!existsSync(configFile)) return null;
  const result = git.attempt(['config', '--file', configFile, '--get', EXPORT_MARKER_KEY]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * Makes sure `outDir` is a new or empty directory.
 * @returns whether the directory was created by this call (for cleanup on failure).
 */
function prepareTarget(git: GitRepository, deckRef: string): boolean {
  const outDir = git.dir;
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
    return true;
  }
  if (!statSync(outDir).isDirectory()) {
    throw new GitExportError('invalid-target', `${outDir} exists and is not a directory.`);
  }
  if (readdirSync(outDir).length === 0) return false;
  if (readExportMarker(git) === deckRef) {
    throw new GitExportError(
      'already-exported',
      `${outDir} already contains an export of ${deckRef}. Exports are never updated in place: ` +
        'export into a fresh directory, or delete this one first.',
    );
  }
  throw new GitExportError(
    'target-not-empty',
    `${outDir} is not empty. Export into a new or empty directory.`,
  );
}

/** Removes everything an aborted export wrote. The directory was new or empty before. */
function cleanUp(outDir: string, created: boolean): void {
  if (created) {
    rmSync(outDir, { recursive: true, force: true });
    return;
  }
  for (const entry of readdirSync(outDir)) rmSync(join(outDir, entry), { recursive: true, force: true });
}

function writeHistory(
  git: GitRepository,
  deck: DeckRecord,
  versions: readonly PlannedVersion[],
  exportedAt: Date,
): { exported: ExportedVersion[]; warnings: string[] } {
  const deckRef = deckReference(deck);
  git.run(['init', '--quiet', '--template=', '.']);
  git.run(['symbolic-ref', 'HEAD', `refs/heads/${EXPORT_BRANCH}`]);
  git.run(['config', EXPORT_MARKER_KEY, deckRef]);
  git.run(['config', 'gitMoxfield.deckId', deck.id]);
  git.run(['config', 'gitMoxfield.exportedAt', exportedAt.toISOString()]);
  writeFileSync(
    join(git.dir, '.git', 'description'),
    `git-moxfield export of ${deck.name} (${deckRef})\n`,
    'utf8',
  );

  const exported: ExportedVersion[] = [];
  const warnings: string[] = [];
  const tags = new Map<string, string>();
  let previous: FileTree = {};
  for (const { commit, tree, labels } of versions) {
    writeTree(git.dir, tree, previous);
    previous = tree;
    git.run(['add', '--all', '.']);
    const date = gitDate(commit.createdAt, commit.sequence);
    git.run(
      [
        'commit',
        '--quiet',
        '--allow-empty',
        '--no-verify',
        '--no-gpg-sign',
        '--cleanup=verbatim',
        '--file=-',
      ],
      {
        input: exportCommitMessage(commit),
        env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      },
    );
    const gitCommit = git.run(['rev-parse', '--verify', 'HEAD^{commit}']).trim();

    const versionTags: string[] = [];
    const labelNames = labelTagNames(labels, commit.sequence);
    for (const { label, name, preferred, takenBy } of labelNames) {
      if (name === preferred) continue;
      warnings.push(
        `Exported version tag ${JSON.stringify(label)} of v${commit.sequence} as ${JSON.stringify(name)}, ` +
          `because ${JSON.stringify(preferred)} is taken by ${JSON.stringify(takenBy)}.`,
      );
    }
    for (const name of [versionTagName(commit.sequence), ...labelNames.map((entry) => entry.name)]) {
      if (!git.isValidTagName(name)) {
        warnings.push(
          `Skipped tag ${JSON.stringify(name)} of v${commit.sequence}: not a valid Git tag name.`,
        );
        continue;
      }
      tags.set(name, gitCommit);
      versionTags.push(name);
    }
    exported.push({ sequence: commit.sequence, commitId: commit.id, gitCommit, tags: versionTags });
  }

  // Lightweight tags, created in one atomic ref transaction.
  const updates = [...tags].map(([name, hash]) => `create refs/tags/${name} ${hash}\n`).join('');
  git.run(['update-ref', '--stdin'], { input: updates });
  return { exported, warnings };
}

/**
 * Replays the deck's main-branch history into a new Git repository at `outDir`. Reads
 * the whole history first (the database is not used while git runs).
 *
 * @throws {GitExportError} when the deck does not exist or has no versions, when
 * `outDir` is not a new or empty directory (`already-exported` when it holds a previous
 * export of the same deck), or when git fails. A failed export removes what it wrote.
 */
export async function exportDeckToGit(options: ExportDeckToGitOptions): Promise<ExportResult> {
  const runner = options.git ?? spawnGit;
  const { deck, versions } = await planExport(options.repos, options.deckId);
  const git = new GitRepository(runner, resolve(options.outDir));

  // Fail before touching the file system when git cannot run.
  new GitRepository(runner, process.cwd()).run(['--version']);
  const created = prepareTarget(git, deckReference(deck));
  try {
    const { exported, warnings } = writeHistory(git, deck, versions, (options.now ?? (() => new Date()))());
    const head = exported.at(-1)?.gitCommit;
    if (head === undefined)
      throw new GitExportError('no-versions', `${deck.name} has no versions to export.`);
    return {
      outDir: git.dir,
      deck: { id: deck.id, source: deck.source, externalId: deck.externalId, name: deck.name },
      versions: exported,
      head,
      warnings,
    };
  } catch (error) {
    cleanUp(git.dir, created);
    throw error;
  }
}
