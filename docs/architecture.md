# git-moxfield architecture

This document is the design contract for the codebase. It explains the layers, the
data model, and the algorithms that matter (canonicalization, semantic diff, card
history, restore). The ADRs in [`docs/adr/`](./adr) record why the big decisions
were made.

## Mental model

| Git concept           | git-moxfield concept                           | UI wording              |
| --------------------- | ---------------------------------------------- | ----------------------- |
| working tree          | the deck as it currently is on Moxfield        | "Current Moxfield deck" |
| `git status`          | HEAD vs. latest observation of Moxfield        | "Uncommitted changes"   |
| commit                | immutable, content-addressed deck snapshot     | "Version vN" / "Commit" |
| HEAD / `main`         | the deck's main line of versions               | "Latest version"        |
| tag                   | label on a version (`tournament`, `stable`)    | "Tag"                   |
| `git diff A B`        | semantic deck diff                             | "Compare"               |
| `git log -- file`     | card history derived from snapshots            | "Card history"          |
| `git checkout` + push | generate Moxfield import text, paste it        | "Restore to Moxfield"   |
| branch                | (future) experiment line anchored at a version | "Experiment"            |
| git notes             | mutable annotations on immutable versions      | "Notes"                 |

Moxfield stays the editor. git-moxfield never writes to Moxfield.

## Layers

```
src/
  core/             Pure domain logic. No I/O, no framework, no Moxfield knowledge.
    zones.ts          Zone ids, ordering, labels.
    model.ts          Canonical snapshot model.
    card-key.ts       Strategic card identity (normalized oracle name).
    canonical.ts      Canonicalization (sort/merge/validate), stable JSON serialization.
    hash.ts           SHA-256 content addressing for snapshots and commits (node:crypto).
    file-tree.ts      Deterministic human-readable file tree (Git export format).
    diff/             Semantic deck diff + presentation grouping.
    primer/           Line-based primer diff.
    history/          Card history derivation.
  integrations/     Platform adapters behind the DeckSource interface.
    deck-source.ts    The interface + error model.
    moxfield/         Moxfield adapter: URL parsing, HTTP client, payload schema,
                      normalization, restore text format, browser capture bookmarklet.
  server/           Server-only application layer.
    config.ts         Typed environment configuration.
    platform.ts       Where the process runs (Netlify or not), for platform defaults.
    sources.ts        DeckSource registry (wires adapters from config; process singleton).
    logger.ts         Structured logging (one JSON object per line; never secrets or SQL).
    host-guard.ts     Which host names the app answers to (DNS-rebinding guard).
    db/               Drizzle schema, libSQL connection, transactions, write lock,
                      error classification, migration state.
    repositories/     Persistence (the only code that touches SQL).
    services/         Use cases: track, refresh, ingest capture, commit, history,
                      compare, card history, restore, tags, notes, change Moxfield deck,
                      share links, the read-only shared deck.
    history-import/   Importing another database's history (`pnpm import:local`).
    auth/             Accounts, sessions, keys, links, invites, claim (ADR 0006).
    access/           Who is asking → which services (ADR 0007); opens the database.
  app/              Next.js App Router: pages, server actions, route handlers.
  components/       React UI components.
  proxy.ts          Runs before every page and endpoint: host guard, session cookie
                    refresh (an edge function on Netlify).
scripts/            Operator commands (`db:migrate`, `users`, `import:local`, `export:git`,
                    `seed:demo`) on the configured database.
```

Dependency rule: `app → server/services → (core, integrations, server/repositories)`;
`integrations → core`; `core → nothing`. The core never imports from `integrations`,
`server` or `app`. Only `integrations/moxfield` knows Moxfield payload shapes.

## Data flow

```
                 ┌──────────── server fetch (if allowed) ─────────────┐
Moxfield API ────┤                                                    ├─► RawSourcePayload
                 └── browser capture (bookmarklet on moxfield.com) ───┘        │
                                                                               ▼
                                         DeckSource.normalizeDeck(raw) ─► NormalizedDeck
                                                                               │
              ┌────────────────────────────────────────────────────────────────┤
              ▼                                ▼                               ▼
   raw_blobs (gzip, sha256)      snapshots (canonical JSON, sha256)     card_catalog (facts)
              └───────────────┬────────────────┘
                              ▼
                observations (latest Moxfield state = working tree)
                              │  diff(HEAD snapshot, observation snapshot)
                              ▼
                 commit ─► commits (immutable, parent → HEAD)
```

## Moxfield integration

See [`moxfield-integration.md`](./moxfield-integration.md) for endpoint details.

- Deck: `GET https://api2.moxfield.com/v3/decks/all/{publicId}`
- Primer: `GET https://api2.moxfield.com/v1/decks/{deckInternalId}/primer`
  (`deckInternalId` is the deck payload's `id`, not the public id)
- The API is not public. Server-side requests without a Moxfield-issued User-Agent are
  blocked by Cloudflare (HTTP 403 HTML). git-moxfield therefore supports three ingestion
  paths that converge on the same normalization code:
  1. **Server fetch** — used when `MOXFIELD_USER_AGENT` is configured (Moxfield grants
     these for personal, non-commercial projects via support@moxfield.com), or when
     the user opts in to trying without one. Off by default on Netlify
     (`MOXFIELD_SERVER_FETCH`), whose servers Cloudflare blocks.
  2. **Browser capture** — a personal bookmarklet run on a Moxfield deck page fetches the
     same two endpoints with the user's own browser session and hands the capture to
     git-moxfield: to its `/capture` page via `window.open` + `postMessage` (popup mode),
     or as a form post to `/api/capture/form` (same-tab mode, for phones). The bookmarklet
     carries its owner's key (see [Accounts](#accounts)), which decides whose workspace
     receives the deck.
  3. **Manual paste** — fallback: paste the JSON from the two endpoint URLs.

### Capture transport encoding

The capture (the envelope JSON: deck, primer, capture metadata; envelope version 2) is
gzip-compressed in the browser (`CompressionStream`) and sent as
`gm-gzip-base64url:<base64url>` (`src/integrations/moxfield/capture-codec-protocol.ts`),
the same text on every path: the `postMessage` payload, the JSON body of
`POST /api/capture` and the form field of the same-tab post. Untagged text is plain JSON
(older bookmarklets, browsers without `CompressionStream`, manual pastes), so the tag
makes the encoding self-describing and needed no new envelope version. A real 835 KB deck
travels as 147 KB.

The server decodes only after authenticating the request (`decodeCapturePayload`,
`capture-codec.ts`, server-only): at most 2,000,000 encoded characters, at most
8,000,000 bytes after inflating (zlib's `maxOutputLength`, so a decompression bomb stops
there), at most 1,400,000 bytes of plain JSON, a strict base64url alphabet, valid UTF-8.
Oversized payloads answer 413 (the same-tab route redirects to the paste form with
`error=too-large`), damaged ones 400 (`error=invalid`). The routes' body limits (2.9 MB
for JSON, 4.3 MB for forms) keep every accepted request under Netlify's 6 MB limit even
if the platform hands the body over base64-encoded, so users always see the app's own
"too large" message, never a platform error.

## Canonical snapshot

`CanonicalSnapshot` (see `src/core/model.ts`) contains only user-controlled state:

- `deck`: name, format, description, deck tags (sorted).
- `zones`: non-empty zones only; cards sorted by key; one entry per (zone, key).
- `cardTags`: per-card user tags, sorted.
- `primer`: markdown (CRLF → LF, trailing whitespace at end of text trimmed, exactly
  one trailing newline when non-empty) or `null` when not captured.

Canonicalization rules (`canonicalizeSnapshot`) are idempotent:

- Duplicate entries for the same (zone, key) are merged: quantities summed, printings
  merged by printing identity (set, collectorNumber, finish, lang, flags).
- Printings sorted by (set, collectorNumber, finish, lang, flags joined).
- Strings NFC-normalized; tag lists trimmed, deduplicated, sorted.
- Zones with zero cards are removed.
- Quantities must be positive integers; invalid ones are rejected by the adapter
  (with a warning) before canonicalization.

**Serialization**: `stableStringify` emits JSON with object keys sorted by UTF-16
code unit order, no insignificant whitespace, arrays in their canonical order, and
`undefined` properties omitted. Two semantically identical states serialize
identically, so `snapshotHash = sha256(stableStringify(snapshot))`.

**Dirty state is derived from the semantic diff, not the hash.** The hash covers
source ids too (needed for lossless restore), so a source re-identifying a printing
changes the hash without changing the diff; such a state is reported as "up to date".

### Card identity

`cardKey(name)`: NFC-normalize, map curly quotes to straight quotes, collapse
whitespace, normalize split/DFC separators to `//`, trim, lowercase. Example:
`"Birgi, God of Storytelling // Harnfel, Horn of Bounty"` →
`"birgi, god of storytelling // harnfel, horn of bounty"`.

Rationale: the Comprehensive Rules define card identity for deck construction by
English name (singleton is "no two cards with the same English name"), names are
portable across platforms, human-readable in files and URLs, and stable across
printings. Source-stable ids (Moxfield `uniqueCardId`) are kept in `ids` and used by
the diff engine to reconcile renames.

## Semantic diff

`diffSnapshots(before, after): DeckDiff` (types in `src/core/diff/types.ts`).

1. **Rename reconciliation.** For cards whose key exists only on one side, if a
   card on the other side shares a stable id (`ids.moxfield` or `ids.scryfallOracle`)
   and its key exists only on that side, treat both as the same key (the newer one),
   and emit a cosmetic `renamed` change.
2. **Per-key zone deltas.** For each key, compute `before[z]`, `after[z]` and
   `delta[z] = after[z] - before[z]` for every zone.
3. **Move detection first.** Zones with negative delta are sources, positive are
   sinks. Iterate sources in canonical zone order; for each, iterate sinks in
   canonical zone order and move `min(remainingOut, remainingIn)` copies. Each pairing
   emits `moved {from, to, quantity}`.
4. **Residual classification** per zone after moves, with
   `base = before[z] - movedOut[z] + movedIn[z]` and `r = after[z] - base`:
   - `r > 0` and `base == 0` → `added {quantity: r}`
   - `r > 0` and `base > 0` → `quantity {from: base, to: after[z]}`
   - `r < 0` and `after[z] == 0` → `removed {quantity: -r}`
   - `r < 0` and `after[z] > 0` → `quantity {from: base, to: after[z]}`
5. **Printing changes** (cosmetic) for zones where the key is present on both
   sides and not involved in a move: if quantities are equal, compare the printing
   multisets (identity + quantity); otherwise compare the sets of printing
   identities. Printing identity = (set, collectorNumber, finish, lang, flags);
   source ids are ignored. Cards without printing information on either side never
   produce printing changes.
6. **Card tag changes** (cosmetic) from `cardTags`.
7. **Deck info changes** for name, format, description, tags.
8. **Primer**: `unknown` if the after side is `null` (a failed primer fetch is never a
   change, nor a deletion), `captured` if only the before side is `null` and the after
   side has text (a change: committing it records the primer), `unknown` if only the
   before side is `null` and the after side is empty, otherwise line-diff counts.
   The line diff matches common leading and trailing lines first and bounds the work
   on the edited region between them by a fixed budget (deterministic, unlike a
   timeout); a region edited too heavily to diff within it is counted as a full
   replacement (all its old lines removed, all its new lines added).
9. **Commanders** summary from the `commanders` zone.

Ordering is fully deterministic (see `DeckDiff.changes` docs). `isEmpty`,
`hasCardChanges` and `onlyCosmetic` are derived flags.

Comparing HEAD with the current Moxfield state and comparing any two versions use the
same function. A missing side (e.g. the first commit) is the empty snapshot.

## Card history

`deriveCardHistory({ key, name, points })` takes one `CardVersionPoint` per version (oldest →
newest; optionally a trailing working-state point) and classifies each transition:
`first-seen`, `added`, `removed`, `moved`, `restored` (returned to a zone it had
occupied before and left), `quantity`, `unchanged`. It also produces compressed runs
and a summary (times cut from played zones, times restored, ...). A move back to a
non-played zone the card occupied before is labeled `restored` but counted only as a
cut, never also as a restore. Points come from the `snapshot_cards` index joined with
the version lineage, so history is derived, never stored per card.

A card keeps one history across the renames the semantic diff reconciles (step 1
above): `traceCardKeys` resolves the card's key at every point, loading full
snapshots only where the tracked key appears or disappears and checking them with
`renamedKeys`, so the old and the new name return the same history. The point where
the key changed carries `renamedFrom`; like the diff, history treats a rename as
cosmetic (never a cut or an addition) and starts a new run there so the timeline can
show it.

## Persistence

SQLite via Drizzle ORM on libSQL (ADR 0008): Turso over HTTP in production, local
`file:` and `:memory:` databases in development and tests, one driver and one dialect
everywhere. Content-addressed core: versions, and the snapshots and raw payloads they
reference, are append-only; the working state is not (see below).

Every query is asynchronous. Writes go through `src/server/db/transaction.ts`:
`runInTransaction` (repositories: `withTransaction`, services: `repos.transaction`) for
read-check-write units, always `BEGIN IMMEDIATE`, retried as a whole after transient
failures, so the callback must use only the transaction it receives, stay short, never
fetch from Moxfield and have no other side effects; `runWrite` (repositories: `write`,
`writeAll`) for single statements and atomic `db.batch()` write sets, which cost one round
trip remotely. One-time things (invites, login links, hand-offs) are used up by a
conditional `UPDATE` inside such a transaction, so of concurrent consumers exactly one
wins. Database errors are classified by `classifySqlError` (walking the cause chain:
remote errors carry no extended result codes, so a primary key violation reads as
`unique` everywhere) and never logged with their SQL or bound parameters. A remote libSQL
server rejects any value over 5,000,000 bytes; the repositories refuse to store one over
4,500,000 bytes (`MAX_STORED_VALUE_BYTES`) with an `invalid-input` error that says so.

Retries and atomicity: `runInTransaction` runs the whole callback again (up to 3 retries,
jittered backoff) after `busy`, `transaction-timeout` (Turso rolls back a transaction that
holds its write lock for more than 5 s while another writer waits) and `stream-expired`.
After any failure other than a constraint violation, the transaction is aborted: no
further statement is sent, and the commit fails with the original error. Remotely this
matters: after a server-side rollback, the HTTP protocol would run later statements of the
"transaction" in autocommit mode, one by one. Using the root database inside a callback
throws (`root-in-transaction`), and so does `db.transaction()` outside `runInTransaction`.

**Write lock.** Each process holds one FIFO write lock per database
(`src/server/db/write-lock.ts`). `runInTransaction` and `runWrite` take it in every mode.
For a local database (`file:`, `:memory:`) every root operation takes it, reads included:
libSQL fails a second local writer at once instead of queueing it (`TRANSACTION_ACTIVE` in
memory, `SQLITE_BUSY` on a file), so the process queues its own work. Remote reads run
concurrently, and the server serializes writers across processes. Waits are bounded (15 s,
`WriteLockError`), and a nested `run` from the holder fails at once instead of deadlocking.
Lock order everywhere: the service layer's per-deck lock first, the write lock second, and
no lock is ever awaited inside a transaction. Local files run in WAL mode with a 5 s busy
timeout, which only matters when another process (a script) holds the file.

Turso bills every row a query reads, so the hot queries are index-driven: card history
and card search probe `snapshot_cards(card_key, snapshot_hash)` per version of the deck
instead of scanning its whole history (`src/server/repositories/card-index.ts` has the
measurements; tests pin the query plans).

| Table            | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `workspaces`     | One private space per user; `local` holds pre-account history.               |
| `decks`          | Tracked decks (source + external id, cached name, HEAD branch).              |
| `branches`       | `main` per deck today; experiments later (`kind`, `base_commit_id`).         |
| `snapshots`      | Canonical JSON keyed by sha256. Immutable.                                   |
| `snapshot_cards` | Derived (zone, key, quantity) index per snapshot for history/search.         |
| `raw_blobs`      | gzip-compressed raw source payloads keyed by sha256. Immutable.              |
| `observations`   | Recent fetches/captures of the live Moxfield deck (the working tree).        |
| `commits`        | Immutable versions: parent, snapshot, message, source version, raw.          |
| `version_tags`   | Mutable labels on versions (many per version, reusable names).               |
| `commit_notes`   | Mutable structured annotations on versions (`kind` + JSON), git-notes style. |
| `card_catalog`   | Card facts for display (type line, mana cost), per workspace. Not versioned. |
| `app_settings`   | Per-installation key/value settings and secrets (the setup code).            |
| `users`          | Accounts (ADR 0006): display name, role, workspace, disabled state.          |
| `credentials`    | Bookmarklet keys (hashed), with the key each one was made through.           |
| `sessions`       | Signed-in browsers and pending bookmarklet hand-offs (hashed tokens).        |
| `login_links`    | One-time device and recovery links (hashed), kept as the recovery record.    |
| `invites`        | One-time invitations that create an account (hashed).                        |
| `share_links`    | Read-only links to one deck's history (hashed; ADR 0007).                    |
| `deck_relinks`   | A deck's changes of Moxfield deck ("Change Moxfield deck"), oldest first.    |

Immutability is enforced in the database: triggers abort `UPDATE` on `commits`,
`snapshots`, `raw_blobs`, and abort `DELETE` on `commits` unless the owning deck is
being deleted.

Observations are pruned on every ingest, in the same transaction: a deck keeps only its
latest observation, the one before it (a page rendered just before a refresh can still
commit it), and the observation a commit in progress is recording. Snapshots and raw
blobs that no commit or remaining observation references are deleted with them (raw
Moxfield payloads carry volatile counters, so nearly every fetch stores a new blob).
Commit snapshots and raw blobs are never pruned. A review superseded by two or more
ingests can no longer be committed; the commit answers `stale` and the user reviews
again.

A local database is migrated when the app opens it; a remote one never is (concurrent
cold starts would race): the deploy runs `pnpm db:migrate`, and the app refuses a
database that lacks any of its migrations, saying so. It serves one with newer migrations
(logging a warning): the deploy migrates before publishing, so the live deploy, or one
rolled back to, runs on migrations newer than itself; they are backward compatible.
Migrations run with foreign keys off, as one atomic batch (libSQL's `migrate`), and are
followed by `PRAGMA foreign_key_check`: drizzle-kit rebuilds tables (copy into
`__new_<table>`, `DROP`, rename) for changes SQLite cannot `ALTER`, and with foreign
keys on, `DROP TABLE` fails on, or cascades into, the referencing rows. A rebuild drops
the table's triggers, so a migration that rebuilds `commits`, `snapshots`,
`snapshot_cards` or `raw_blobs` must recreate their triggers from
`0001_immutability_triggers.sql`, and one that rebuilds `decks` must drop
`commits_immutable_delete` first and recreate it after the rename.

### Commit identity

Commit ids are Git-like: `sha256` of a canonical commit object:

```
git-moxfield-commit 1
deck moxfield:<publicId>
snapshot <snapshotHash>
parent <parentCommitId>        (omitted for the first version)
created-at <ISO-8601 UTC>
source-version <n>             (omitted when unknown)

<message>
```

Users see `vN` (per-deck sequence); short ids are shown as secondary detail.

The `deck` header records the deck reference **at commit time**. A deck can change its
Moxfield deck (below), so the versions of one deck may hash different references; each
stays valid, and `deck_relinks` keeps every earlier reference, so every commit id can
still be checked against its content (`pnpm import:local` does).

### Changing a deck's Moxfield deck

Deleting a deck on Moxfield and making it again gives the new copy a new public id. The
owner points the git-moxfield deck at it ("Change Moxfield deck" on the Status page, or,
when the bookmarklet sends the new copy as an untracked deck, "Continue an existing deck's
history" on the capture page): `DeckServices.relinkDeck`, or `ingestCapture` with
`relinkDeckId`. In one transaction the deck's `external_id` and `url` change (its id, name,
branches and versions stay), the change is recorded in `deck_relinks`, the fetch status
is cleared and the observations of the old Moxfield deck are pruned (they must never be
committed as the new one's). The capture variant ingests the capture as the new working
state in the same transaction, so the deck page shows what changed since the latest
version. A Moxfield deck that another deck of the workspace tracks is refused, with how
to proceed (stop tracking that deck first). Viewers of share links never see any of it:
it names decks on Moxfield.

### Importing history from another database

`pnpm import:local` (`scripts/import-local.ts`, `src/server/history-import/`) moves a
local installation's history into the configured database (Turso), into one user's
workspace. The source file is copied (with its write-ahead log) and only the copy is
opened and migrated, so the source is never modified. Rows move as they are (the
`historyTransfer` repository): commit ids, timestamps and raw payloads are byte for byte
the source's, verified on the way (content hashes, commit content addresses). Each deck
goes in short steps (ADR 0008: no long transactions remotely): content-addressed rows in
batches of at most 2 MB or 50 rows (invisible until referenced), then the deck's history
in one transaction (inserts only, so the immutability triggers hold), then its card facts
(latest wins), then a check of the lineage. Decks the target has with the same versions are
skipped, so re-running is safe; a deck the target workspace tracks with a different
history (or whose versions are stored elsewhere already: commit ids are unique per
installation) refuses the import unless `--skip-existing`. Accounts, sessions, keys and
links are never copied.

### Commit flow and concurrency

`commit(deckId, { message, expectedObservationId, expectedHeadCommitId })`:

1. Refuse without contacting the source when the commit cannot succeed: `head-moved`
   when HEAD no longer equals `expectedHeadCommitId`, `nothing-to-commit` when HEAD
   exists and the reviewed state does not differ from it.
2. If server fetch is available, fetch fresh state first ("fetch on commit"). If it
   differs semantically from the reviewed observation, abort with `stale` and return
   the new diff for re-review.
3. In one transaction: verify HEAD still equals `expectedHeadCommitId`; refuse empty
   commits when HEAD exists and the diff is empty (both checked again, authoritatively);
   insert commit with `sequence = head.sequence + 1`; move the branch head.

Refresh, capture ingestion, commit and untrack of one deck run under a per-deck lock
(`KeyedMutex`), always taken before the database's write lock and never inside a
transaction. The lock is per process, so on Netlify it is per function instance: it
keeps one instance's requests from interleaving, while the compare-and-set on the branch
head (step 3) is what keeps two instances from committing over each other. The fetch of
step 2 happens outside any transaction; transactions hold no network request other than
their own statements.

Known limitation (remote mode only): reads outside a transaction see whatever is committed
when each statement runs. Loading a deck's working state reads its latest observation and
then that observation's snapshot in separate statements, and the commit's pre-checks
(step 1) read outside a transaction too. If another instance ingests the same deck twice in
between, pruning removes that snapshot and the request fails with "Snapshot … is missing"
instead of answering with the newer state or `stale`. A stress test of 6 processes on one
deck hit it in 2 of 240 rounds; real use would need two captures of one deck within
milliseconds. History stays consistent. Planned fix: read the pre-checks in one short
transaction and retry the working-state read when its snapshot is gone.

Request-handling code gets services from `src/server/access` (`servicesFor(user)`,
`shareLinkServicesFor(user)`, `sharedDeckServices(token)`) and the auth service from
`getAuthService()`; all of them are asynchronous because the database is opened on first
use (and a database that cannot be opened, or is not migrated, fails the request
clearly). Reads that do not depend on each other are started together: remotely every
query is a round trip.

### Fetch policy

No polling. Fetch on: explicit refresh, deck page load when the latest observation is
older than `AUTO_REFRESH_AFTER_SECONDS` (client-triggered after render), and commit.
A per-deck cooldown and a global minimum interval between Moxfield requests protect
against bursts. A 429 response pauses every server request (any deck, the primer,
fetch on commit) for its `Retry-After` (60 s without one, at most the block backoff),
and the UI shows how long; meanwhile the deck page suggests no background refresh. A
Cloudflare block pauses server fetches for a while and switches the UI to browser
capture.

## Restore

`DeckSource.exportForRestore(snapshot)` generates paste-ready text per zone plus
instructions and limitations. Restore never changes git-moxfield state: it is a pure
export of a chosen version.

## Accounts

Design and rationale: [ADR 0006](./adr/0006-accounts-with-bookmarklet-keys.md). Code:
`src/server/auth` (the `AuthService`, cookies, paths, tokens) and the account pages.

- **Identity and credentials are separate.** A user (display name, role `admin` or
  `member`, disabled or not) owns exactly one workspace, which owns the decks. A
  credential proves who you are; today only `bookmarklet-key`. Sessions, device links,
  share links and keys made in a signed-in browser record the key that browser's session
  descends from (their lineage), so revoking a key reaches the sessions and unused links
  derived from it, and, on request, the share links and keys made through it.
- **Tokens** are a type prefix plus 32 random bytes in base64url: `gmk_` keys, `gms_`
  sessions, `gmi_` invites, `gml_` device and recovery links, `gmv_` share links. Only
  their SHA-256 is stored, and they are looked up by it; the format is checked before any
  lookup (`token-format.ts`). Plaintext leaves the auth service once, to whoever it is
  for: a cookie, a link shown to its creator, a new bookmarklet.
- **Sessions** are an `HttpOnly`, `SameSite=Lax` cookie: `__Host-gm_session` with `Secure`
  over https and on the loopback host, `gm_session` over plain http to a LAN address
  (`cookie-spec.ts`). The database expiry slides with use (400 days); the proxy re-sets
  the cookie's `Max-Age` at most daily. Every request and server action resolves the
  session again (`getCurrentUser`, memoized per render).
- **Ways in.** The popup bookmarklet posts its key same-origin with the capture, which
  sets the session. The same-tab bookmarklet's cross-site form post cannot see the
  browser's (`Lax`) session, so it starts a five-minute hand-off (`gm_handoff` cookie)
  and redirects through `/api/auth/handoff`: a browser already signed in as the key's
  owner continues, any other is asked on `/signin/bookmarklet`, whose same-origin POST
  signs it in. Device links (15 minutes), recovery links (24 hours, made by an admin) and
  invites (7 days) are consumed by a POST, never by opening them.
- **Claim.** While no user exists, a setup code (`XXXX-XXXX-XXXX`, about 58 bits) is kept
  in `app_settings` and printed to the server log when a process first uses the auth
  service and whenever `/claim` is opened (`pnpm users claim-code` prints it too). Whoever
  enters it becomes the first admin, in one transaction; if the `local` workspace holds
  decks and has no owner (an installation from before accounts), the admin adopts it.
- **Admins** manage accounts (invite, disable, recovery links), never decks: no admin
  method reaches a deck. Every multi-step change (claim, invite acceptance, consuming a
  link, revoking) runs in one `IMMEDIATE` transaction, and what happened is logged after
  the commit, since the callback may run more than once.

## Access scopes and share links

Design and rationale: [ADR 0007](./adr/0007-access-control-and-share-links.md). Code:
`src/server/access`, the only place request-handling code gets deck services from.

- **Owner scope.** `servicesFor(user)` builds `DeckServices` over repositories bound to
  the user's workspace. Every deck query filters by it, so another workspace's deck,
  version or observation id behaves like a missing one (`not-found`, never `forbidden`).
  `shareLinkServicesFor(user)` creates, lists and revokes the user's share links.
- **Viewer scope.** `sharedDeckServices(token)` resolves a `gmv_` token to one deck and
  returns `SharedDeckServices`, a separate interface without write methods (read-only by
  type). It is confined to the deck (`confined-history.ts`: commits, snapshots, tags and
  notes are reachable only through the deck's own versions), shows committed history only
  (no working state, refresh or fetch status), notes only when the link includes them,
  and nothing that says where the deck is on Moxfield (no URL, Moxfield id, source
  metadata or earlier Moxfield decks). Every call checks the link again, so revoking it,
  untracking the deck or disabling the owner ends access at once; all of these, like an
  unknown token, answer 404. Views are recorded at most hourly.
- **Routes.** A deck's pages exist for its owner under `/decks/<deckId>` and for viewers
  under `/s/<token>`. Components never build deck URLs: they receive a `DeckScope` and
  link with `deckRoutes(scope)` (`src/lib/routes.ts`).
- **What workspaces share.** Only content-addressed rows (snapshots, their card index,
  raw payloads), keyed by the hash of their content. Card facts (`card_catalog`) come
  from untrusted captures and are per workspace.
- **Scripts** are not requests: they build services for an explicit workspace
  (`createServices`) and act on accounts as the system actor.

## Deployment

Design, limits and rationale: [ADR 0008](./adr/0008-hosting-netlify-and-turso.md); the
steps are in the README. The hosted instance is one Netlify site and one Turso database:

```
browser ──HTTPS──► Netlify CDN ─────────── static assets (.next/static, icons, manifest)
                        │
                        ▼
          edge function: src/proxy.ts (Deno; host guard, session cookie refresh)
                        │
                        ▼
          Node function: the Next.js server handler (AWS us-east-2, Ohio)
          pages · server actions · /api/capture · /api/capture/form · /api/auth/handoff
                        │  @libsql/client/http: one HTTPS round trip per statement or batch
                        ▼
          Turso: libSQL database (aws-us-east-2)
                        ▲
                        │  the same client, from the build or the operator's machine
          pnpm db:migrate (production builds) · users · import:local · export:git
```

- **Moxfield is reached from the browser only.** Server fetching defaults to off on
  Netlify (`runsOnNetlify`: `NETLIFY=true` in builds, `SITE_ID` in functions), because
  Cloudflare blocks cloud servers; decks arrive through the bookmarklet.
- **Release.** Production builds run `pnpm run build && pnpm run db:migrate`
  (`netlify.toml`): migrations are applied after a successful build and before the
  deploy is published, so a failed migration publishes nothing. Deploy previews and
  branch deploys are not built (they would share the production database).
- **Runtime checks.** The app never migrates a remote database. When an instance first
  opens it, `assertMigrationsApplied` requires every migration this build ships
  (otherwise each request fails with a `MigrationStateError` naming `pnpm db:migrate`,
  until the database is migrated; a failed opening is retried on the next request) and
  tolerates newer ones with a warning: during a release, and after a rollback, the live
  deploy runs on migrations newer than itself, which is why migrations are written to
  stay backward compatible. A local database file on Netlify is refused
  (`DatabaseConfigError`): a function's disk is temporary and per instance.
- **Per-instance state.** The database handle, the per-deck locks, the Moxfield throttle
  and block backoff, and the "setup code printed" flag live per process, so per function
  instance. Correctness never depends on them: the database's compare-and-set on the
  branch head and its unique constraints decide between instances.
- **Cost shape.** Turso bills rows read (including rows scanned) and rows written, and
  each statement is a round trip from Ohio, so queries are index-driven, independent
  reads are started together, and write sets without interleaved reads go in one
  `db.batch()`. Measured costs are in the README's "Free plans and their limits".
- **Bundles.** The server function (about 21 MB zipped) also contains the libSQL native
  binary, traced because of the lazy local import but never loaded for remote URLs; the
  edge bundle (about 2.8 MB) contains no database code.
- **Locally**, the same code runs with a `file:` database through the native libSQL
  client (loaded lazily, only for `file:` and `:memory:` URLs), migrated when opened.

## Security

- Remote content is untrusted: payloads are validated with zod, size-limited,
  normalized into the canonical model, and rendered as text by React.
- Primer markdown is rendered with `react-markdown` without raw HTML; links are
  restricted to `http(s)`/`mailto`; Moxfield-specific directives are transformed to
  plain markdown first. No `dangerouslySetInnerHTML` anywhere.
- DNS-rebinding guard: `src/proxy.ts` answers 421 to every request (pages, capture
  endpoints, server actions) whose `Host` or `X-Forwarded-Host` is not an IP literal,
  `localhost`/`*.localhost`, the host of `PUBLIC_APP_URL` or a name in `ALLOWED_HOSTS`
  (`src/server/host-guard.ts`). Without it, a page whose domain the attacker re-points
  to 127.0.0.1 would be same-origin with the app (its `Origin` matches its `Host`), pass
  the capture endpoint's and Next.js's server-action origin checks, and could read
  every page, including the bookmarklets on `/setup`. IP literals and `localhost` need
  no configuration because browsers only send them when no attacker-controlled DNS is
  involved; any other name (e.g. `mybox.local`) must be listed.
- The capture endpoint accepts only same-origin JSON POSTs; the capture page only
  accepts `postMessage` from `https://moxfield.com` with a one-time nonce. The
  same-tab form endpoint requires a valid bookmarklet key, which decides whose
  workspace receives the deck (its `Origin` is `null` when git-moxfield runs on plain
  http, and is expected to be `https://moxfield.com` when hosted on https; see
  `moxfield-integration.md`). Since any member can post their own key from any page,
  the sign-in it hands off never changes who a browser is without a same-origin
  confirmation on `/signin/bookmarklet`. Captures are decoded only after the key or
  session is accepted, within hard size limits.
- The server only ever requests fixed Moxfield API hosts; user input is parsed into a
  validated deck id, never used as a URL.
- No secrets are exposed to the browser (`MOXFIELD_USER_AGENT` is server-only).
- The database URL and `TURSO_AUTH_TOKEN` come from the environment (Netlify's settings
  when hosted, never a committed file) and are private fields of `DatabaseLocation`, so
  logging or serializing the configuration never shows them; error messages never echo
  the URL. Logged errors never include a query's SQL or bound parameters (which hold
  token hashes and user data): database errors are logged as their classification.
  Tokens, keys and cookies are never logged; the setup code of an unclaimed installation
  is, by design.
- The server listens on `127.0.0.1` by default (`pnpm dev`, `pnpm start`); only
  `pnpm dev:lan` / `pnpm start:lan` listen on every network interface. The socket
  binding is the boundary: a host-name check cannot keep a LAN client out, since it can
  send any `Host`.
- Accounts (ADR 0006) replace the former optional HTTP Basic auth: every page and
  endpoint resolves the signed-in user from the session cookie, and deck data is only
  reachable through services bound to that user's workspace (ADR 0007). Account
  cookies use the `__Host-` prefix wherever they are `Secure`, so a sibling subdomain
  cannot plant them, and a cookie sent twice is treated as absent.
- `next` redirect targets are validated after dot-segment normalization, so
  `/.//evil` never becomes a protocol-relative `//evil` (`src/server/auth/paths.ts`).
- The end-to-end suite's `/api/e2e/*` endpoints exist only in development and test
  builds with `GIT_MOXFIELD_E2E=true`; production builds compile them away and the
  configuration refuses the flag with `NODE_ENV=production`.
