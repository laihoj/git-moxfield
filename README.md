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

**For you and your friends.** Everyone signs in with their own bookmarklet, the same one
that sends decks from Moxfield: no passwords, no email. Each person's decks and history
are private to them, and a read-only link shows a deck's history to anyone you give it
to. Run git-moxfield on your own computer, or host one instance for free on Netlify and
Turso and invite your friends to it.

---

## Contents

- [Features](#features)
- [Quick start (on your computer)](#quick-start-on-your-computer)
- [How it works](#how-it-works)
- [Accounts and sharing](#accounts-and-sharing)
- [Connecting Moxfield (important)](#connecting-moxfield-important)
- [Deploy for free (Netlify + Turso)](#deploy-for-free-netlify--turso)
- [Free plans and their limits](#free-plans-and-their-limits)
- [Moving your local history to the hosted instance](#moving-your-local-history-to-the-hosted-instance)
- [When a deck is deleted and made again on Moxfield](#when-a-deck-is-deleted-and-made-again-on-moxfield)
- [Architecture](#architecture)
- [Development](#development)
- [Testing](#testing)
- [Configuration](#configuration)
- [Security notes](#security-notes)
- [Moxfield integration assumptions and limitations](#moxfield-integration-assumptions-and-limitations)
- [Known issues](#known-issues)
- [Roadmap](#roadmap)
- [Architecture decision records](#architecture-decision-records)

## Features

- **Track** any public or unlisted Moxfield deck by URL, or send it from Moxfield with
  the bookmarklet.
- **Status at a glance.** "Uncommitted changes", Moxfield's edit time, and Moxfield
  version vs. the committed version ("Moxfield version 143 · v47 committed at 137").
- **Semantic diff.** Additions, removals, quantity changes and moves between zones,
  commander changes, primer line diffs, and deck info. Printing-only changes are
  cosmetic and shown separately.
- **Commit** the current Moxfield state with a message (a suggestion is generated
  from the diff), an optional description (the message's body, as in Git: a brief
  subject line, elaboration below) and optional tags. Versions are immutable and
  content-addressed.
- **MTG or cEDH view.** The default shows every board. The cEDH view shows the sleeved
  deck only: the sideboard and Considering are out of sight, and a card moving in or out
  of the mainboard reads as an add or a cut, so resleeving is a checklist. Remembered per
  browser; nothing stored changes.
- **History timeline** with tag filters and per-version stats. Each version page
  shows metadata, the diff to its parent, the full deck grouped by type, the primer
  and the primer diff.
- **Compare** any two versions, or any version against the current Moxfield deck.
- **Card history.** Where a card has been over time ("v21 moved to Considering, v28
  restored to Mainboard"), derived from snapshots, plus card search across a deck's
  history.
- **Restore to Moxfield.** Paste-ready Bulk Edit text per board, copy buttons,
  step-by-step instructions and explicit limitations. Nothing is ever written to
  Moxfield.
- **Tags and notes** on versions (`tournament`, `stable`, `testing`, …). Notes are
  stored as structured annotations, ready for tournament results later.
- **Accounts without passwords.** Your bookmarklet is your key: running it on a Moxfield
  deck sends the deck and signs that browser in. Friends join with an invite link; a
  device link (with a QR code) signs in a phone; an admin can help someone back in with a
  recovery link.
- **Share links.** A read-only link to a deck's committed history (versions, compare,
  card history, restore text) for anyone, no account needed. Notes only if you include
  them; revoke a link at any time.
- **Decks made again keep their history.** A deck deleted on Moxfield and made again
  gets a new link; point the git-moxfield deck at it ("Change Moxfield deck", or
  "Continue an existing deck's history" when the bookmarklet sends the new copy) and its
  versions carry on.
- **Export to Git.** Replay a deck's history into a real Git repository, one commit
  per version.
- **Local or hosted.** One SQLite (libSQL) file on your computer, or a free Netlify site
  with a free Turso database. `pnpm import:local` moves your local history there.
- **Responsive and PWA-friendly.** The core loop works on a phone: status, diff,
  commit, history, copy a restore.

## Quick start (on your computer)

Requirements: **Node.js 24 LTS** (≥ 22.12 works; Node 25 works but is end-of-life),
**pnpm 10**, and Git (only for `export:git`).

```bash
pnpm install
```

```bash
pnpm dev
```

1. Open <http://localhost:3000>. The local database (`data/git-moxfield.db`, a SQLite
   file opened with libSQL) is created and migrated automatically. The app listens on
   this computer only (`127.0.0.1`); to use it from your phone, see
   [Using it from another device](#using-it-from-another-device).
2. A new installation has no admin yet, and the sign-in page says so. Its **setup code**
   is in the terminal that runs `pnpm dev`, printed when the first page is requested
   (and again whenever `/claim` is opened), as a log line like:

   ```
   {"time":"…","level":"warn","scope":"auth","message":"git-moxfield has no admin yet. To claim it, open /claim and enter the setup code ABCD-EFGH-JKMN","path":"/claim"}
   ```

   `pnpm users claim-code` prints it too.

3. Click **Set up git-moxfield** (`/claim`), enter the code and your name. You are now
   the admin. If the database already holds history from before accounts (an
   installation from before [ADR 0006](docs/adr/0006-accounts-with-bookmarklet-keys.md)),
   your account adopts it: every deck and version is kept.
4. On **Connect Moxfield** (`/setup`), create your bookmarklet and drag
   _Send to git-moxfield_ to your bookmarks bar (see
   [Connecting Moxfield](#connecting-moxfield-important)).

Try it without touching Moxfield, using a seeded demo history. The seed prints a
one-time link that signs a browser in as its demo user:

```bash
DATABASE_PATH=data/demo.db pnpm seed:demo
```

```bash
DATABASE_PATH=data/demo.db MOXFIELD_SERVER_FETCH=off pnpm dev
```

Or run against the included **mock Moxfield** (a fake API plus a deck page you can edit;
`pnpm dev:mock` uses its own database, `data/mock.db`, which you claim like above):

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
2. **Update** git-moxfield's view of the deck. Click the **Send to git-moxfield**
   bookmarklet on the Moxfield deck page (see below), or _Refresh_ where server fetching
   works (not on the hosted instance).
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
  Commit ids are Git-like hashes over the deck's Moxfield reference, snapshot, parent,
  time, Moxfield version and message. You see them as `vN`; short ids are secondary.
- Commits are immutable. Database triggers reject updates and deletes; only deleting
  the whole deck removes its history. Tags and notes are separate, mutable
  annotations.
- **Fetch on commit.** When server fetching works, git-moxfield fetches Moxfield again
  right before committing. If the deck changed since you reviewed it, the commit is
  refused and you see the new diff. Concurrent commits are guarded by an
  expected-HEAD check in the database, also across the hosted instance's servers.

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
from either side of a Compare. The whole export also downloads as a text file, in which
each section says how it is restored: "Paste into", "Set on Moxfield" (a manual step) or
"Reference only". The page also lists limitations: alter/proxy flags, card tags,
non-English printings, multiple printings of one card. Restoring never changes
git-moxfield's history. After you save in Moxfield, the restored state shows up as
uncommitted changes.

## Accounts and sharing

Accounts are designed in [ADR 0006](docs/adr/0006-accounts-with-bookmarklet-keys.md),
access and share links in [ADR 0007](docs/adr/0007-access-control-and-share-links.md).

- **Signing in.** There is no password. Each bookmarklet carries a personal key; running
  it on a Moxfield deck sends the deck to your account and signs that browser in. The
  same-tab bookmarklet asks once before it signs a browser in that is signed out or
  signed in as someone else.
- **More devices.** _Account › Sign in on another device_ makes a one-time device link
  (15 minutes, also shown as a QR code). Or create a bookmarklet in each browser.
- **Bookmarklets** are listed in Account with their last use. Revoking one also signs
  out the browsers it signed in. A lost bookmarklet cannot be shown again: create a new
  one.
- **Sign out** this browser, other browsers, or everywhere, from Account.
- **Admins** (the person who claimed the installation, and anyone they make admin)
  invite people, disable accounts and make recovery links on **Admin**. Admins manage
  accounts, not decks: no admin page shows anyone's decks.
- **Invites** are one-time links valid for 7 days. The friend picks a display name, gets
  an account with its own private decks, and creates a bookmarklet on the next page.
- **Recovery links** (24 hours) are for someone who lost every bookmarklet and signed-in
  device. Using one signs their other devices out, revokes their bookmarklets and share
  links, and their Account page shows which admin's link it was.
- **Share links.** On a deck's **Share** page, create a read-only link (optionally with
  your notes), see when each link was last viewed, and revoke it. Whoever has the link
  sees the deck's committed history, never your uncommitted changes or where the deck is
  on Moxfield, and can copy any version into a Moxfield deck of their own.

## Connecting Moxfield (important)

Moxfield has **no public API**. Its FAQ says the API is private, and that it
occasionally helps personal, non-commercial projects that contact
support@moxfield.com. As of 2026-10-09, **server-side requests are blocked by
Cloudflare** (HTTP 403), whatever the User-Agent. Browsers on moxfield.com work
normally. git-moxfield never tries to evade this. It supports three honest paths:

1. **Bookmarklet (recommended).** Open **Connect Moxfield** (`/setup`), create a
   bookmarklet (name it after the browser, e.g. "Laptop Chrome") and drag
   _Send to git-moxfield_ to your bookmarks bar. Click it on any Moxfield deck page:
   your browser reads the deck and primer, as Moxfield's own page does, compresses them
   and hands them to git-moxfield. A _same tab_ variant exists for phones and in-app
   browsers, which block popups. Each bookmarklet carries your personal key and is shown
   only once.
2. **Server fetch.** **Refresh** fetches the deck from Moxfield, and every commit checks
   it first; nothing is fetched in the background. It works when Moxfield grants you an
   API User-Agent (`MOXFIELD_USER_AGENT`; see
   [Turn on server fetching](#turn-on-server-fetching-with-moxfields-user-agent)). All
   servers of an installation together send at most one request every 2 s (Moxfield's
   terms allow one per second), a 429 slows all of them down, and Moxfield's firewall
   answering pauses server fetching until an admin resumes it
   ([ADR 0009](docs/adr/0009-global-moxfield-rate-limit.md)); the UI then switches to the
   bookmarklet. On Netlify it is off by default (`MOXFIELD_SERVER_FETCH=off`):
   Cloudflare blocks cloud servers without the User-Agent.
3. **Paste JSON.** `/capture?mode=paste` explains which two URLs to open and paste.

Details, endpoints and failure handling: [`docs/moxfield-integration.md`](docs/moxfield-integration.md).

## Deploy for free (Netlify + Turso)

One shared instance for you and your friends at `https://<name>.netlify.app`: the app
runs on Netlify's free plan, its database is a libSQL database on Turso's free plan. The
choice and its limits are recorded in
[ADR 0008](docs/adr/0008-hosting-netlify-and-turso.md). You need a GitHub account, a
Netlify account (sign up with GitHub), a Turso account, and this repository on your
computer with `pnpm install` done.

1. **Install the Turso CLI and sign in.**

   ```bash
   brew install tursodatabase/tap/turso
   ```

   (Linux and Windows/WSL: `curl -sSfL https://get.tur.so/install.sh | bash`.) Then
   `turso auth signup` for a new account, or `turso auth login`.

2. **Create the database in Ohio**, next to Netlify's functions (a free Netlify site's
   functions always run in AWS `us-east-2`, Ohio, and every page makes several queries):

   ```bash
   turso db create git-moxfield --location aws-us-east-2
   ```

   ```bash
   turso db show git-moxfield
   ```

   `turso db show` must list the location `aws-us-east-2`. Create a **libSQL** database,
   as above: do not add `--tursodb` (Turso's newer engine, which git-moxfield is not
   built or tested for). A database lives in its group's location; on a new account the
   command creates the `default` group in `aws-us-east-2`. If your account already has a
   group elsewhere (`turso group list`), the database may end up there: the app works,
   but every query then crosses regions and pages get slower.

3. **Get the database URL and an auth token.**

   ```bash
   turso db show git-moxfield --url
   ```

   ```bash
   turso db tokens create git-moxfield --expiration never
   ```

   The URL looks like `libsql://git-moxfield-<your-org>.turso.io`. The token gives full
   access to the database: keep it secret (it goes into Netlify's settings and, when
   you run a script against the database, your shell, never into a file in the
   repository). A token with an expiration would take the site down when it expires.

4. **Push the repository to GitHub.** Netlify builds from Git. Create an empty private
   repository on GitHub (no README, no license), then push the `main` branch:

   ```bash
   git remote add origin git@github.com:<you>/git-moxfield.git
   ```

   ```bash
   git push -u origin main
   ```

5. **Create the Netlify project.** In Netlify: _Add new project › Import an existing
   project › GitHub_, allow access to the repository and pick it. The build settings come
   from [`netlify.toml`](netlify.toml) (build command `pnpm run build`, publish directory
   `.next`, Node 24): leave them as they are, with no base directory, and deploy the
   `main` branch. This first deploy fails at its last step, the migration, which
   refuses to run without `TURSO_DATABASE_URL`. That is expected, and failed deploys cost
   no credits. (If the import page already lets you choose the project name and add
   environment variables, do steps 6 and 7 there, and the first deploy succeeds.)

6. **Choose the address.** Netlify names the project at random (`brave-otter-123abc`).
   Rename it under _Project configuration › General › Project details › Change project
   name_; the app's address is then `https://<name>.netlify.app`.

7. **Set the environment variables** under _Project configuration › Environment
   variables_. They reach both the build (where the migrations run) and the running app.
   Never put them in `netlify.toml`: that file is public, and its variables reach only
   the build.

   | Variable                | Value                                                                           |
   | ----------------------- | ------------------------------------------------------------------------------- |
   | `TURSO_DATABASE_URL`    | `libsql://git-moxfield-<your-org>.turso.io` (step 3)                            |
   | `TURSO_AUTH_TOKEN`      | the token from step 3                                                           |
   | `PUBLIC_APP_URL`        | `https://<name>.netlify.app`: the app answers only to this host name (else 421) |
   | `MOXFIELD_SERVER_FETCH` | optional: `off` is already the default on Netlify                               |

   Never set `NEXT_DIST_DIR`, `NODE_ENV` or `GIT_MOXFIELD_E2E` there. Changed variables
   take effect with the next deploy.

8. **Turn off deploy previews and branch deploys** under _Project configuration › Build
   & deploy › Continuous deployment › Branches and deploy contexts › Configure_: Branch
   deploys "Deploy only the production branch", Deploy Previews "Don't deploy pull
   requests". On the free plan they would get the production variables, and so read and
   write the production database. `netlify.toml` cancels such builds anyway; this keeps
   them from starting.

9. **Deploy.** _Deploys › Trigger deploy_ (or push to `main`). Production builds run
   `pnpm run build && pnpm run db:migrate`: if the build succeeds, the migrations are
   applied to the Turso database (the deploy log shows "Applied N migrations" and
   "Referential integrity verified"), and only then is the deploy published. A failed
   migration fails the deploy, and the previous one keeps serving. "Refusing to migrate
   … TURSO_DATABASE_URL is not set" means step 7 is missing; "Server returned HTTP
   status 401" means the token is wrong. Each successful production deploy costs 15 of
   the free plan's 300 monthly credits.

10. **Claim it.** Open `https://<name>.netlify.app`. The sign-in page says it has no
    admin yet: click **Set up git-moxfield**. The setup code is in the function log:
    _Cloud compute › Functions_, open the Next.js server handler (the project's one
    function) and look for "setup code" ("git-moxfield has no admin yet. To claim it,
    open https://<name>.netlify.app/claim and enter the setup code …"). Every new
    function instance prints it on its first request, and opening `/claim` prints it
    again. Or print it from your computer:

    ```bash
    TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… pnpm users claim-code
    ```

    Enter the code and your name: you are the admin. Then create your bookmarklets on
    Connect Moxfield.

11. **Invite your friends.** _Admin › Invite someone › Create invite link_, then send
    each person their link privately (one link per person, valid for 7 days). They pick
    a display name and create their own bookmarklet; their decks are private to them.

12. **Bring your local history** (optional): see
    [Moving your local history to the hosted instance](#moving-your-local-history-to-the-hosted-instance).

### Turn on server fetching with Moxfield's User-Agent

Optional, and only if Moxfield issued you a User-Agent. Its terms: **at most one API call
per second**, no profit, never share the User-Agent, no support. git-moxfield keeps the
limit for every function instance together through the database
([ADR 0009](docs/adr/0009-global-moxfield-rate-limit.md)), so:

- **The User-Agent is a secret.** Set it only in the production site's Netlify
  environment variables, never in `.env`, `.env.local` or any other file, chat or
  issue. Logs and pages never show it.
- **Only one deployment uses it.** Each deployment (another site, `netlify dev`, your
  computer) has a database of its own and so a limit of its own: together they could
  exceed one call per second. A deployment that needs server fetching needs a User-Agent
  of its own. git-moxfield warns loudly when the User-Agent is configured anywhere but in
  Netlify's production deployment.

1. In Netlify, _Project configuration › Environment variables › Add a variable_:
   `MOXFIELD_USER_AGENT` with the value Moxfield gave you, scope **Functions** (at least),
   deploy context **Production**, and mark it **Contains secret values**. Paste it there
   and nowhere else.
2. Add `MOXFIELD_SERVER_FETCH` = `auto` (production context).
3. Leave `MOXFIELD_MIN_REQUEST_INTERVAL_MS` unset: the default is one request every
   2,000 ms. It can be lowered to 1,500 at the least; the app refuses anything lower
   against Moxfield.
4. Deploy (_Deploys › Trigger deploy › Deploy site_). The deploy applies migration 0010,
   which adds the limiter.

**One safe manual test.** Pick one public deck of your own, then:

1. Open _Admin_ (signed in as the admin). _Server fetching from Moxfield_ must say
   "Moxfield-issued User-Agent configured", "Interval 2 s" and "Never rate limited",
   with no warning.
2. Open the deck's page and click **Refresh** once. Two requests go out (deck and
   primer, 2 s apart): the page shows "Updated from Moxfield" (or "checked just now").
3. Do not click again for a minute, and do not test with loops or several tabs.
4. If the page says "Moxfield asked us to slow down", wait: it ends on its own. "The deck
   is private" concerns that deck only: make it public or unlisted on Moxfield. If it
   says "Moxfield blocked the server", Moxfield's firewall answered and server fetching
   is paused for everyone: do not resume it right away. Read the reason on _Admin_, find
   out why (is the User-Agent exactly the one Moxfield issued?), then resume on _Admin_
   or with `pnpm moxfield resume`.

To switch it off again, set `MOXFIELD_SERVER_FETCH` to `off` and deploy. From your
computer, `pnpm moxfield status` (with `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` of the
production database in your shell, not in a file) shows the state, and
`pnpm moxfield resume` resumes after a refusal; neither contacts Moxfield nor needs the
User-Agent.

**Updating.** Every push to `main` builds, migrates and publishes a new deploy (15
credits). Migrations run before publishing, so the deploy still live keeps serving on
them for a moment; that is why every migration stays compatible with the previous
release (expand, then contract), and why the app tolerates, and logs, a database that is
ahead of it, including after a rollback to an earlier deploy.

**Backups.** Turso's free plan keeps a day of point-in-time restore. For a copy of your
own, `turso db shell git-moxfield .dump > git-moxfield.sql` writes a SQL dump, and
`turso db create <name> --from-dump git-moxfield.sql` makes a database from one. A dump
holds everyone's decks and account records: keep it private.

**What runs where.** Netlify serves the static assets from its CDN, runs `src/proxy.ts`
(host check, session cookie refresh) as an edge function in front of every page, and
runs pages, server actions and the capture endpoints in one Node function in Ohio, which
talks to Turso over HTTPS. With server fetching off (the default there), the server never
contacts Moxfield: decks arrive through your browser. With it on, the server asks
Moxfield only when someone refreshes, tracks or relinks a deck, or commits. See
[`docs/architecture.md`](docs/architecture.md#deployment).

## Free plans and their limits

Neither plan bills you: when a limit is reached, things stop until the next month.

- **Netlify:** 300 credits a month. A successful production deploy costs 15 (failed
  deploys and the disabled previews cost nothing); compute costs 10 per GB-hour,
  bandwidth 20 per GB and web requests 2 per 10,000. When the credits run out, every
  project of the account is paused ("Site not available") until the next month.
- **Turso:** 5 GB of storage, 500 million rows read and 10 million rows written a month.
  Over a limit, every query fails with `BLOCKED` (overages are off unless you turn them
  on), so pages show "Something went wrong" until the next month.

What that means in practice:

- **Deploys are the cost you control.** 20 deploys would use every credit before anyone
  visits the site; push to `main` in batches, a few times a month at most.
- **Rows.** Measured against the official libSQL server with a 100-card deck: a capture
  that changes the deck writes about 430 rows, a commit about 10; a page view reads
  30 to 450 rows, at most about 850 (a version page). Links never prefetch, so a page
  view is one request. That is roughly 20,000 captures and well over 500,000 page views
  a month.
- **Platform limits** that shape the app: request bodies of at most 6 MB (captures are
  compressed in the browser: a typical deck travels as about 0.15 MB), 60 seconds per
  request, functions in Ohio only. Turso refuses values over 5 MB; the app refuses to
  store anything over 4.5 MB with a clear message.

## Moving your local history to the hosted instance

`pnpm import:local` copies the decks of a git-moxfield database file (a local
installation's `data/git-moxfield.db`) into the database git-moxfield is configured
with, into one user's workspace. Run it on your computer, pointed at the Turso database.
Claim or accept an invite on the hosted instance first, so that your user exists there,
then:

```bash
TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… \
  pnpm import:local -- --from data/git-moxfield.db --to-user "Your name" --dry-run
```

The dry run lists each deck as `import`, `skip` (already imported) or `CONFLICT`, and
writes nothing. Run the same command without `--dry-run` to import.

- **The source is never changed.** The file (with its `-wal` and `-journal` files) is
  copied to a private temporary folder, and only the copy is opened and brought up to the
  current schema. The local app may keep running. A database written by a newer
  git-moxfield is refused.
- **Whose decks.** The source's `local` workspace when it has decks (where an
  installation from before accounts keeps them, adopted by whoever claimed it), else its
  first admin's. `--from-workspace <workspace id | user id | name>` picks another one;
  the output lists the workspaces it did not read. `--deck` (repeatable; a Moxfield URL,
  Moxfield id or git-moxfield deck id) imports only those decks.
- **Whose account.** `--to-user` takes a user id or display name of the target database.
- **What is copied.** Each deck with its versions (same ids, dates and messages), tags,
  notes, its latest Moxfield state, its earlier Moxfield decks and its cards' details.
  Accounts, sessions, bookmarklets, invites and share links are not copied.
- **Checked first, written in small steps.** Every version and payload is verified
  against its content hash before anything is written, so a damaged source writes
  nothing. Content goes in batches of at most 2 MB, then each deck's history in one
  transaction, then a check that the copy matches.
- **Running it again is safe.** Decks imported before are skipped. A deck the user
  already tracks there with other versions (or whose versions are stored in another
  account of that instance already) stops the whole import, and nothing is written,
  unless `--skip-existing` leaves those decks out.

Exit codes: 0 done (or nothing to do), 1 refused or failed, 2 wrong usage. `--help`
prints every option.

## When a deck is deleted and made again on Moxfield

Moxfield gives the new copy a new link. Point the git-moxfield deck at it: its versions
stay, and the next commit continues from the latest one.

- **With the popup bookmarklet** (desktop): run it on the new deck. git-moxfield sees a
  deck it does not track and offers **Or continue an existing deck's history**; the deck
  of the same name is preselected when there is exactly one. Click **Continue
  "&lt;deck&gt;"**: the deck page then shows how the new copy differs from your latest
  version, ready to commit.
- **From the deck page:** the **Moxfield deck** panel on the Status page has **Change
  Moxfield deck**. Paste the new deck's URL; then send the deck with the bookmarklet (or
  it is fetched right away where server fetching works). The "Deck not found on
  Moxfield" message links there too.
- **With the same-tab bookmarklet** (phones), a deck git-moxfield does not track is
  tracked as a new deck at once. Stop tracking that new deck (it has no versions, so
  nothing is lost), then change the old deck's Moxfield deck as above; git-moxfield
  explains this if you try it the other way round.

The panel lists the deck's earlier Moxfield decks. Versions made before the change keep
their ids. People with a share link see none of this: share links never reveal where a
deck is on Moxfield.

## Architecture

```
src/
  core/           Pure domain logic: canonical model, deterministic serialization,
                  hashing, semantic diff, card history, primer diff, Git file tree.
                  No I/O, no framework, no Moxfield.
  integrations/   DeckSource interface + Moxfield adapter (URL parsing, HTTP client,
                  lenient zod schemas, normalization, restore text, bookmarklet and
                  its capture encoding).
  server/         Config, logging, libSQL (Drizzle) schema, transactions and migrations,
                  repositories (all SQL), services (use cases), accounts, access layer,
                  history import, source registry, Git export.
  app/            Next.js App Router pages, server actions, capture route handlers.
  components/     UI kit and deck components.
  proxy.ts        Host check and session cookie refresh, in front of every page.
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
- **Access:** pages and actions reach deck data only through services bound to the
  signed-in user's workspace, or, for a share link, through a separate read-only
  interface bound to one deck (`src/server/access`, ADR 0007).
- **Storage:** SQLite through libSQL, one driver everywhere: a local file, or Turso over
  HTTP when hosted (ADR 0008). Every query is asynchronous, and transactions are short
  and never wait for Moxfield. Immutable, content-addressed snapshots and Git-like
  commits, branches (only `main` today), tags and notes. A derived `snapshot_cards`
  index powers card history and search.

Full design: [`docs/architecture.md`](docs/architecture.md). UX:
[`docs/ux.md`](docs/ux.md).

### Data model

| Table                           | Purpose                                                                            |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `workspaces`                    | One private space per user (decks belong to it); `local` from before accounts      |
| `decks`                         | Tracked decks: source + external id, cached name, HEAD branch                      |
| `deck_relinks`                  | A deck's earlier Moxfield decks ("Change Moxfield deck")                           |
| `branches`                      | `main` per deck; experiments later (`kind`, `base_commit_id`)                      |
| `commits`                       | Immutable versions: parent, snapshot, message, Moxfield version, raw payload ref   |
| `snapshots` / `snapshot_cards`  | Canonical snapshots (sha256) and a derived per-card index                          |
| `raw_blobs`                     | gzip raw Moxfield payloads (sha256)                                                |
| `observations`                  | Latest fetches or captures of the live deck (the "working tree"), pruned on ingest |
| `version_tags` / `commit_notes` | Mutable annotations on versions                                                    |
| `card_catalog`                  | Display facts (type line, mana cost) per workspace; not versioned                  |
| `app_settings`                  | Per-installation settings (e.g. the setup code of an unclaimed installation)       |
| `users` / `credentials`         | Accounts and their bookmarklet keys (hashed; ADR 0006)                             |
| `sessions`                      | Signed-in browsers and pending bookmarklet hand-offs (hashed tokens)               |
| `login_links` / `invites`       | One-time device, recovery and invite links (hashed tokens)                         |
| `share_links`                   | Read-only links to one deck's history (hashed tokens; ADR 0007)                    |

## Development

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `pnpm dev`                     | Next.js dev server on :3000 (this computer only)                     |
| `pnpm dev:lan`                 | Dev server reachable from your network (every page needs signing in) |
| `pnpm dev:mock`                | Dev server wired to the mock Moxfield (`data/mock.db`)               |
| `pnpm mock-moxfield`           | Mock Moxfield API, deck page and control API on :4010                |
| `pnpm seed:demo`               | Seed a demo deck with 8 versions and print a sign-in link            |
| `pnpm users <command>`         | `invite [--admin]`, `list`, `recover <user>`, `claim-code`           |
| `pnpm moxfield <command>`      | `status`, `resume` (server fetching after Moxfield refused)          |
| `pnpm build` / `pnpm start`    | Production build / server (this computer only)                       |
| `pnpm start:lan`               | Production server reachable from your network                        |
| `pnpm db:migrate`              | Apply migrations (automatic for a local file; required for Turso)    |
| `pnpm db:generate`             | Generate a migration after editing `src/server/db/schema.ts`         |
| `pnpm export:git <deck> [dir]` | Replay a deck's history into a new Git repository                    |
| `pnpm import:local -- …`       | Import a local installation's history (see above)                    |
| `pnpm check`                   | typecheck + lint + format check + unit/integration tests             |

Every script works on the database the app is configured with: `TURSO_DATABASE_URL`
(with `TURSO_AUTH_TOKEN`) when set, else the local file at `DATABASE_PATH`. Scripts read
`.env.local` and the other `.env*` files like the app does; variables set in the shell
win. Prefix a command with the Turso variables to run it against the hosted database;
do not put them in `.env.local`, or your local `pnpm dev` would use the hosted database
too.

Database: libSQL (ADR 0008). Locally a SQLite file at `DATABASE_PATH` (default
`data/git-moxfield.db`), WAL mode; back it up by copying the file while the app is
stopped. A local database is migrated when the app opens it. When `TURSO_DATABASE_URL`
is set (Turso, or a local libSQL server such as `turso dev`), the app uses that database
instead and never migrates it itself: run `pnpm db:migrate` against it first (the hosted
deploy does this after every build). The app refuses a database that lacks any of its
migrations, saying so; newer ones, from a later deploy, are tolerated and logged.
Migrations live in `drizzle/` and are committed; `0001_immutability_triggers.sql` is
hand-written.

Schema changes that SQLite cannot `ALTER` (a column's type, default or nullability,
foreign keys) make `pnpm db:generate` rebuild the table: copy into `__new_<table>`,
`DROP`, rename. Migrations run with foreign keys off and are checked with
`PRAGMA foreign_key_check` afterwards, so a rebuild neither fails nor cascades deletes
on existing data. But `DROP TABLE` also drops the table's triggers: a migration that
rebuilds `commits`, `snapshots`, `snapshot_cards` or `raw_blobs` must recreate their
triggers from `0001_immutability_triggers.sql`, and one that rebuilds `decks` must drop
`commits_immutable_delete` first and recreate it after the rename. See
`tests/integration/db/migrations.test.ts`, which upgrades a database holding history.
Hosted, a migration is applied while the previous deploy is still live, so it must keep
that deploy working (add first; remove in a later release).

Database code follows the rules in `src/server/db/transaction.ts`: transactions only
through `runInTransaction` (repositories: `withTransaction`), and inside one only the
transaction it hands you; no Moxfield request, or any other side effect, inside a
transaction (it may be retried); single statements and batches through `runWrite`.

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
pnpm test:e2e:install
```

```bash
pnpm test
```

Vitest unit and integration tests cover core, adapter, repositories, services, accounts,
the scripts and the route handlers, using in-memory libSQL databases and a fake
Moxfield API. They take a few seconds. A few of them run the bookmarklet's code in
Playwright's Chromium, which `pnpm test:e2e:install` installs once.

```bash
pnpm test:e2e
```

Playwright runs desktop and mobile journeys against the mock Moxfield and a separate
dev server (port 3100, `.next-e2e`, `data/e2e.db`, which it deletes first). Stop any
other `next dev` that uses `.next-e2e` first, or override the ports, database and build
directory (`tests/e2e/support/constants.ts`).

The run starts with an empty database, so a `first-run` project first claims the
installation with its setup code, as an operator would. Every other test then signs in
users of its own (`POST /api/e2e/session`), or signs in through the real flows when
that is what it tests. Every test starts with the mock back to its seeded decks and the
app's server-fetch pause cleared (`POST /api/e2e/reset`); the `/api/e2e/*` endpoints
exist only with `GIT_MOXFIELD_E2E=true`. Tests keep their browsers off the internet
and fail on browser console errors, hydration warnings and uncaught page errors, in
every browser context they open, except one known React development-build timing error
(`tests/e2e/support/fixtures.ts`).

The remote suite runs the database layer, the migrations and the import against a real
libSQL server, the way Turso behaves (no extended error codes, rejected `PRAGMA`s, the
5-second write-lock steal, stream expiry, the 5 MB value limit). Start a throwaway
server: the official `sqld` binary from the
[libSQL releases](https://github.com/tursodatabase/libsql/releases), or `turso dev`:

```bash
sqld --db-path /tmp/git-moxfield-test.sqld --http-listen-addr 127.0.0.1:8080
```

```bash
LIBSQL_TEST_URL=http://127.0.0.1:8080 pnpm test:remote
```

The suite **wipes** that database. It refuses a server that is not on this computer
unless `LIBSQL_TEST_ALLOW_WIPE=1` is set, and passes `LIBSQL_TEST_AUTH_TOKEN` to a
server that requires a token.

To check the Netlify bundle without an account, build it offline in the deploy-preview
context, which builds without migrating anything (the production context, the CLI's
default, would also run `pnpm run db:migrate` against your configured database):

```bash
pnpm --package=netlify-cli@27.12.0 dlx netlify build --offline --context deploy-preview
```

The output goes to `.netlify/` (ignored by Git, ESLint and Prettier). Do not use
`netlify serve` to judge status codes or upload limits: it differs from production there.

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
  retry, timeouts), the bookmarklet protocol, and the capture encoding (a real browser
  compresses, the server decodes; damaged payloads and decompression bombs are refused).
- **Database:** transactions, retries and the write lock, error classification, the
  size limit, every migration applied to a database that holds history, workspace
  isolation in every repository; and the remote suite against a libSQL server.
- **Services:** the complete workflow, stale and concurrent commits, blocked fetch
  with capture fallback, tags, notes, card history, restore, share links (confined to
  their deck) and changing a deck's Moxfield deck.
- **Import:** imported decks match the source in every view and in their Git export;
  re-runs, dry runs, conflicts, `--skip-existing`, damaged and foreign sources, and a
  source held open by a running app, which stays byte-identical.
- **End-to-end journeys (desktop and phone):** the core loop with server fetching
  (track, commit, refresh, a move shown as one move, tags, history, version tabs,
  compare, card history, restore and copy to the clipboard); a blocked server with the
  same-tab bookmarklet; the popup bookmarklet for an untracked deck (desktop); pasting
  the deck JSON; a stale commit; a deck deleted and made again on Moxfield, continued
  from the capture page and changed from the deck page; and the phone layout (bottom
  navigation, touch commit form, no sideways scrolling on any page).
- **Accounts end to end:** claiming a fresh installation; an invite accepted in a
  second browser, followed by a new bookmarklet; both bookmarklets signing a fresh
  browser in while capturing into their owner's workspace (same-tab with
  `Origin: null`); device and recovery links (once only, never used up by opening
  them); revoked bookmarklets and disabled accounts; signing out one browser, another
  or every one; and private decks (another user's deck is a 404 on every page).
- **Share links end to end:** a friend without an account follows a deck's history
  read-only; notes only through a link that includes them; revoking a link, untracking
  the deck or revoking the bookmarklet it was made through ends access at once; an
  edited share URL reaches nothing else.

## Configuration

All optional when running on your computer. See [`.env.example`](.env.example). On
Netlify, set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `PUBLIC_APP_URL` (see
[Deploy](#deploy-for-free-netlify--turso)).

| Variable                           | Default                     | Purpose                                                                    |
| ---------------------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `DATABASE_PATH`                    | `data/git-moxfield.db`      | Local SQLite file, used unless `TURSO_DATABASE_URL` is set                 |
| `TURSO_DATABASE_URL`               | —                           | libSQL database: `libsql://…turso.io`, or `http://127.0.0.1:8080` (sqld)   |
| `TURSO_AUTH_TOKEN`                 | —                           | Its auth token (secret); only with `TURSO_DATABASE_URL`                    |
| `PUBLIC_APP_URL`                   | request origin              | The app's public URL: baked into bookmarklets and links, allowed as a host |
| `ALLOWED_HOSTS`                    | —                           | Other host names to answer to, e.g. `mybox.local` (see security notes)     |
| `CAPTURE_ALLOWED_ORIGINS`          | `https://moxfield.com`      | Origins allowed to hand decks to `/capture`                                |
| `MOXFIELD_USER_AGENT`              | —                           | Moxfield-issued User-Agent (secret; Netlify production only)               |
| `MOXFIELD_SERVER_FETCH`            | `auto` (`off` on Netlify)   | `off` = bookmarklet/paste only                                             |
| `MOXFIELD_MIN_REQUEST_INTERVAL_MS` | `2000`                      | Spacing of Moxfield requests, all instances together (at least `1500`)     |
| `MOXFIELD_TIMEOUT_MS`              | `15000`                     | Timeout of one Moxfield request                                            |
| `REFRESH_COOLDOWN_SECONDS`         | `10`                        | Minimum time between refreshes of one deck                                 |
| `LOG_LEVEL`                        | `info`                      | `debug`, `info`, `warn` or `error`                                         |
| `MOXFIELD_API_BASE_URL`            | `https://api2.moxfield.com` | Moxfield API (tests point it at the mock)                                  |
| `MOXFIELD_SITE_ORIGIN`             | `https://moxfield.com`      | Moxfield website (deck URLs, capture origin)                               |

HTTP Basic auth (`BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD`) no longer exists: accounts
replace it, and the variables are ignored. `GIT_MOXFIELD_E2E` is for the end-to-end
tests only; the app refuses to start with it in production.

## Security notes

- **Bookmarklet keys** (`gmk_…`) are personal secrets kept in your bookmarks (and in
  your browser's bookmark sync). Whoever holds one can send decks to your account and
  sign a browser in as you, never touch your Moxfield account. Revoke a lost one in
  Account; that also signs out the browsers it signed in, and can revoke the share links
  made in them.
- **Sessions** live in an `HttpOnly`, `SameSite=Lax` cookie, named `__Host-gm_session`
  and `Secure` on HTTPS. A session ends after 400 days without use, or when you sign it
  out. Keys, sessions and every link token are stored only as SHA-256 hashes.
- **One-time links** (device 15 minutes, recovery 24 hours, invite 7 days) are used up by
  a button press, never by opening them, so chat-app previews cannot spend them.
- **Share links** (`gmv_…`) are bearer secrets: anyone with the link can view the deck's
  committed history until you revoke it. They never show uncommitted changes or where
  the deck is on Moxfield, and notes only if you chose so. `Referrer-Policy: no-referrer`
  keeps link tokens out of other sites' logs.
- **Admins** manage accounts, not decks. Their one way into someone's account, a
  recovery link, signs that person's other devices out and is listed on their Account
  page.
- **No passwords and no Basic auth.** Every page and endpoint needs a signed-in user,
  except the ways in (sign-in, claim, invite and one-time link pages), the bookmarklet's
  capture page and endpoints (which take its key) and share link pages (the link is the
  authorization).
- **The Turso token** gives full access to the database, and with it the command line
  acts as an admin (`pnpm users`): it is the operator's master key. Keep it in
  Netlify's settings and your shell only. To replace it, run
  `turso db tokens invalidate git-moxfield` (this invalidates every token of the
  database's group), create a new one, update `TURSO_AUTH_TOKEN` in Netlify and
  redeploy.
- **Logs** never contain keys, tokens, cookies, database URLs or query parameters. The
  one secret logged on purpose is the setup code, until the installation is claimed.
  The dev server logs every request URL except those carrying a token
  (`src/server/request-log-filter.ts`); production servers log no requests.
- Moxfield content is untrusted. It is validated with zod and rendered only as React
  text or as markdown without raw HTML (links limited to http, https and mailto; images
  not loaded). Compressed captures are decoded with hard size limits. A strict CSP and
  security headers are set.
- **Host check.** Requests are only answered when addressed to an IP address,
  `localhost`, the host of `PUBLIC_APP_URL` or a name in `ALLOWED_HOSTS` (others get
  `421 Unknown host`). This stops DNS-rebinding attacks, in which a web page re-points
  its own domain name to your machine to read or change your decks. If you reach the
  app under another name (an mDNS name such as `mybox.local`, a reverse proxy's domain,
  a custom domain next to `<name>.netlify.app`), list it in `ALLOWED_HOSTS`.
- On your computer the app listens on `127.0.0.1` by default, so other machines cannot
  reach it. `pnpm dev:lan` / `pnpm start:lan` expose it to your network; every page
  still requires signing in.

### Using it from another device

To use a local git-moxfield (and its bookmarklets) from your phone, start it so that it
listens on your network, and bake its LAN address into the bookmarklets:

```bash
pnpm build
```

```bash
PUBLIC_APP_URL=http://192.168.1.20:3000 pnpm start:lan
```

Put the variables in `.env.local` to keep them. Then open the LAN address on the phone,
sign in with a device link (Account › Sign in on another device, on your computer), and
create the phone's bookmarklet on its setup page.

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
  so the bookmarklet is the practical path today (and the only one when hosted). If
  Moxfield adds a COOP header or a stricter CSP, the popup bookmarklet may stop working.
  The same-tab variant and paste remain.
- Restore cannot set commanders or the companion through Bulk Edit; these are manual
  steps. The primer is a separate paste into Moxfield's primer editor. Card tags
  (`#tag` / `#!tag`) are not restored, because Moxfield's JSON does not say whether a
  tag is deck-specific or global.
- Restore text uses `Front // Back` names for double-faced cards. Moxfield's own
  export currently writes `Front / Back`, and both are expected to resolve.
- Verified against the official libSQL server and Netlify's build tooling run offline,
  not yet on Turso Cloud and Netlify themselves: real latency between the two (each
  query is one HTTPS round trip; a version page makes 37), and the exact shape of
  Turso's quota error.
- `pnpm test` needs Playwright's Chromium (`pnpm test:e2e:install`) for its browser
  tests.
- The demo seed uses synthetic printings (`TST` set codes). Its restore text is not
  meant for real Moxfield decks.
- Only one `next dev` may run per build directory. e2e uses `NEXT_DIST_DIR=.next-e2e`
  for that reason. Never set `NEXT_DIST_DIR` on Netlify.

## Roadmap

1. **Cheaper captures.** Index a state's cards (`snapshot_cards`) only once it is
   committed: a capture that changes the deck would write about 15 rows instead of 430.
2. **Experiments (branches).** "Start experiment from v36: Broodlord package". The
   `branches` table already exists, with `kind = 'experiment'` and `base_commit_id`.
   Commits get associated with the active experiment, and experiment tips can be
   compared.
3. **Outcomes.** Structured `commit_notes` kinds for tournament records (games, W/L,
   pod notes), with history views annotated by results.
4. **Search across history.** "Have I tried card X?" across every deck, "when did I cut
   it and what replaced it?", "versions containing A and B". `snapshot_cards` already
   indexes this; card search within one deck exists.
5. **Packages.** User-defined card groups (seeded from Moxfield author tags), then
   package-level diffs ("Broodlord package: added").
6. **More ways in and out.** "Continue with Discord/Google" as another credential of the
   same account (ADR 0006), and sharing a deck with a specific user (the viewer scope of
   ADR 0007).
7. **GitHub sync.** Push `export:git` output to a repository automatically.
8. **Official Moxfield access.** With an official write API, add opt-in restore
   write-back.
9. **Browser extension.** Replaces the bookmarklet where installation friction is
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
- [ADR 0006: Accounts without passwords](docs/adr/0006-accounts-with-bookmarklet-keys.md).
  The bookmarklet is the key; invites, device and recovery links, a setup code for the
  first admin.
- [ADR 0007: Access control and share links](docs/adr/0007-access-control-and-share-links.md).
  One access layer; owner scope per workspace, a read-only viewer scope per share link.
- [ADR 0008: Hosting on Netlify with Turso](docs/adr/0008-hosting-netlify-and-turso.md).
  Free hosting, libSQL everywhere, compressed captures, migrations in the deploy.
- [ADR 0009: One request limit for every instance](docs/adr/0009-global-moxfield-rate-limit.md).
  Moxfield's one call per second, kept in one database row by every function instance;
  429s slow everyone down, refusals pause until an admin resumes; no background fetching.

---

Not affiliated with Moxfield. Magic: The Gathering is a trademark of Wizards of the Coast.
