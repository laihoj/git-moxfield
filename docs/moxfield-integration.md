# Moxfield integration

Moxfield has no public developer API. Its FAQ ("Is there any documentation on
Moxfield's API?") states that the API is not public, and that Moxfield occasionally
helps personal, non-commercial projects that contact support@moxfield.com. The API's
root (`GET https://api2.moxfield.com/`) answers with the notice
`"This API is not intended for public use."`

git-moxfield therefore treats Moxfield as an _undocumented, read-only_ source,
isolates every assumption in `src/integrations/moxfield/`, and degrades gracefully.

Findings below were verified on **2026-10-09** against live public decks.

## Endpoints

### Deck: `GET https://api2.moxfield.com/v3/decks/all/{publicId}`

`publicId` is the id in the deck URL (`https://moxfield.com/decks/{publicId}`,
22 characters of `[A-Za-z0-9_-]`). This is the endpoint Moxfield's own web app calls
when opening a deck. `v2/decks/all/{publicId}` also still works but is legacy.

Fields git-moxfield relies on:

| Field                                          | Notes                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `id`                                           | Internal deck id (e.g. `A0j00`). Needed for the primer endpoint.            |
| `publicId`, `publicUrl`                        | Public identity.                                                            |
| `name`, `description`, `format`, `visibility`  | `description` is a short blurb, **not** the primer.                         |
| `version`                                      | Integer revision counter, increments on edits. Shown as "Moxfield version". |
| `lastUpdatedAtUtc`, `createdAtUtc`             | ISO timestamps.                                                             |
| `createdByUser.userName`, `authors[].userName` | Author names.                                                               |
| `hubs[].name`                                  | Deck-level tags (e.g. `cEDH`, `Turbo`).                                     |
| `authorTags`                                   | `{ [cardName]: string[] }` per-card user tags. Often empty.                 |
| `boards`                                       | `{ [boardName]: { count, cards: { [entryKey]: entry } } }`                  |
| `enableMultiplePrintings`                      | When true, the same card may appear as several entries in one board.        |

Observed board names: `mainboard`, `sideboard`, `maybeboard` (shown as "Considering"
in Moxfield's UI), `commanders`, `companions`, `signatureSpells`, `attractions`,
`stickers`, `contraptions`, `planes`, `schemes`, `tokens`. Unknown boards are preserved
as `other:<slug>` zones.

Board entry:

| Field                          | Notes                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `quantity`                     | Integer.                                                                                                             |
| `boardType`                    | Usually the board name; in `commanders` it can be `partners` for the second commander. Not used for zone assignment. |
| `finish`                       | `nonFoil` / `foil` / `etched`.                                                                                       |
| `isFoil`, `isAlter`, `isProxy` | Booleans.                                                                                                            |
| `card`                         | Card object (below).                                                                                                 |

Card object (Scryfall-derived plus Moxfield ids):

| Field                                                                               | Meaning                                                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `uniqueCardId`                                                                      | Moxfield's **oracle-level** id — identical across printings (verified: the same card in different sets in different decks shares it). |
| `id`                                                                                | Moxfield **printing** id.                                                                                                             |
| `scryfall_id`                                                                       | Scryfall printing id.                                                                                                                 |
| `name`                                                                              | Full name; split/DFC cards as `Front // Back`.                                                                                        |
| `set`, `cn`                                                                         | Set code and collector number of the printing.                                                                                        |
| `lang`, `layout`, `type_line`, `mana_cost`, `cmc`, `color_identity`, `card_faces[]` | Reference data used for display only.                                                                                                 |

Entry keys inside `boards.*.cards` were equal to `uniqueCardId` for every deck we
inspected (all had `enableMultiplePrintings: false`). The adapter never relies on that:
it iterates entries and aggregates by card identity, so multiple-printing decks work.

### Primer: `GET https://api2.moxfield.com/v1/decks/{id}/primer`

Uses the **internal** deck `id`, not the public id. Response:

```json
{ "content": "markdown…", "lastUpdatedAtUtc": "…", "lastUpdatedByUser": { "userName": "…" } }
```

`content` is `""` when the deck has no primer. The markup is Markdown plus Moxfield
directives: `===center` / `===endcenter`, `===accordion` / `===endaccordion`,
`===panel: Title` / `===endpanel`, and `[[Card Name]]` card references.

## Access restrictions (important)

- Requests to `/v1`, `/v2`, `/v3` paths from a server (curl/Node), with or without a
  browser-like User-Agent, received **HTTP 403 with a Cloudflare "Sorry, you have been
  blocked" HTML page**. The same requests from a real browser on `moxfield.com` succeed.
- CORS: the API does not allow other origins; a page served by git-moxfield cannot
  call it from the browser.
- Moxfield's documented route for third-party tools is to ask support for access.
  Approved projects receive a dedicated User-Agent string.

git-moxfield never tries to evade bot protection (no browser impersonation, no
headless browsers, no spoofed User-Agents). Instead:

1. **Server fetch** with `MOXFIELD_USER_AGENT` (a Moxfield-issued UA) when configured.
   Without it, the server sends an honest `git-moxfield/<version>` User-Agent; a
   Cloudflare block is detected (403 + HTML) and reported as `blocked`, and server
   fetching pauses for every instance until an admin resumes it. On Netlify server
   fetching is off by default (`MOXFIELD_SERVER_FETCH=off`): requests from cloud servers
   are blocked without the issued UA. Server fetches happen only when a user refreshes,
   tracks or relinks a deck, and before a commit; never in the background.

## Terms of the issued User-Agent, and how the server keeps them

Moxfield issued git-moxfield a User-Agent on these terms: **at most 1 API call per
second**, no profit, never share the User-Agent, no support. Moxfield also said that a 429
always comes before a 403, and that a ban only follows continued abuse. How git-moxfield
keeps them ([ADR 0009](adr/0009-global-moxfield-rate-limit.md)):

- **One limit for every instance.** `src/integrations/moxfield/http-client.ts` is the
  only code that sends requests to Moxfield (a test enforces it), and before every
  request (deck, primer, each retry) it asks the request limiter, which reserves the next
  slot in one row of the shared database (`moxfield_rate`) with one atomic statement on
  the database's clock. Slots are `MOXFIELD_MIN_REQUEST_INTERVAL_MS` apart (2,000 ms by
  default, never less than 1,500 against Moxfield); a request that might start more than
  `interval - 1,250 ms` late gives its slot up. Two requests of the installation start at
  least 1.25 s apart, whichever instances send them and whatever their clocks say. A slot
  more than 10 s away is refused ("busy, try again in N s"). When the database cannot be
  reached, nothing is sent.
- **429.** Every instance waits for `Retry-After` (or 30 s, doubling with each 429 in a
  row, at most 15 min), then runs at half speed for 10 min, and recovers on its own.
- **The firewall: a non-JSON 403, a challenge or HTML.** Server fetching pauses for every
  instance until an admin resumes it on the Admin page or with `pnpm moxfield resume`.
  The reason and the time are shown on the deck status panel, Connect Moxfield and the
  Admin page. A 403 in JSON is a private deck (that deck only), unless its body mentions
  a rate limit, block, ban or the like, or cannot be read: then it pauses too.
- **The User-Agent** is set only in the production site's Netlify environment variables
  (never in a file), never logged, and never sent anywhere but in requests to Moxfield's
  API. An instance with it configured outside the Netlify production deployment warns
  loudly: another database would keep a second, separate limit.

2. **Browser capture**: the "Send to git-moxfield" bookmarklet runs on a Moxfield deck
   page, fetches the two endpoints above as the user's own browser (exactly what the
   Moxfield page itself does), compresses the result and hands it to git-moxfield.
3. **Manual paste**: open the two endpoint URLs in a browser and paste the JSON.

All three paths feed the same validation (`zod`) and normalization code.

## Capture payloads and their compression

The bookmarklet wraps what it fetched in a capture envelope
(`{ kind: 'git-moxfield/capture', version: 2, deck, primer, … }`,
`src/integrations/moxfield/capture-protocol.ts`), serializes it as JSON and, since the
move to Netlify (ADR 0008), compresses it before handing it over:

```
gm-gzip-base64url:<base64url of one gzip member of the UTF-8 JSON>
```

- **Why.** Netlify rejects request bodies over 6 MB with a 500 before the app runs. The
  app accepts captures of up to 8 MB of JSON, and form encoding makes a plain capture
  1.44 times larger on average (up to three times), so large decks would have failed at
  the platform without a useful message. Compressed, they stay far below: measured on a
  real deck, 835,292 bytes of JSON became 110,327 bytes of gzip (7.6:1), 147,103
  characters encoded.
- **How.** The browser's `CompressionStream('gzip')`, then base64url without padding,
  whose characters need no escaping in JSON and no percent-encoding in a form, so the
  request size is exactly the payload size. The bookmarklet embeds a small ES2020
  encoder (`ENCODE_CAPTURE_PAYLOAD_SOURCE`); the capture and paste pages use the typed
  one (`encodeCapturePayload`). Without `CompressionStream` (Chrome before 80, Firefox
  before 113, Safari before 16.4) they send plain JSON.
- **Same text everywhere.** The encoded payload is the PAYLOAD message's `json` (popup),
  the `payload` of `POST /api/capture`, the `payload` form field (same tab) and what the
  clipboard fallback copies; the paste form accepts it as well as plain JSON.
- **No new envelope version.** The tag makes the encoding self-describing, and untagged
  text is plain JSON, so bookmarklets made before compression keep working: the capture
  page compresses what they hand over, and only their same-tab posts arrive plain. Text
  starting with `gm-` is always treated as an encoding; an unknown one is refused.
- **Decoding** (`capture-codec.ts`, server-only) happens after the key or session is
  accepted, within hard limits: at most 2,000,000 encoded characters, at most
  8,000,000 bytes inflated (a decompression bomb stops there), at most 1,400,000 bytes
  of plain JSON; a strict base64url alphabet and valid UTF-8. Every body the capture
  routes accept stays under Netlify's 6 MB even if the platform base64-encodes it, so
  users see git-moxfield's own "too large" message rather than a platform error.

## Same-tab capture: `Origin: null` and the bookmarklet key

The same-tab bookmarklet (phones, in-app browsers) submits a hidden form from the
Moxfield deck page to git-moxfield's `/api/capture/form`. That is a cross-site POST, so
the endpoint cannot rely on the browser's session cookie (`SameSite=Lax` cookies are
not sent with it) or on the `Origin` header.

**Finding (2026-10-09, real end-to-end test against live moxfield.com in Chromium):**
the post from `https://moxfield.com/decks/…` to `http://localhost:3003/api/capture/form`
arrived with `Origin: null` and `Sec-Fetch-Site: cross-site`. This is standard
behavior, not a quirk: for a non-CORS request whose method is not `GET`/`HEAD`, the
Fetch standard serializes the request origin as `null` when the referrer policy is
`no-referrer`, or when it is `strict-origin-when-cross-origin` (the browser default),
`strict-origin` or `no-referrer-when-downgrade` and the request goes from an `https:`
page to a non-`https:` URL. git-moxfield often runs on plain http (localhost or a LAN
address), so every real same-tab capture looks like this. The first implementation
required `Origin: https://moxfield.com` and therefore rejected every real capture with
403; the mock Moxfield did not reproduce it because mock and app both run on http.

`Origin: null` cannot authenticate anything: any site can produce it (a `no-referrer`
policy, a sandboxed frame). So the endpoint authenticates the **bookmarklet key**
(ADR 0006): each bookmarklet carries its user's personal `gmk_` key as the form field
`token` next to `payload`.

- The key decides whose workspace receives the deck. Requests without a valid key get
  403 with reinstall instructions; the log says whether a key was missing, malformed or
  unknown, never its value.
- The key does **not** prove that the browser's own user ran the bookmarklet: any
  member can post their own valid key from any page. A forged post can therefore only
  ever add a deck to the forger's own workspace, and it never changes who the browser
  is signed in as on its own (no login CSRF): the endpoint starts a pending hand-off
  that signs nobody in and redirects through `/api/auth/handoff`, a top-level GET that
  carries the browser's own session cookie. A browser already signed in as the key's
  owner goes straight on to the deck; any other browser (signed out, or signed in as
  someone else) gets `/signin/bookmarklet`, which names the account and the
  bookmarklet and asks once, and only a same-origin POST from that page signs it in.
- The `Origin` check remains as defence in depth: `null`, a missing header, or one of
  `CAPTURE_ALLOWED_ORIGINS` (e.g. `https://moxfield.com` when git-moxfield is served
  over https) pass; any other explicit origin is a third-party site and gets 403.
- The popup bookmarklet hands the deck and the key to git-moxfield's own capture page by
  `postMessage` (exact origins and a one-time nonce), and that page submits them
  same-origin to `/api/capture`.
- Bookmarklets made before accounts, or by another installation, get the 403 page and
  must be recreated from `/setup`. A key is revoked in Account.

The mock Moxfield's deck page sends `Referrer-Policy: no-referrer`, so the e2e suite
sees `Origin: null` on the same-tab post too (`tests/e2e/same-tab-capture.spec.ts`,
which also checks that a third-party page posting another member's key cannot sign a
browser in).

**Hosted on https** (Netlify), the post goes from https to https, so browsers with the
default referrer policy send the real origin, `Origin: https://moxfield.com`, which
`CAPTURE_ALLOWED_ORIGINS` allows by default. This was verified in Chromium and WebKit
with an https site pair standing in for Moxfield, not against live moxfield.com (its
response headers could not be read: Cloudflare answers 403 to non-browser clients). If
Moxfield sends `Referrer-Policy: no-referrer`, the post arrives with `Origin: null`
again, which is accepted. Either way the key is what authenticates.

## Failure handling

| Situation                | Detection                                                                                              | Result                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed URL / id       | URL parser                                                                                             | `invalid-ref`, nothing fetched                                                                                                                    |
| Deleted deck / wrong id  | 404                                                                                                    | `not-found`                                                                                                                                       |
| Private deck             | 401, or 403 with a JSON body                                                                           | `forbidden`                                                                                                                                       |
| Refused                  | 403 that is not JSON, or JSON mentioning a rate limit, block, ban…, or unreadable JSON                 | `blocked`; server fetching paused for every instance until an admin resumes it                                                                    |
| Cloudflare block         | 403 + `text/html` (or `cf-ray`, non-JSON), `cf-mitigated: challenge` at any status, or HTML with a 2xx | `blocked`; server fetching paused for every instance until an admin resumes it                                                                    |
| Rate limit               | 429                                                                                                    | `rate-limited`; every instance waits for `Retry-After` (else 30 s, doubling per 429 in a row, at most 15 min), then runs at half speed for 10 min |
| Too many requests queued | the next free slot is more than 10 s away                                                              | `rate-limited` ("busy, try again in N s"), nothing sent                                                                                           |
| Limiter unavailable      | the database cannot be reached                                                                         | `unavailable`, nothing sent (fails closed)                                                                                                        |
| Moxfield down            | 5xx (including an HTML maintenance page behind Cloudflare) / network error / timeout                   | `unavailable` / `network` / `timeout`; one retry for 5xx/network, after `Retry-After` when that is at most 5 s (no retry when longer)             |
| Schema change            | zod validation                                                                                         | `schema` error listing the failing paths; partial fields produce warnings                                                                         |
| Primer missing / failing | primer request fails                                                                                   | deck still ingested, primer `null` + warning                                                                                                      |
| Capture too large        | capture route body limit or codec limit                                                                | 413 (`/api/capture`) or paste form with `error=too-large` (same-tab); nothing stored                                                              |
| Capture damaged          | codec (bad tag, alphabet, gzip, UTF-8) or JSON/zod parsing                                             | 400 (`/api/capture`) or paste form with `error=invalid` (same-tab); nothing stored                                                                |
| Deck deleted, made again | new public id; the old one answers 404                                                                 | `not-found` on refresh; the owner changes the deck's Moxfield deck (history kept), see the README                                                 |
