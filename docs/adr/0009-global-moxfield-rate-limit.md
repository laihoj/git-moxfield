# ADR 0009: One request limit for every instance, kept in the database

- Status: accepted
- Date: 2026-10-12

## Context

Moxfield issued git-moxfield a User-Agent for server-side access, on terms: at most
**one API call per second**, no profit, never share the User-Agent, no support. Moxfield
also said that a 429 always comes before a 403, and that a ban only follows continued
abuse: the app must notice 429s and slow down.

Until now the request throttle and the backoff after a block lived in the process
(`MoxfieldHttpClient`): one queue, one `lastRequestStart`, one pause. On Netlify the app
runs as serverless functions, an unknown number of instances at once, anywhere in AWS
(ADR 0008). Two instances each keeping one call per second would together make two. The
deck pages also refreshed on their own when opened (`AUTO_REFRESH_AFTER_SECONDS`), so the
request rate followed page views, not decisions of users.

Browser captures (the bookmarklet) are the user's own browser on moxfield.com, without the
User-Agent, and out of scope.

## Decision

**The limit lives in one row of the shared database**, `moxfield_rate` (migration 0010,
expand-only: a new table and its single row; earlier deploys ignore it). Every instance
of a deployment uses the same Turso database, so the database is the single source of
truth.

**Reserve, then wait.** Before every request to Moxfield (deck, primer, every retry, from
refresh, tracking, relinking or fetch-on-commit), the instance runs one statement:

```sql
UPDATE moxfield_rate
SET next_slot_ms  = CASE WHEN allowed THEN max(now, next_slot_ms, backoff_until_ms) + interval ELSE next_slot_ms END,
    last_grant_ms = CASE WHEN allowed THEN max(now, next_slot_ms, backoff_until_ms) ELSE NULL END
WHERE id = 1
RETURNING last_grant_ms, now, …
```

where `now` is the **database's** clock (`unixepoch('subsec')`, milliseconds; SQLite
evaluates it once per statement), `interval` is `MOXFIELD_MIN_REQUEST_INTERVAL_MS`
(doubled while slowed down after a 429) and `allowed` means "not paused, and the slot is
at most 10 s away". One statement is atomic, and the database serializes writes, so no
two instances can get the same slot. The instance sleeps `slot - now` and sends the
request. Instance clocks never take part, so clock skew between instances cannot matter;
each instance only measures how long to wait, with its monotonic clock.

- **Late starts.** A request must never start before its slot, and that holds: the wait
  is measured from after the database answered. It may start late (a slow answer, a busy
  event loop), which brings it closer to the next instance's slot. The instance therefore
  bounds its lateness (the time from sending the reservation to sending the request,
  minus the wait) and gives the slot up, reserving another, when it could exceed
  `interval - 1250 ms`. Two starts are thus at least 1.25 s apart: Moxfield's 1 s plus
  250 ms for the variable path to Moxfield.
- **Interval.** Default 2 s; never below 1.5 s against Moxfield's API (the configuration
  refuses less; a stand-in such as the test mock may use less). 2 s leaves 750 ms of
  room for a late start.
- **Busy.** A slot more than 10 s away is refused at once with a "busy, try again in N s"
  outcome (`rate-limited`), instead of holding a request (Netlify allows 60 s).
- **Re-check.** A request that had to wait reads the row again before it is sent: a 429
  or a pause that arrived meanwhile cancels it.
- **Fail closed.** If the database cannot be opened, the statement fails, or the row is
  missing, nothing is sent to Moxfield (`unavailable`).

**429: every instance slows down together.** The instance that receives it records it in
the same row, in one statement: no request starts before `now + pause`, where the pause
is Moxfield's `Retry-After` when present (capped at 24 h as a sanity bound), else an
exponential backoff (30 s, doubling with each 429 in a row, at most 15 min). For 10 min
after the pause the interval is doubled. A 429 within that slow period continues the
series; after it, everything is back to normal on its own.

**The firewall: pause until an operator resumes.** What Moxfield's staff described as
the firewall (a 403 whose body is not JSON: an HTML block page, a `cf-ray` page, plain
text or nothing), a Cloudflare challenge (`cf-mitigated: challenge`, at any status) or any
HTML answer where JSON belongs pauses server fetching for every instance.

A 403 the API answers **in JSON** is the API saying the deck is private: like a 401 it
fails that deck only ("private or not accessible"), and nothing pauses. Unless the JSON
looks like a rate limit, abuse protection or a ban (it mentions rate, limit, throttling,
too many, block, ban, abuse, firewall, captcha, challenge, Cloudflare, suspended or
denied) or cannot be read: then it pauses everything, erring on the side of stopping,
since a false alarm only costs an admin's click. The row keeps the first reason and when it happened; status panels,
Connect Moxfield and the Admin page show them. It ends only when an operator resumes it:
the Admin page's **Resume** button, or `pnpm moxfield resume` against the production
database.

**No background fetching.** Deck pages no longer refresh themselves
(`AUTO_REFRESH_AFTER_SECONDS` is gone). The server asks Moxfield only when a user
refreshes, tracks or relinks a deck, and before a commit (fetch-on-commit).

**One choke point.** `src/integrations/moxfield/http-client.ts` is the only code that sends
requests to Moxfield, and it requires a limiter. A test fails when other server code makes
HTTP requests, when anything else builds the client or the deck source, or when any
service path sends a request the limiter did not admit
(`tests/integration/moxfield-choke-point.test.ts`).

**The User-Agent is a secret.** Set only in the production site's Netlify environment
variables. It is a private field of the configuration (`MoxfieldUserAgent`), so logging or
serializing the configuration never shows it, and no log line or error contains it. An
instance with the User-Agent configured outside the Netlify production deployment (a
laptop, `netlify dev`, a preview, a second site) warns loudly at startup, on Connect
Moxfield and on the Admin page: another database keeps a separate limit, so the two
together could exceed one call per second. Each deployment needs a User-Agent of its own.

## Consequences

- Every request to Moxfield costs one extra write (and, when it had to wait, one read) on
  Turso, in the same region: a few milliseconds and far within the free plan.
- At most one request every 2 s for the whole installation. A refresh is two requests
  (deck and primer); a commit adds two more. With a few friends this is never noticed;
  under a burst, users get "busy, try again in N s" instead of the app exceeding the limit.
- A refusal stops server fetching until an operator looks. That is deliberate: resuming
  automatically after a ban warning is exactly the continued abuse Moxfield warned about.
  Without a Moxfield-issued User-Agent (local development) the first request is usually
  blocked, and server fetching stays paused until resumed.
- The database is now required for server fetching: when it is down, so is fetching
  (as is everything else).
- ADR 0008's note that the Moxfield throttle and block backoff are per instance is
  superseded.

## Verification (2026-10-12)

- libSQL 3.45.1 (local `file:` databases and sqld 0.24.31) returns `unixepoch('subsec')`
  with millisecond resolution, the same value for every use within one statement.
- 40 reservations sent at once by 4 clients with separate write locks against sqld got 40
  distinct slots, exactly one interval apart (`tests/remote/moxfield-rate.test.ts`).
- Starts of admitted requests, interval 1.5 s: 4 processes with clocks skewed by up to 7 h
  against sqld, 12 requests: minimum spacing **1498.0 ms**; 3 clients in one process:
  **1496.4 ms**; 4 connections to one local file, 8 requests: **1498.8 ms**. The few
  milliseconds below the interval are timer jitter of the earlier start; the guaranteed
  bound is 1250 ms.
- Not verified on Turso Cloud itself (expected to behave as sqld: same libSQL), nor
  against Moxfield with the issued User-Agent.
