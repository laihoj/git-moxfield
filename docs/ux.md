# UX design

git-moxfield uses Git concepts internally but speaks deckbuilding. Users see
**Versions** (`v12`), **Commit**, **Compare**, **Restore to Moxfield**, **Tags**,
**Card history** and **Notes**. They never see refs, trees, detached HEAD or staging.

## Principles

1. **The deck page answers four questions at a glance.** What is the Moxfield
   status? Are there uncommitted changes? What is the last committed version? What
   changed? The commit action is always one tap away.
2. **Moves are first-class.** A card moving between zones is shown as `Mainboard →
Considering`, never as an unrelated removal plus addition.
3. **Strategic before cosmetic.** Printing changes, card tags and renames are shown,
   but collapsed and visually quiet.
4. **Mobile does the core loop.** Inspect status, review diff, commit, browse
   history, copy a restore. Desktop adds side-by-side comparison, primer diffs and
   card previews.
5. **No surprises.** Nothing is ever written to Moxfield. Restore is a copy action.
   Untrusted Moxfield content is rendered as text.

## Information architecture

```
/                                   Decks: tracked decks with status, "Track a deck"
/setup                              Connect Moxfield: fetch status, bookmarklet, paste
/capture                            Bookmarklet landing (and ?mode=paste fallback)
/decks/[deckId]                     Deck: status, changes since last version, commit, recent versions
/decks/[deckId]/history             Version timeline, tag filter
/decks/[deckId]/versions/[n]        Version: changes, full deck, primer, notes, tags
/decks/[deckId]/versions/[n]/restore  Restore to Moxfield: per-board copy blocks
/decks/[deckId]/compare?from&to     Compare any two versions (or the current Moxfield deck)
/decks/[deckId]/cards               Search cards across the deck's history
/decks/[deckId]/cards/[cardKey]     Card history timeline
```

Inside a deck, navigation tabs are **Status · History · Compare · Cards**. They sit
at the top on desktop and in a fixed bottom bar on mobile.

## Deck page (mobile sketch)

```
Blue Farm                          ↗ Moxfield
Tymna the Weaver · Kraum, Ludevic's Opus

● Uncommitted changes
Moxfield edited 23 min ago · checked 1 min ago   [↻]
Moxfield version 143 · v47 committed at 137

[+2 Mainboard] [−2 Mainboard] [2 moved to Considering] [Primer +14 / −6]

Commit message
[ Testing Broodlord package          ]
Tags  (tournament) (stable) (+)
[        Commit v48        ]

Changes since v47
MAINBOARD
 + Beseech the Mirror          {1}{B}{B}{B}
 + Final Fortune               {R}{R}
MOVED
 ⇄ Dress Down          Mainboard → Considering
 ⇄ Mnemonic Betrayal   Considering → Mainboard
PRIMER   +14 / −6 lines    View diff

Recent versions
 v47  Testing Broodlord package     2 d   tournament
 v46  Back to lower creature count  5 d
```

States of the status panel:

| State           | Shown as                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `never-fetched` | "Waiting for the first snapshot from Moxfield", with refresh or bookmarklet instructions                                  |
| `no-versions`   | "Not committed yet". The diff is the initial deck ("Initial version · 100 cards"), and the commit button says "Commit v1" |
| `uncommitted`   | Accent dot, "Uncommitted changes", summary chips                                                                          |
| `cosmetic-only` | Neutral dot, "Only printing changes"                                                                                      |
| `clean`         | Green check, "Up to date with v47"                                                                                        |
| fetch error     | Inline banner with the error and the next step (bookmarklet when blocked, retry time when rate-limited)                   |

When server fetch is unavailable (blocked or disabled), the refresh button becomes
**Update from Moxfield**. It opens the deck on Moxfield and links to /setup, so the
user can click the bookmarklet there.

## Diff presentation

Sections, in this order: Commanders (only when changed), each zone (added, removed
and quantity rows), Moved, Deck info, Primer, then collapsed cosmetic sections
(Printings, Card tags, Renamed).

Row anatomy: change glyph (`+` `−` `⇄` `±`), quantity when it is not 1, card name,
then on the right the mana cost and the from → to zone badges. Zone badges use stable
zone colors (commanders amber, mainboard violet, sideboard slate, considering teal).

## Restore

Numbered steps that mirror Moxfield's UI. Each Bulk Edit board gets a block with its
label, its Moxfield target (`Bulk Edit › Considering`), a copy count and a large
**Copy** button. Empty boards say "Clear this tab". Commanders and companion are
shown as manual steps. Limitations are listed below the steps, not hidden.

## Card history

The header shows the card name, type line, mana cost and current zones. The summary
reads "In 31 of 47 versions · cut 3 times · restored twice". The timeline is
compressed into runs ("v19–v20 Mainboard"). Transitions are labeled: _moved from
Mainboard_, _restored_, _added_, _removed_, and _renamed from Æther Vial_ when an
oracle rename changed the card's name. A toggle shows every version.

## Visual language

- Neutral surfaces, one violet accent, semantic diff colors (add green, remove red,
  move blue, cosmetic gray), zone colors. Light and dark follow the OS.
- System font stack; tabular numbers for quantities; mono only for restore text.
- 4px spacing grid, 12px radii on cards, 8px on controls. Touch targets ≥ 44px on
  mobile. Content max width 1080px.
- Accessible: semantic headings and landmarks, visible focus, labelled controls,
  diff meaning never conveyed by color alone (glyphs and words too).
