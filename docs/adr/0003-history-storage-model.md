# ADR 0003: History storage — content-addressed snapshots in SQLite, Git-compatible export

- Status: accepted
- Date: 2026-10-09

## Context

We need immutable versions with parent links, HEAD, tags, future experiment branches,
arbitrary comparisons and card-level queries ("which versions had card X in the
mainboard?"). The options considered:

- **A. Database only.** Immutable snapshots and Git-like commit relations in the
  application database.
- **B. Real Git repository per deck.** Canonical text files (`mainboard.txt`,
  `primer.md`, ...) committed with `git`.
- **C. Hybrid.** Database for metadata, Git for snapshots.

## Decision

Option **A**, built so that B stays a mechanical export:

- SQLite (better-sqlite3 + Drizzle ORM), one file and no server. (Since
  [ADR 0008](0008-hosting-netlify-and-turso.md): libSQL, the same SQLite dialect, as a
  local file in development and Turso in production.)
- `snapshots` are content-addressed: `sha256(stableStringify(canonicalSnapshot))`.
  Identical states are stored once.
- `commits` have Git-like ids: `sha256` of a commit object with snapshot hash, parent,
  timestamp, source version and message. They also carry a per-deck sequence number
  (`v12`) for humans.
- Immutability is enforced by database triggers, not just by convention.
- Mutable annotations live outside commits: version tags, and notes that work like
  Git notes and are prepared for tournament results.
- `branches` exist from day one. Today there is only `main` per deck; experiments
  become branches anchored at a base commit.
- A derived `snapshot_cards` index makes card history and cross-version search single
  SQL queries.
- Raw Moxfield payloads are kept gzip-compressed and content-addressed in `raw_blobs`,
  so no source information is lost even though the canonical model is lean.
- `snapshotToFileTree()` produces the deterministic human-readable layout (`deck.yaml`,
  `mainboard.txt`, `considering.txt`, `primer.md`, ...). `pnpm export:git` replays a
  deck's history into a real Git repository, one commit per version, with original
  messages and timestamps.

## Why not B or C

- Querying: card history, "versions containing A and B" and tag filters would mean
  replaying Git history and parsing files on every request, or maintaining an index
  anyway, which is option A plus Git.
- Deployment: B and C need a `git` binary and a writable repo directory per deck.
  Atomicity spans two stores in C, so a crash between DB write and Git commit leaves
  them inconsistent.
- Semantics: Git diffs are line diffs. Our diffs are semantic (moves between zones,
  printing changes), so Git's diff machinery adds nothing.
- Branding is not a reason. The useful Git properties (immutability, content
  addressing, parent chains, cheap tags) are reproduced in about 100 lines.

## Consequences

- One file to back up (`data/git-moxfield.db`). WAL mode, safe for a single process.
- Exporting to Git or syncing to GitHub is a one-way projection. Git history will
  diff nicely because the file tree is deterministic.
- Changing the canonical serialization changes hashes. `SNAPSHOT_SCHEMA_VERSION`
  exists for that, and a golden test pins the current serialization.
