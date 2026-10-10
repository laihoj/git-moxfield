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
  the link was created with "include notes".
- No other route to the database: pages, server actions and route handlers obtain
  services exclusively through these two functions. Server actions re-resolve the
  session on every call; nothing trusts ids from the client without the scope check.

**Share links** (`gmv_` + 32 random bytes, stored hashed):

- Created by the deck owner per deck, labelled, revocable, several per deck.
- URL: `/s/<token>` with the same views as the owner (history, versions, compare, card
  history, restore text) under that prefix.
- Revoking a link, or untracking the deck, ends access immediately.
- Links are bearer secrets: anyone with the link can view. `Referrer-Policy:
no-referrer` keeps them out of Referer headers; tokens are never logged.

**Admins** manage users and invites but have no implicit access to anyone's decks.
Their only path to a user's data is a recovery link (ADR 0006), which signs in as the
user, signs out their other devices, revokes their bookmarklets and is listed on the
user's Account page, so it cannot be used without the user seeing it.

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
