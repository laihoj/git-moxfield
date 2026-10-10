# ADR 0008: Hosting for free on Netlify with Turso (libSQL)

- Status: accepted
- Date: 2026-10-10

## Context

git-moxfield is shared with a few friends and must cost nothing. Netlify's free plan
runs Next.js on short-lived serverless functions with no persistent disk, so the local
SQLite file cannot be the production database. Facts below were verified on 2026-10-10
by building the app with Netlify's runtime offline and by running the official
libSQL server locally (Turso Cloud itself was not available to test).

## Decision

**Netlify (free) for the app, Turso (free, libSQL) for the database.**

Netlify:

- Next.js 16 runs on Netlify's OpenNext adapter (`@netlify/plugin-nextjs`, detected
  automatically). Pages, route handlers and server actions run in one Node function in
  `us-east-2` (Ohio, fixed on the free plan); `src/proxy.ts` runs as an edge function
  (Deno with Node shims: `node:crypto` works, no filesystem, 50 ms CPU).
- Build: `pnpm run build`, publish `.next`. The custom `distDir` must stay `.next`
  (never set `NEXT_DIST_DIR` on Netlify). Node 24 (`.node-version`).
- Migrations run in the deploy, after the build, in the production context only.
  They never run on the request path (concurrent cold starts would race). At runtime the
  app only checks that the database has every migration it ships and fails clearly if
  not. Newer migrations are logged and tolerated: they run before the new deploy is
  published (and stay applied if publishing fails), so the live deploy and any deploy
  rolled back to must keep working on them. Migrations are therefore backward compatible
  (expand, then contract).
- Only production builds run. Deploy previews and branch deploys are skipped: on the
  free plan they would share the production database and environment.
- Limits that shape the code: 6 MB request bodies (an oversized body fails with 500
  before the app runs), 60 s per request, 300 credits a month (each production deploy
  costs 15; the site pauses when they run out, so there is never a bill).

Turso:

- A libSQL database (not the new `--tursodb` engine) in `aws-us-east-2`, next to the
  functions. Free plan: 5 GB, 500 M rows read and 10 M rows written a month; queries
  fail with `BLOCKED` when exhausted (no bill).
- The existing Drizzle migrations, including the immutability triggers, apply unchanged.
  Foreign keys and `ON DELETE CASCADE` are enforced (libSQL defaults foreign keys on;
  the app asserts it at startup).

**One driver everywhere: libSQL.** better-sqlite3 is removed.

- Production uses the HTTP client (`@libsql/client/http` via `drizzle-orm/libsql/http`):
  no native binary in the function bundle.
- Local development and tests use the same driver on `file:` and `:memory:` URLs
  (native binary loaded lazily, only for those schemes).
- The repository and service layers become async. Writes in one process are serialized
  by an in-process mutex (needed for local files and in-memory databases, harmless
  remotely).
- Transactions are short and never contain network calls to Moxfield (Turso aborts a
  write transaction that holds the lock for more than 5 s while another writer waits).
  Bulk writes use `batch()` (one round trip, atomic).
- Errors are classified by walking the `cause` chain: local errors carry extended
  SQLite codes, remote errors only `SQLITE_CONSTRAINT` plus the message text.

**Capture payloads are compressed in the browser.** The bookmarklet gzips the capture
envelope (CompressionStream) before handing it over, which turns a typical 0.8 MB deck
into about 0.1 MB. The server inflates it with a hard size limit (decompression-bomb
safe). This keeps every capture far below Netlify's 6 MB body limit and Turso's 5 MB
limit per stored value.

**Query costs are kept index-driven** (Turso bills rows read, including rows scanned):
card history and card search run off a `(card_key, snapshot_hash)` index instead of
scanning a deck's whole history.

## Consequences

- Hosting costs nothing; the worst case of running out of credits or rows is a paused
  site, not a bill.
- One driver and one SQL dialect in development, tests and production; local
  development still needs no cloud account.
- Deploying requires a Netlify account, a Turso account and a Git remote (Netlify builds
  from Git). The README walks through the exact steps.
- Per-process state (Moxfield block backoff, request throttle, deck locks) is per
  function instance in production. Correctness never depends on it: the database's
  compare-and-set on the branch head is what prevents conflicting commits.
- The app cannot fetch from Moxfield server-side in production either (cloud IPs are
  blocked by Cloudflare), so the bookmarklet stays the way decks arrive.

## Implementation notes (2026-10-10)

Built as decided. Details that were settled while building it, or differ from the text
above:

- **Client entries.** Remote URLs use `@libsql/client/http`; local ones use
  `@libsql/client/sqlite3`, imported lazily (the root `@libsql/client` entry resolves to
  the web client under Netlify's export conditions). Both are wrapped by the same
  `drizzle()` from `drizzle-orm/libsql/http`, so local and remote databases have one type.
  The function bundle still contains the libSQL native binary, traced because of the lazy
  import: about 7.5 MB of the 56 MB it unpacks to (20.9 MB zipped; Lambda allows 50 MB
  zipped), never loaded for remote URLs. The edge bundle has no database code.
- **The in-process mutex** is a FIFO write lock per database (`write-lock.ts`) that every
  transaction and write takes. For local databases every operation takes it, reads
  included, since libSQL fails a second local connection's write at once instead of
  queueing it. Waits are bounded (15 s), and a nested use from the holder fails at once
  instead of deadlocking.
- **Transactions** always open `BEGIN IMMEDIATE` (Drizzle's libSQL driver ignores the
  `behavior` option, so the guard opens it itself) and are retried as a whole, up to three
  times, after `busy`, a lock steal (`TRANSACTION_TIMEOUT`) or an expired stream. After
  any other failure the transaction is aborted and sends nothing more: over HTTP,
  statements sent after a server-side rollback would otherwise run in autocommit mode.
  Using the root database inside a transaction, or calling `db.transaction()` directly,
  throws. Locally, a statement that failed with `SQLITE_BUSY` stays active on its pooled
  connection and blocks every later commit on it (a libSQL bug), so the client is
  reopened after a `busy` on a local file.
- **Error classification** reports a primary key violation as `unique` in every mode
  (remotely the two are indistinguishable), quota exhaustion (`BLOCKED`) as
  `quota-blocked`, and over-long values as `too-big`. Logs never include a query's SQL or
  bound parameters (Drizzle puts both in its error).
- **Stored value cap.** The server rejects any value or row over 5,000,000 bytes; the
  repositories refuse values over 4,500,000 bytes (`MAX_STORED_VALUE_BYTES`) with a clear
  message. Local databases have no such limit, so the cap keeps both modes alike.
- **Migrations.** `pnpm db:migrate` refuses a local database when `NETLIFY=true`: the
  build container's disk is thrown away, so "migrating" it would hide an unset
  `TURSO_DATABASE_URL`. The app refuses the implicit local file on Netlify for the same
  reason. A remote database must have every migration of the build
  (`assertMigrationsApplied`); one with newer migrations is served with a warning, as
  decided above. That tolerance was added after verification reproduced the outage it
  prevents: before it, every cold start of the live deploy failed while a new deploy was
  being published. A local database migrated by a newer build is still refused.
- **Platform detection** (`src/server/platform.ts`): `NETLIFY=true` (builds) or `SITE_ID`
  (functions), but not `netlify dev`. It also makes `MOXFIELD_SERVER_FETCH` default to
  `off` there, since Moxfield blocks cloud servers.
- **Capture encoding.** `gm-gzip-base64url:` plus the gzip in base64url, without padding.
  The envelope stays at version 2: the tag makes the encoding self-describing, and
  untagged text is plain JSON, so older bookmarklets keep working. Limits: 2,000,000
  encoded characters, 8,000,000 bytes inflated, 1,400,000 bytes of plain JSON; the capture
  routes accept at most 2,865,536 (JSON) and 4,265,536 (form) bytes, which stays under 6 MB
  even if the platform base64-encodes the body. A typical deck travels as about 0.15 MB.
- **Netlify configuration.** Previews and branch deploys are cancelled with
  context-scoped `ignore = "exit 0"` (rather than a test of `$CONTEXT`, which no
  documentation guarantees while `ignore` runs). The adapter is not pinned, so it keeps
  receiving Netlify's fixes. `NODE_ENV` must not be set there: the build and the
  migrations need devDependencies. `.netlify/` is ignored by Git, ESLint and Prettier.
- **Card queries.** The `(card_key, snapshot_hash)` index (migration 0008) cut a card
  history from 5,111 rows read to 110 on the measured deck; tests pin the query plans.
- **Moving local history** is an operator command, `pnpm import:local`, run from a
  computer against Turso, not an upload in the app: a whole history can exceed the 6 MB
  request limit and the 60 s request time. It writes content-addressed rows in batches
  of at most 2 MB or 50 rows and each deck's history in one short transaction, so no
  transaction holds the server's write lock for long.
- **Verification.** Everything remote was verified against the official libSQL server
  (sqld 0.24.32) with token authentication on, and the bundle with an offline
  `netlify build` (netlify-cli 27.12.0), including a cold start of the bundled handler
  (import 108 ms, first request 293 ms) and a full browser journey on `next start`
  against sqld.
  Not yet verified on Turso Cloud or Netlify themselves: real latency between them, the
  exact shape of the quota error, and how the build servers apply `ignore`.
- **Issues found by that verification, all fixed before the first deploy:** Next.js
  link prefetching multiplied function invocations and rows read per page view (no
  link or form prefetches any more: 18 instead of 373 requests and 3,884 instead of
  39,457 rows read across 18 page views); a capture rewrote every card fact of the deck
  (unchanged facts are skipped); and two captures of one deck within milliseconds on
  different instances could make a concurrent read fail (observations and HEAD are now
  read together with their snapshots in one statement; 0 failures in about 4,700
  stress-test rounds, against about 5% before).
