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
  app only checks that the database is migrated and fails clearly if not.
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
