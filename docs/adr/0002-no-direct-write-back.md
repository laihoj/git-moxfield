# ADR 0002: No direct write-back to Moxfield in the MVP

- Status: accepted
- Date: 2026-10-09

## Context

Restoring a historical version could, in principle, update the Moxfield deck
directly. Moxfield's Bulk Edit saves through `PUT /v3/decks/{publicId}/bulk-edit`. But:

- Moxfield has no public API. Its FAQ says the API is private and that access for
  third-party tools is granted case by case. Write endpoints need the user's Moxfield
  session token.
- Asking for Moxfield credentials, or scraping session tokens, would be a security
  and trust problem, and against the spirit of Moxfield's policy.
- Writing is destructive. A bug or an API change could silently corrupt the user's
  live deck, which is the source of truth.
- Even read access from a server is blocked by bot protection unless Moxfield issues
  a User-Agent (see `docs/moxfield-integration.md`).

## Decision

Restore is an export. git-moxfield generates Moxfield-compatible Bulk Edit text per
board (Main Deck, Sideboard, Considering, ...), plus explicit manual steps for things
Bulk Edit cannot express: commanders, companion, signature spells. The user pastes and
saves in Moxfield. git-moxfield never asks for Moxfield credentials and never writes to
Moxfield.

## Consequences

- Restoring takes a few manual steps. The restore page makes them explicit and
  copyable, one board at a time, and lists known limitations: alter/proxy flags, tags,
  non-English printings, multiple printings.
- The user stays in control. Nothing changes on Moxfield without a human pressing
  Save.
- The current Moxfield state is never overwritten implicitly. The next refresh simply
  shows the restored state as uncommitted changes relative to HEAD.
- If Moxfield ever offers an official write API with OAuth, a `DeckSource.applySnapshot`
  capability can be added without touching history or diff code.
