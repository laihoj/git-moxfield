# UX design

git-moxfield uses Git concepts internally but speaks deckbuilding. Users see
**Versions** (`v12`), **Commit**, **Compare**, **Restore to Moxfield**, **Tags**,
**Card history** and **Notes**. They never see refs, trees, detached HEAD or staging.

## Principles

1. **The deck page answers four questions at a glance.** What is the Moxfield
   status? Are there uncommitted changes? What is the last committed version? What
   changed? The commit action is always one tap away.
2. **Moves are first-class.** A card moving between zones is shown as
   `Mainboard → Considering`, never as an unrelated removal plus addition.
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
/setup                              Connect Moxfield: fetch status, your bookmarklets, paste
/capture                            Bookmarklet landing (and ?mode=paste fallback)
/decks/[deckId]                     Deck: status, changes since last version, commit, recent
                                    versions, Moxfield deck panel (change Moxfield deck)
/decks/[deckId]/history             Version timeline, tag filter
/decks/[deckId]/versions/[n]        Version: changes, full deck, primer, notes, tags
/decks/[deckId]/versions/[n]/restore  Restore to Moxfield: per-board copy blocks
/decks/[deckId]/versions/[n]/restore.txt  The same restore export as a text download
/decks/[deckId]/compare?from&to     Compare any two versions (or the current Moxfield deck)
/decks/[deckId]/cards               Search cards across the deck's history
/decks/[deckId]/cards/[cardKey]     Card history timeline
/decks/[deckId]/share               Share links of the deck: create, last viewed, revoke

/signin                             Sign in: the ways in (no password form); claim card
                                    while the installation has no admin
/signin/[token]                     A device or recovery link: who it signs in, one button
/signin/bookmarklet                 Confirm before a same-tab bookmarklet signs this browser in
/claim                              First run: setup code + display name → first admin
/invite/[token]                     An invite: pick a display name → account
/account                            Your name, sign in on another device (link + QR code),
                                    bookmarklets, signed-in devices, recoveries, sign out
/admin                              Admins only (404 for members): invite, people, recovery
                                    links, invites

/s/[token]                          Shared deck (read-only, no account needed): overview
/s/[token]/history, /versions/[n], /versions/[n]/restore, /compare, /cards, /cards/[cardKey]
                                    The owner's views, committed history only
```

Inside a deck, navigation tabs are **Status · History · Compare · Cards**. They sit
at the top on desktop and in a fixed bottom bar on mobile. The owner's deck header also
has **Share**. A shared deck has the same tabs with **Overview** (its latest version and
what changed, beside the recent versions) in place of Status, and a read-only banner
instead of the account menu.

At the right end of the tab row (alone, right-aligned, on a phone) sits the **deck view**
toggle, **MTG · cEDH**, for owners and viewers alike:

- **MTG** (the default) is every board as Moxfield has it: the sideboard and Considering
  are part of the picture, and a card moving between the mainboard and Considering is a
  move.
- **cEDH** is the sleeved deck only. Commander decks have no sideboard, and the sideboard
  and Considering are a scratchpad, so the view leaves every zone but the played ones out
  of sight. A card moved from the mainboard to Considering is a **cut**, one moved back is
  an **add**: exactly what to pull from and put into the sleeves. The Changes card lists
  the mainboard as **Add** and **Cut**, the chips read `2 to add` · `1 to cut`, the
  suggested message says `Add Beseech the Mirror; cut Dress Down`, version stats and card
  histories count the sleeved deck, and the Deck tab shows its zones only. Changes the view
  leaves out are counted, never hidden silently ("Left out by the cEDH view: 1 change
  outside the sleeved deck"), the status stays that of the whole deck, and such changes can
  still be committed. Commits and Restore always use the whole deck.

The choice is remembered per browser (a cookie), so it holds across every deck's pages,
needs no account, and works for share link viewers.

## Accounts

There is no password form anywhere. The sign-in page lists the ways in: run your
bookmarklet on a Moxfield deck, open a device link made on a signed-in device
(Account › Sign in on another device), or ask the admin. Pages that a link opens
(invite, device or recovery link, the same-tab confirmation) explain what will happen
and do nothing until their button is pressed, so link previews in chat apps cannot use
them up.

- **First run.** While no user exists, the sign-in page shows "This git-moxfield has no
  admin yet" with **Set up git-moxfield**; `/claim` asks for the setup code from the
  server log and a display name.
- **After joining** (invite, claim, recovery), Connect Moxfield opens with a greeting and
  leads with creating a bookmarklet: name it (prefilled from the browser, e.g. "Chrome
  on Mac"), then drag the popup variant to the bookmarks bar, or the same-tab variant on
  a phone. The bookmarklets are shown once, until "I've installed it" or leaving the
  page.
- **Same-tab confirmation** names the account and the bookmarklet (label and creation
  date, since display names are not unique) and says whom it signs out.
- **Account** lists bookmarklets with their last use (revoke each; revoking offers to
  revoke the bookmarklets and share links made through it too), signed-in devices (sign
  out one, the others, or everywhere), and every recovery link that signed in as you,
  with the admin who made it.
- **Admin** creates invite links (member or admin, optional note), lists people with
  their deck and key counts (disable, enable, make a recovery link) and the recovery
  links and invites that can still be used (withdraw them).

## Sharing

The owner's **Share** page creates read-only links: a label for whom it is for, and an
"Include my version notes" choice. A new link's URL is shown once, with a copy button.
Each link shows when it was last viewed and can be revoked.

A shared deck looks like the owner's, read-only: a banner names who shared it, and there
is no commit form, refresh, tag editing or uncommitted state. Nothing names the deck's
place on Moxfield. Restore works the same way, so a viewer can paste any version into a
Moxfield deck of their own. A revoked link, an untracked deck or a disabled owner looks
exactly like a link that never worked ("This link doesn't work anymore"), also when a
page that was open navigates; the deck's frame is never shown again.

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
Description (optional)
[ Why: Broodlord lines close faster  ]
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
| `cosmetic-only` | Neutral dot, "Only printing changes", "Only renamed cards" or "Only printing changes and renames"                         |
| `clean`         | Green check, "Up to date with v47"                                                                                        |
| fetch error     | Inline banner with the error and the next step (bookmarklet when blocked, retry time when rate-limited)                   |

When server fetch is unavailable (blocked or disabled), the refresh button becomes
**Update from Moxfield**. It opens the deck on Moxfield and links to /setup, so the
user can click the bookmarklet there.

## Changing a deck's Moxfield deck

A deck deleted on Moxfield and made again gets a new link. Two ways to follow it, both
keeping every version:

- **Moxfield deck panel** (Status page, side column; below the main column on phones):
  the deck's Moxfield link, its earlier Moxfield decks with dates, and **Change Moxfield
  deck**, a form that opens in place (URL or id of the new deck). Afterwards the Status
  page greets the change. The "Deck not found on Moxfield" banner links to the form.
- **Capture page:** when the bookmarklet sends a deck nobody tracks, the page offers
  "Track this deck" and, below it, **Or continue an existing deck's history**: a deck
  picker (preselected when exactly one deck has the same name) and a
  **Continue "&lt;deck&gt;"** button. The deck page then shows the new copy as changes
  since the latest version.

Refusals explain the way forward: the deck's own Moxfield deck ("already follows it"),
or a Moxfield deck another of your decks tracks ("stop tracking that deck first", and
whether that loses versions).

## Commit message and description

A commit message has Git's shape. The **message** is a brief subject line, as a Git
subject is: it is what the toast, the recent versions, History, the compare pickers and
card histories show. The **description** (optional, under the message in the commit form)
holds the elaboration, kept after a blank line in the same immutable, hashed message, so a
Git export carries it as the commit body. The version page shows the description under
its heading; rows that have one carry a small mark. Notes remain the mutable annotation of
a version (results, matchups), added at any time.

## Diff presentation

Sections, in this order: Commanders (only when changed), each zone (added, removed
and quantity rows), Moved, Deck info, Primer, then collapsed cosmetic sections
(Printings, Card tags, Renamed). In the cEDH view the mainboard section is **Add** and
**Cut** instead (quantity increases under Add, decreases under Cut), with rows spoken as
"Add: …" and "Cut: …".

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
