# git-moxfield

**Version control for your Moxfield decks.** Keep building in
[Moxfield](https://moxfield.com). git-moxfield sits beside it and adds commits,
semantic diffs, history, tags, card history and a restore path for any earlier
version of your deck.

```
Moxfield            = working tree     (where you edit)
latest version (vN) = HEAD             (last committed snapshot)
history             = v1 … vN          (immutable versions, tags, notes)
Moxfield edits since vN = uncommitted changes
```

A card moving between zones is a **move**, not a removal plus an addition:

```
MOVED
  ⇄ Dress Down          Mainboard → Considering
  ⇄ Mnemonic Betrayal   Considering → Mainboard
MAINBOARD
  + Beseech the Mirror
  ± Orcish Bowmasters   1 → 2
PRIMER   +32 / −11 lines
```

Your considering and sideboard zones are a record of what you have explored.
git-moxfield makes that exploration history first-class: you can see when a card was
cut, what replaced it, and when it came back.

---

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Connecting Moxfield (important)](#connecting-moxfield-important)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Configuration](#configuration)
- [Moxfield integration assumptions and limitations](#moxfield-integration-assumptions-and-limitations)
- [Known issues](#known-issues)
- [Roadmap](#roadmap)
- [Architecture decision records](#architecture-decision-records)

## Features

- **Track** any public or unlisted Moxfield deck by URL.
- **Status at a glance.** "Uncommitted changes", Moxfield's edit time, and Moxfield
  version vs. the committed version ("Moxfield version 143 · v47 committed at 137").
- **Semantic diff.** Additions, removals, quantity changes and moves between zones,
  commander changes, primer line diffs, and deck info. Printing-only changes are
  cosmetic and shown separately.
- **Commit** the current Moxfield state with a message (a suggestion is generated
  from the diff) and optional tags. Versions are immutable and content-addressed.
- **History timeline** with tag filters and per-version stats. Each version page
  shows metadata, the diff to its parent, the full deck grouped by type, the primer
  and the primer diff.
- **Compare** any two versions, or any version against the current Moxfield deck.
- **Card history.** Where a card has been over time ("v21 moved to Considering, v28
  restored to Mainboard"), derived from snapshots.
- **Restore to Moxfield.** Paste-ready Bulk Edit text per board, copy buttons,
  step-by-step instructions and explicit limitations. Nothing is ever written to
  Moxfield.
- **Tags and notes** on versions (`tournament`, `stable`, `testing`, …). Notes are
  stored as structured annotations, ready for tournament results later.
- **Export to Git.** Replay a deck's history into a real Git repository, one commit
  per version.
- **Responsive and PWA-friendly.** The core loop works on a phone: status, diff,
  commit, history, copy a restore.

## Quick start

Requirements: **Node.js 24 LTS** (≥ 22.12 works; Node 25 works but is end-of-life),
**pnpm 10**, and Git (only for `export:git`).

```bash
pnpm install
```

```bash
pnpm dev
```

Open <http://localhost:3000>. The SQLite database (`data/git-moxfield.db`) is created
and migrated automatically on first request. The app listens on this computer only
(`127.0.0.1`); to use it from your phone, see [Using it from another device](#using-it-from-another-device).

Try it without touching Moxfield, using a seeded demo history:

```bash
DATABASE_PATH=data/demo.db pnpm seed:demo
```

```bash
DATABASE_PATH=data/demo.db MOXFIELD_SERVER_FETCH=off pnpm dev
```

Or run against the included **mock Moxfield** (a fake API plus a deck page you can edit):

```bash
pnpm mock-moxfield
```

```bash
pnpm dev:mock
```

Then track `http://localhost:4010/decks/MockBlueFarm0000000001`, and edit the mock
deck with its control API (see [`tests/mock-moxfield/server.ts`](tests/mock-moxfield/server.ts)):

```bash
curl -X POST localhost:4010/__control/decks/MockBlueFarm0000000001/edit -H 'content-type: application/json' -d '[{"op":"move","card":"Dress Down","from":"mainboard","to":"considering"}]'
```

## How it works

### The loop

1. **Edit** your deck in Moxfield as usual.
2. **Update** git-moxfield's view of the deck. Click _Refresh_ when server fetching
   works, or click the **Send to git-moxfield** bookmarklet on the Moxfield deck page
   (see below).
3. **Review** the semantic diff against your latest version.
4. **Commit** with a message such as `Test Broodlord package`, optionally with tags.
5. Later: browse **History**, **Compare** versions, check **Card history**, and
   **Restore** an old version.

### Commits

- A commit stores a canonical snapshot of the observed Moxfield state: commanders,
  every zone with quantities and printings, card tags, deck name, format,
  description, deck tags and the primer. It also stores the raw Moxfield payload,
  compressed, so no source data is lost.
- Snapshots are content-addressed (`sha256` of a deterministic serialization).
  Commit ids are Git-like hashes over snapshot, parent, time, Moxfield version and
  message. You see them as `vN`; short ids are secondary.
- Commits are immutable. Database triggers reject updates and deletes; only deleting
  the whole deck removes its history. Tags and notes are separate, mutable
  annotations.
- **Fetch on commit.** When server fetching works, git-moxfield fetches Moxfield again
  right before committing. If the deck changed since you reviewed it, the commit is
  refused and you see the new diff. Concurrent commits are guarded by an
  expected-HEAD check.

### Restore

Pick a version, then **Restore to Moxfield**. git-moxfield generates text for
Moxfield's **Bulk Edit**, which has one tab per board:

| Section                      | Where it goes in Moxfield                                       |
| ---------------------------- | --------------------------------------------------------------- |
| Commanders                   | Deck page › More › Change Commander / Add Partner (manual step) |
| Companion                    | Card menu › Set as Companion (manual step)                      |
| Mainboard                    | Bulk Edit › Main Deck                                           |
| Sideboard                    | Bulk Edit › Sideboard                                           |
| Considering                  | Bulk Edit › Considering                                         |
| Attractions, contraptions, … | Bulk Edit › Other › …                                           |
| Primer                       | Deck page › Primer › Edit (paste the exact Moxfield markup)     |

Lines look like `1 Thassa's Oracle (THB) 308 *F*`, so printings and finishes are
restored too. Empty boards come with an explicit "clear this tab" step, because saving
Bulk Edit replaces each board. The primer is offered verbatim, in Moxfield's own markup
(`===panel:` directives, `[[Card]]` links), so pasting it into Moxfield's primer editor
reproduces it exactly. A version's primer can also be copied from its Primer tab, or
from either side of a Compare. The page also lists limitations: alter/proxy flags, card
tags, non-English printings, multiple printings of one card. Restoring never changes
git-moxfield's history. After you save in Moxfield, the restored state shows up as
uncommitted changes.

## Connecting Moxfield (important)

Moxfield has **no public API**. Its FAQ says the API is private, and that it
occasionally helps personal, non-commercial projects that contact
support@moxfield.com. As of 2026-10-09, **server-side requests are blocked by
Cloudflare** (HTTP 403), whatever the User-Agent. Browsers on moxfield.com work
normally. git-moxfield never tries to evade this. It supports three honest paths:

1. **Server fetch.** Automatic refresh, used when it works. If Moxfield grants you an
   API User-Agent, put it in `MOXFIELD_USER_AGENT` and refresh becomes fully
   automatic. When blocked, server fetches pause for an hour
   (`MOXFIELD_BLOCK_BACKOFF_SECONDS`) and the UI switches to the bookmarklet.
2. **Bookmarklet (recommended today).** Open **Connect Moxfield** (`/setup`) and drag
   _Send to git-moxfield_ to your bookmarks bar. Click it on any Moxfield deck page.
   Your browser reads the deck and primer, as Moxfield's own page does, and hands
   them to git-moxfield. A _same tab_ variant exists for phones and in-app browsers.
3. **Paste JSON.** `/capture?mode=paste` explains which two URLs to open and paste.

Details, endpoints and failure handling: [`docs/moxfield-integration.md`](docs/moxfield-integration.md).

## Architecture

```
src/
  core/           Pure domain logic: canonical model, deterministic serialization,
                  hashing, semantic diff, card history, primer diff, Git file tree.
                  No I/O, no framework, no Moxfield.
  integrations/   DeckSource interface + Moxfield adapter (URL parsing, HTTP client,
                  lenient zod schemas, normalization, restore text, bookmarklet).
  server/         Config, logging, SQLite (Drizzle) schema and migrations,
                  repositories (all SQL), services (use cases), source registry,
                  Git export.
  app/            Next.js App Router pages, server actions, capture route handlers.
  components/     UI kit and deck components.
```

- **Dependency rule:** `app → services → (core, integrations, repositories)`, and
  `integrations → core`. ESLint enforces that `core` imports nothing from the outer
  layers, and that integrations depend only on core.
- **Moxfield isolation:** only `src/integrations/moxfield` knows Moxfield payload
  shapes. The rest of the app sees `RawSourcePayload` and the canonical
  `NormalizedDeck`. A second deck platform would be another `DeckSource`.
- **Two representations:** a lean _canonical snapshot_ with only user-controlled
  state, for diffs and hashes, plus the _raw payload_, gzip-compressed and
  content-addressed, for losslessness.
- **Storage:** SQLite with immutable, content-addressed snapshots and Git-like
  commits, branches (only `main` today), tags and notes. A derived
  `snapshot_cards` index powers card history and search.

Full design: [`docs/architecture.md`](docs/architecture.md). UX:
[`docs/ux.md`](docs/ux.md).

### Data model

| Table                           | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `workspaces`                    | Single `local` workspace; seam for multi-user auth later                           |
| `decks`                         | Tracked decks: source + external id, cached name, HEAD branch                      |
| `branches`                      | `main` per deck; experiments later (`kind`, `base_commit_id`)                      |
| `commits`                       | Immutable versions: parent, snapshot, message, Moxfield version, raw payload ref   |
| `snapshots` / `snapshot_cards`  | Canonical snapshots (sha256) and a derived per-card index                          |
| `raw_blobs`                     | gzip raw Moxfield payloads (sha256)                                                |
| `observations`                  | Latest fetches or captures of the live deck (the "working tree"), pruned on ingest |
| `version_tags` / `commit_notes` | Mutable annotations on versions                                                    |
| `card_catalog`                  | Display facts (type line, mana cost); not versioned                                |
| `app_settings`                  | Per-installation settings (e.g. the bookmarklet capture token)                     |

## Development

| Command                        | What it does                                                      |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm dev`                     | Next.js dev server on :3000 (this computer only)                  |
| `pnpm dev:lan`                 | Dev server reachable from your network (no auth unless set)       |
| `pnpm dev:mock`                | Dev server wired to the mock Moxfield (`data/mock.db`)            |
| `pnpm mock-moxfield`           | Mock Moxfield API, deck page and control API on :4010             |
| `pnpm seed:demo`               | Seed a demo deck with 8 versions (`DATABASE_PATH` selects the DB) |
| `pnpm build` / `pnpm start`    | Production build / server (this computer only)                    |
| `pnpm start:lan`               | Production server reachable from your network                     |
| `pnpm db:migrate`              | Apply migrations explicitly (also happens automatically on start) |
| `pnpm db:generate`             | Generate a migration after editing `src/server/db/schema.ts`      |
| `pnpm export:git <deck> [dir]` | Replay a deck's history into a new Git repository                 |
| `pnpm check`                   | typecheck + lint + format check + unit/integration tests          |

Database: SQLite file at `DATABASE_PATH` (default `data/git-moxfield.db`), WAL
mode. Back it up by copying the file while the app is stopped. Migrations live in
`drizzle/` and are committed. `0001_immutability_triggers.sql` is hand-written. The
scripts (`db:migrate`, `export:git`, `seed:demo`) read `.env.local` and the other
`.env*` files like the app does, so they use the same database.

Schema changes that SQLite cannot `ALTER` (a column's type, default or nullability,
foreign keys) make `pnpm db:generate` rebuild the table: copy into `__new_<table>`,
`DROP`, rename. Migrations run with foreign keys off and are checked with
`PRAGMA foreign_key_check` afterwards, so a rebuild neither fails nor cascades deletes
on existing data. But `DROP TABLE` also drops the table's triggers: a migration that
rebuilds `commits`, `snapshots`, `snapshot_cards` or `raw_blobs` must recreate their
triggers from `0001_immutability_triggers.sql`, and one that rebuilds `decks` must drop
`commits_immutable_delete` first and recreate it after the rename. See
`tests/integration/db/migrations.test.ts`, which upgrades a database holding history.

Exporting to Git:

```bash
pnpm export:git https://moxfield.com/decks/<publicId>
```

This writes `export/<publicId>`, with one commit per version (original message and
date) plus trailers, and tags `vN` and `<tag>/vN`. The files are
`deck.yaml`, `commanders.txt`, `mainboard.txt`, `sideboard.txt`, `considering.txt`,
`card-tags.txt` and `primer.md`. The export is deterministic, so it diffs nicely and
can be pushed to GitHub.

## Testing

```bash
pnpm test
```

Vitest unit and integration tests cover core, adapter, repositories and services,
using an in-memory SQLite and a fake Moxfield API. They take a few seconds.

```bash
pnpm test:e2e:install
```

```bash
pnpm test:e2e
```

Playwright runs desktop and mobile journeys against the mock Moxfield and a separate
dev server (`.next-e2e`, `data/e2e.db`). Stop any other `next dev` that uses
`.next-e2e` first.

Every test starts with the mock back to its seeded decks and the app's server-fetch
pause cleared (`POST /api/e2e/reset`, which exists only with `GIT_MOXFIELD_E2E=true`),
tracks a deck of its own, keeps the browser off the internet, and fails on browser
console errors, hydration warnings and uncaught page errors
(`tests/e2e/support/fixtures.ts`).

What is covered:

- **Semantic diff engine:**
  - every scenario from the spec: add, remove, mainboard ↔ considering,
    sideboard → mainboard, quantities, the same card in several zones, commander
    changes, a move combined with a quantity change, printing-only changes, primer-only
    changes, no change, comparing arbitrary versions;
  - plus fast-check property tests: applying the diff reproduces the target state,
    determinism, and move maximality.
- **Canonical serialization:** golden JSON and hash, idempotence, and shuffle
  invariance.
- **Moxfield adapter:** the live-captured fixture (sanitized), the legacy v2 shape,
  hostile primer markup, HTTP error mapping (Cloudflare block, 429 Retry-After, 5xx
  retry, timeouts), and the bookmarklet protocol.
- **Services:** the complete workflow, stale and concurrent commits, blocked fetch
  with capture fallback, tags, notes, card history and restore.
- **End-to-end journeys (desktop and phone):** the core loop with server fetching
  (track, commit, refresh, a move shown as one move, tags, history, version tabs,
  compare, card history, restore and copy to the clipboard); a blocked server with the
  same-tab bookmarklet; the popup bookmarklet for an untracked deck (desktop); pasting
  the deck JSON; a stale commit; and the phone layout (bottom navigation, touch commit
  form, no sideways scrolling on any page).

## Configuration

All optional. See [`.env.example`](.env.example).

| Variable                                  | Default                | Purpose                                                                |
| ----------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `DATABASE_PATH`                           | `data/git-moxfield.db` | SQLite file                                                            |
| `MOXFIELD_USER_AGENT`                     | —                      | Moxfield-issued User-Agent for server-side access                      |
| `MOXFIELD_SERVER_FETCH`                   | `auto`                 | `off` = bookmarklet/paste only                                         |
| `MOXFIELD_BLOCK_BACKOFF_SECONDS`          | `3600`                 | Pause after a Cloudflare block                                         |
| `MOXFIELD_MIN_REQUEST_INTERVAL_MS`        | `1000`                 | Spacing between Moxfield requests                                      |
| `REFRESH_COOLDOWN_SECONDS`                | `10`                   | Minimum time between refreshes of one deck                             |
| `AUTO_REFRESH_AFTER_SECONDS`              | `300`                  | Deck page refreshes in the background when older                       |
| `PUBLIC_APP_URL`                          | request origin         | URL baked into bookmarklets (e.g. a LAN address for your phone)        |
| `ALLOWED_HOSTS`                           | —                      | Other host names to answer to, e.g. `mybox.local` (see security notes) |
| `CAPTURE_ALLOWED_ORIGINS`                 | `https://moxfield.com` | Origins allowed to hand decks to `/capture`                            |
| `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` | —                      | HTTP Basic auth; recommended with `dev:lan` / `start:lan`              |

**Security notes.**

- Moxfield content is untrusted. It is validated with zod and rendered only as
  React text or as markdown without raw HTML (links limited to http, https and mailto;
  images not loaded).
- A strict CSP and security headers are set.
- The capture endpoints only accept same-origin JSON, or a form POST carrying the
  installation's capture token.
- Requests are only answered when addressed to an IP address, `localhost`, the host of
  `PUBLIC_APP_URL` or a name in `ALLOWED_HOSTS` (others get `421 Unknown host`). This
  stops DNS-rebinding attacks, in which a web page re-points its own domain name to
  your machine to read or change your decks. If you reach the app under another name
  (an mDNS name such as `mybox.local`, a reverse proxy's domain), list it in
  `ALLOWED_HOSTS`.
- The app listens on `127.0.0.1` by default, so other machines cannot reach it.
  `pnpm dev:lan` / `pnpm start:lan` expose it to your network, with no authentication
  unless `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are set: anyone on the network
  could then read your decks and untrack them. Use them on trusted networks only, and
  set the Basic auth variables.

### Using it from another device

To use git-moxfield (and its bookmarklets) from your phone, start it so that it
listens on your network, and bake its LAN address into the bookmarklets:

```bash
pnpm build
```

```bash
PUBLIC_APP_URL=http://192.168.1.20:3000 BASIC_AUTH_USER=me BASIC_AUTH_PASSWORD=secret pnpm start:lan
```

Put the variables in `.env.local` to keep them. Then open the LAN address on the phone
and install the bookmarklets from its setup page.

## Moxfield integration assumptions and limitations

Verified against live Moxfield on 2026-10-09.

- Deck data comes from `GET api2.moxfield.com/v3/decks/all/{publicId}`.
- The primer comes from `GET api2.moxfield.com/v1/decks/{internalId}/primer`. Note
  that this uses the deck's internal `id`, not the public id. The deck's
  `description` is only a short blurb.
- `version` is Moxfield's revision counter. It is shown as "Moxfield version".
- `uniqueCardId` identifies the card and stays the same across printings.
  `id`/`scryfall_id`/`set`/`cn` identify the printing.
- Boards: `maybeboard` is Moxfield's "Considering". Unknown boards are kept as
  `other:<name>` zones, never dropped.
- Private decks are not supported: anonymous reads only.
- Payload parsing is deliberately lenient. Unrelated field changes do not break
  ingestion. Missing essentials produce a clear `schema` error; partial problems become
  visible warnings.
- Bulk Edit format and behavior were derived from Moxfield's help pages and client
  code; they could not be tested against a logged-in account. See the restore
  limitations above.

## Known issues

- Server-side fetching is blocked by Cloudflare unless Moxfield grants a User-Agent,
  so the bookmarklet is the practical path today. If Moxfield adds a COOP header or a
  stricter CSP, the popup bookmarklet may stop working. The same-tab variant and paste
  remain.
- Restore cannot set commanders or the companion through Bulk Edit; these are manual
  steps. The primer is a separate paste into Moxfield's primer editor. Card tags (`#tag` / `#!tag`) are not restored, because
  Moxfield's JSON does not say whether a tag is deck-specific or global.
- Restore text uses `Front // Back` names for double-faced cards. Moxfield's own
  export currently writes `Front / Back`, and both are expected to resolve.
- The demo seed uses synthetic printings (`TST` set codes). Its restore text is not
  meant for real Moxfield decks.
- Single-user by design. There is a `workspaces` seam but no real accounts.
- Only one `next dev` may run per build directory. e2e uses `NEXT_DIST_DIR=.next-e2e`
  for that reason.

## Roadmap

1. **Experiments (branches).** "Start experiment from v36: Broodlord package". The
   `branches` table already exists, with `kind = 'experiment'` and `base_commit_id`.
   Commits get associated with the active experiment, and experiment tips can be
   compared.
2. **Outcomes.** Structured `commit_notes` kinds for tournament records (games, W/L,
   pod notes), with history views annotated by results.
3. **Search across history.** "Have I tried card X?", "when did I cut it and what
   replaced it?", "versions containing A and B". `snapshot_cards` already indexes
   this; it needs query UI.
4. **Packages.** User-defined card groups (seeded from Moxfield author tags), then
   package-level diffs ("Broodlord package: added").
5. **GitHub sync.** Push `export:git` output to a repository automatically.
6. **Official Moxfield access.** If Moxfield grants an API UA, enable background
   refresh on load. With an official write API, add opt-in restore write-back.
7. **Browser extension.** Replaces the bookmarklet where installation friction is
   acceptable, with no popup or CSP dependency.

## Architecture decision records

- [ADR 0001: Moxfield remains the editor](docs/adr/0001-moxfield-remains-the-editor.md).
  git-moxfield is a companion; it never competes with Moxfield's editor.
- [ADR 0002: No direct write-back in the MVP](docs/adr/0002-no-direct-write-back.md).
  There is no public API, credentials would be needed, and writing is destructive.
  Restore is a copy/paste export.
- [ADR 0003: History storage model](docs/adr/0003-history-storage-model.md).
  Content-addressed snapshots and Git-like commits in SQLite, with a deterministic
  Git export, instead of a Git repository per deck.
- [ADR 0004: Ingestion paths](docs/adr/0004-ingestion-paths.md). Server fetch,
  bookmarklet capture and paste, all through one normalizer, with no bot-protection
  evasion.
- [ADR 0005: Technology stack](docs/adr/0005-technology-stack.md). Next.js 16,
  TypeScript, SQLite/Drizzle, Tailwind, Vitest, Playwright.

---

Not affiliated with Moxfield. Magic: The Gathering is a trademark of Wizards of the Coast.
