# ADR 0006: Accounts without passwords — the bookmarklet is the key

- Status: accepted
- Date: 2026-10-10

## Context

git-moxfield is moving from a single-user local app to a small hosted instance shared
with friends. Everyone needs their own private decks and history, but nobody wants
another username and password. Moxfield and TopDeck.gg offer no "sign in with …"
for third parties, and reusing a Moxfield password or session would hand the app
full control of people's Moxfield accounts (see the discussion in ADR 0004).

Every user already has to install a personal bookmarklet to send decks from
Moxfield. That bookmarklet can carry a secret.

## Decision

**Identity and credentials are separate.**

- A **user** owns exactly one **workspace**. Decks, versions, tags, notes and share
  links belong to the workspace, never to a credential.
- A **credential** is a way to prove you are a user. Today there is one kind:
  `bookmarklet-key`. Later, `oauth` credentials (Discord, Google) attach to the same
  user, so adding "Continue with Discord" needs no data migration.

**Bookmarklet keys** (`gmk_` + 32 random bytes, base64url):

- Generated per bookmarklet installation, labelled ("Laptop Chrome"), shown in
  plaintext only once (inside the bookmarklet), stored as SHA-256 hashes. High-entropy
  secrets do not need a slow hash.
- Running the bookmarklet both captures the deck _and signs that browser in_: the
  capture endpoints authenticate the key and set a session cookie. The key decides
  which workspace receives the capture; it does not prove that the browser's user ran
  it, because any member can post their own key from any web page (the same-tab
  bookmarklet's form post arrives with `Origin: null`, which any page can produce). So
  the same-tab bookmarklet signs a browser in without asking only when it is already
  signed in as the key's owner; a first sign-in, or a switch from another account
  (which signs that account out of the browser), asks for one confirmation on
  git-moxfield's own page, which names the account and the bookmarklet (label and
  date, since display names are not unique) and accepts only a same-origin POST.
- Several keys per user are allowed; each can be revoked on its own. Revoking a key
  ends every session that descends from it: the browsers it signed in, and those signed
  in with a device link made on one of them (the session a device link starts
  descends from the key of the session that made the link). Keys made in such a
  browser are listed as made through it, and the owner can revoke them together with
  it (a stolen key's offspring) or keep them (their own replacement).

**Sessions:** `gms_` + 32 random bytes in an `HttpOnly`, `SameSite=Lax` cookie
(`Secure` on HTTPS and on the loopback host, then named with the `__Host-` prefix so
no sibling subdomain can plant or overwrite it), stored hashed, sliding expiry up to
400 days (the browser cap): the database expiry slides with use, and page views
refresh the cookie's `Max-Age` at most daily. Sign out ends one session; "sign out
other devices" and "sign out everywhere" end the others or all, and withdraw unused
device links.

**Other ways in**, all one-time, expiring and stored hashed:

- **Invite links** (`gmi_`, created by an admin, 7 days): the friend picks a display
  name, gets a user, a workspace and a session, then creates their bookmarklet.
- **Device links** (`gml_`, created by a signed-in user, 15 minutes, also shown as a
  QR code): sign in on a phone without bookmark sync.
- **Recovery links** (`gml_`, created by an admin for another user, 24 hours; only the
  newest per user works): for a user who lost every key and every signed-in device.
  History is untouched; the user creates new keys. Whoever opens a recovery link is
  signed in as that user, so consuming one ends every other session of the user,
  revokes all their keys, withdraws their unused links and revokes every share link to
  their decks (ADR 0007; a lost or stolen device is cut off along with the read access
  handed out from it, and misuse cannot go unnoticed), and the user's Account page
  permanently lists which admin's link was used and when. Admins see the recovery links that can
  still be used and can withdraw them; an admin cannot make one for themselves.
- **Claim** (first run): while the instance has no users, a setup code is generated
  once, stored, and printed to the server log on every start. Entering it at `/claim`
  creates the first admin. On an existing local installation the admin adopts the
  `local` workspace, so existing history is kept. `pnpm users:invite --admin` is the
  CLI alternative.

**Roles:** `admin` manages users and invites; it grants no access to other users'
decks. The one way an admin can act as someone else is a recovery link, which is
visible to that person as described above. Disabling a user ends their sessions and
withdraws for good the unused links that sign them in and the invites and links they
made, so re-enabling them revives none of it; an invite or recovery link also works
only while the admin who made it is an active admin. `member` is everyone else.

## Consequences

- No passwords, no email, no third-party identity provider, no cost.
- Whoever holds a key is that user, like a house key. Scripts on moxfield.com could in
  theory read a bookmarklet's key while it runs (it is posted from that page). The
  blast radius is the user's git-moxfield data, never their Moxfield account; keys are
  revocable and labelled with last use, and revoking one reaches the sessions derived
  from it.
- The first same-tab capture in a browser takes one confirmation click; later ones in
  the same signed-in browser do not.
- Admins are trusted with accounts, not decks: a recovery link lets an admin sign in as
  someone, but only loudly (their other devices, bookmarklets and share links stop
  working, and their Account page names the admin).
- After a recovery, the user shares their decks again with new links.
- Losing every key and device does not lose data: an admin issues a recovery link.
- The installation-wide capture token is replaced by per-user keys; bookmarklets
  created before this change stop working and must be recreated.
- HTTP Basic auth (an installation-wide password) is removed: real accounts replace it.

## Implementation notes (2026-10-10)

Built as decided, in `src/server/auth` and the account pages. Where the details differ
from, or add to, the text above:

- **The command line** is `pnpm users invite [--admin]`, not `pnpm users:invite`, next to
  `pnpm users list`, `pnpm users recover <user>` and `pnpm users claim-code`. It acts as
  the "system actor": an admin without an account. Its recovery links show on the user's
  Account page as coming from the server's command line. Hosted, whoever holds the Turso
  token can run these commands against the production database, so that token is the
  operator's master key.
- **The setup code** (`XXXX-XXXX-XXXX` from a 29-letter alphabet without look-alikes,
  about 58 bits, compared in constant time) is printed when a process first uses the auth
  service, that is on its first request rather than at start, and whenever `/claim` is
  opened (after the response is sent, so the development server's console replay never
  shows it in the visitor's browser). On Netlify every new function instance prints it
  once, in the function log. `pnpm users claim-code` prints it from the command line,
  also for the hosted database.
- **The same-tab hand-off** is a five-minute hand-off cookie set on the 303 from
  `/api/capture/form`, finished by `GET /api/auth/handoff`, which sees the browser's own
  session again; the confirmation page is `/signin/bookmarklet`.
- **Cookie names** follow the context: `__Host-gm_session` (and `__Host-gm_handoff`) with
  `Secure` over https and on the loopback host, unprefixed `gm_session` without `Secure`
  over plain http to a LAN address, where browsers drop `Secure` cookies. The two sets
  are never read across. The proxy re-sets the session cookie at most daily (on Netlify
  as an edge function).
- **Hosting** (ADR 0008) changes nothing in the design. A hosted instance starts empty
  and is claimed like a fresh one; history from a local installation moves with
  `pnpm import:local`, which never copies accounts, keys, sessions or links, so everyone
  joins the hosted instance first (claim or invite) and creates new bookmarklets for it.
