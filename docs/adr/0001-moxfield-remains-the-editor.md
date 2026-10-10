# ADR 0001: Moxfield remains the deck editor and source of truth

- Status: accepted
- Date: 2026-10-09

## Context

Deck building happens in Moxfield: card search, zones (mainboard, sideboard,
considering), playtesting, sharing and primer editing. Moxfield keeps only the current
deck, plus a coarse change log. Iterating on cEDH lists means repeatedly abandoning and
returning to strategic configurations, so the lack of real history hurts.

## Decision

git-moxfield is a companion, not an editor. Moxfield is the working tree.
git-moxfield:

- observes the current Moxfield state (fetch or browser capture);
- records immutable snapshots ("versions") on explicit commit;
- computes semantic diffs, card history and comparisons;
- exports any version as Moxfield-compatible text for restoring.

git-moxfield has no card search, no deck editing UI, no playtesting and no primer
editor.

## Consequences

- Users keep their existing Moxfield workflow and muscle memory. git-moxfield adds a
  review and commit step around it.
- There is no feature race with Moxfield. Moxfield improvements benefit users
  immediately.
- git-moxfield depends on reading Moxfield data (see ADR 0002 and
  `docs/moxfield-integration.md`), so that integration is isolated behind the
  `DeckSource` interface.
- Concepts map onto Git (working tree, HEAD, commit, tag, diff). The UI uses
  deckbuilding vocabulary instead: version, commit, compare, restore, tag.
