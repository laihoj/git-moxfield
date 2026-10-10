# ADR 0007: Access control and read-only share links

- Status: accepted
- Date: 2026-10-10

## Context

With several users on one instance, every request must be attributed to someone and
checked. Users also want to show their deck's edit history to friends without letting
them change anything.

## Decision

**One place resolves access.** `src/server/access` turns a request into an access
scope, and the UI can only reach data through services bound to that scope:

- **Owner scope** (`servicesFor(user)`): the full `DeckServices`, bound to the user's
  workspace. Repositories filter every deck query by workspace, so another
  workspace's deck is indistinguishable from a missing one (`not-found`, never
  `forbidden`, so ids do not leak existence). Writes require owner scope.
- **Viewer scope** (`sharedDeckServices(token)`): a separate, read-only
  `SharedDeckServices` interface bound to exactly one deck. It has no write methods at
  all, so read-only is enforced by types as well as at runtime. It shows committed
  history only (no uncommitted Moxfield state, no refresh), and private notes only if
  the link was created with "include notes". It never says where the deck lives on
  Moxfield (no link to it, no Moxfield id, no source metadata): that URL opens the live
  deck, uncommitted changes included, is the only key to an unlisted deck, and would
  outlive a revoked link. Viewers restore a version into a deck of their own. The
  banner names the owner ("Shared by …", their display name), which the Share page
  tells the owner.
- No other route to the database: pages, server actions and route handlers obtain
  services exclusively through these two functions. Server actions re-resolve the
  session on every call; nothing trusts ids from the client without the scope check.

**Share links** (`gmv_` + 32 random bytes, stored hashed):

- Created by the deck owner per deck, labelled, revocable, several per deck.
- URL: `/s/<token>` with the same views as the owner (history, versions, compare, card
  history, restore text) under that prefix.
- Revoking a link, untracking the deck, or recovering the owner's account (ADR 0006)
  ends access immediately; disabling the owner suspends it. A page that was open at the
  time shows the dead-link page on its next navigation, never the deck's frame.
- A link records the bookmarklet key its creating session descends from, so revoking a
  stolen key can revoke the links made through it: when the key is revoked, or later
  (the Account page lists revoked bookmarklets whose links still work).
- Links are bearer secrets: anyone with the link can view. `Referrer-Policy:
no-referrer` keeps them out of Referer headers; tokens are never logged, not even in
  the dev server's request log (`src/server/request-log-filter.ts`).

**Admins** manage users and invites but have no implicit access to anyone's decks.
Their only path to a user's data is a recovery link (ADR 0006), which signs in as the
user, signs out their other devices, revokes their bookmarklets and share links and is
listed on the user's Account page, so it cannot be used without the user seeing it. A
share link made in a recovery session dies at the user's next recovery, which is how
they get back in.

**Card facts** (type line, mana cost, image id) come from untrusted captures, so the
card catalog is scoped to the workspace like deck data: one workspace's capture never
changes what another shows. Only content-addressed data (snapshots, raw payloads,
keyed by the hash of their content) is shared between workspaces.

## Consequences

- One small module to audit for authorization, plus a type-level read-only API for
  viewers.
- UI components take a route builder (owner `/decks/<id>/…` or viewer `/s/<token>/…`)
  instead of building deck URLs themselves.
- Sharing with a specific user (instead of a link) can later reuse the viewer scope.

## Implementation notes (2026-10-10)

Built as decided (`src/server/access`, `src/server/services/shared-deck-services.ts`,
`confined-history.ts`, the `/s/<token>` pages). Additions since:

- The access functions are asynchronous (`await servicesFor(user)`), because the database
  is opened on first use (ADR 0008); a database that cannot be opened, or is not migrated,
  fails the request with a clear error.
- The viewer interface also has `isAvailable()`, so a page can tell a link that stopped
  working from a version or card the deck does not have. A revoked link, an untracked
  deck and a disabled owner all answer 404 exactly like an unknown token, also for a page
  that was already open (the next navigation re-checks the link and shows the dead-link
  page, never the deck's frame). Views are recorded at most hourly; the Share page shows
  when each link was last viewed.
- Changing a deck's Moxfield deck (after it was deleted and made again on Moxfield) is an
  owner-scope operation (`DeckServices.relinkDeck`, or a capture with `relinkDeckId`). The
  record of earlier Moxfield decks (`deck_relinks`) is owner-only: viewer DTOs are
  unchanged, in line with "never says where the deck lives on Moxfield".
- Operator scripts are not requests and do not use this layer: `pnpm export:git` finds
  decks in every workspace, `pnpm import:local` writes into the workspace of the user it
  is told (`--to-user`), and `pnpm users` acts on accounts only.
