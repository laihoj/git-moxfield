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
    sources.ts        DeckSource registry (wires adapters from config; process singleton).
    logger.ts         Structured logging.
    db/               Drizzle schema, connection, migrations runner.
    repositories/     Persistence (the only code that touches SQL).
    services/         Use cases: track, refresh, ingest capture, commit, history,
                      compare, card history, restore, tags, notes.
  app/              Next.js App Router: pages, server actions, route handlers.
  components/       React UI components.
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
  blocked by Cloudflare (HTTP 403 HTML). git-moxfield therefore supports two ingestion
  paths that converge on the same normalization code:
  1. **Server fetch** — used when `MOXFIELD_USER_AGENT` is configured (Moxfield grants
     these for personal, non-commercial projects via support@moxfield.com), or when
     the user opts in to trying without one.
  2. **Browser capture** — a bookmarklet run on a Moxfield deck page fetches the same
     two endpoints with the user's own browser session and hands the JSON to
     git-moxfield's `/capture` page via `window.open` + `postMessage`.
  3. **Manual paste** — fallback: paste the JSON from the two endpoint URLs.

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

SQLite via Drizzle ORM. Content-addressed core: versions, and the snapshots and raw
payloads they reference, are append-only; the working state is not (see below).

| Table            | Purpose                                                                      |
| ---------------- | ---------------------------------------------------------------------------- |
| `workspaces`     | Single `local` workspace today; seam for multi-user later.                   |
| `decks`          | Tracked decks (source + external id, cached name, HEAD branch).              |
| `branches`       | `main` per deck today; experiments later (`kind`, `base_commit_id`).         |
| `snapshots`      | Canonical JSON keyed by sha256. Immutable.                                   |
| `snapshot_cards` | Derived (zone, key, quantity) index per snapshot for history/search.         |
| `raw_blobs`      | gzip-compressed raw source payloads keyed by sha256. Immutable.              |
| `observations`   | Recent fetches/captures of the live Moxfield deck (the working tree).        |
| `commits`        | Immutable versions: parent, snapshot, message, source version, raw.          |
| `version_tags`   | Mutable labels on versions (many per version, reusable names).               |
| `commit_notes`   | Mutable structured annotations on versions (`kind` + JSON), git-notes style. |
| `card_catalog`   | Card facts for display (type line, mana cost). Not versioned.                |
| `app_settings`   | Per-installation key/value settings and secrets (the capture token).         |

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

Migrations run with foreign keys off, inside Drizzle's single migration transaction,
and are followed by `PRAGMA foreign_key_check`: drizzle-kit rebuilds tables (copy into
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
  every page, including the capture token on `/setup`. IP literals and `localhost` need
  no configuration because browsers only send them when no attacker-controlled DNS is
  involved; any other name (e.g. `mybox.local`) must be listed.
- The capture endpoint accepts only same-origin JSON POSTs; the capture page only
  accepts `postMessage` from `https://moxfield.com` with a one-time nonce. The
  same-tab form endpoint requires the installation's capture token, which only the
  user's own same-tab bookmarklet carries (its `Origin` is `null` in practice; see
  `moxfield-integration.md`).
- The server only ever requests fixed Moxfield API hosts; user input is parsed into a
  validated deck id, never used as a URL.
- No secrets are exposed to the browser (`MOXFIELD_USER_AGENT` is server-only).
- The server listens on `127.0.0.1` by default (`pnpm dev`, `pnpm start`); only
  `pnpm dev:lan` / `pnpm start:lan` listen on every network interface. The socket
  binding is the boundary: a host-name check cannot keep a LAN client out, since it can
  send any `Host`.
- Optional HTTP Basic auth (`BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD`) for exposing the
  app beyond localhost; recommended with the `:lan` scripts.
