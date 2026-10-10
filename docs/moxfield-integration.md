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
   fetches pause for `MOXFIELD_BLOCK_BACKOFF_SECONDS`.
2. **Browser capture**: the "Send to git-moxfield" bookmarklet runs on a Moxfield deck
   page, fetches the two endpoints above as the user's own browser (exactly what the
   Moxfield page itself does), and hands the JSON to git-moxfield.
3. **Manual paste**: open the two endpoint URLs in a browser and paste the JSON.

All three paths feed the same validation (`zod`) and normalization code.

## Same-tab capture: `Origin: null` and the capture token

The same-tab bookmarklet (phones, in-app browsers) submits a hidden form from the
Moxfield deck page to git-moxfield's `/api/capture/form`. That is a cross-site POST, so
the endpoint needs its own CSRF protection.

**Finding (2026-10-09, real end-to-end test against live moxfield.com in Chromium):**
the post from `https://moxfield.com/decks/…` to `http://localhost:3003/api/capture/form`
arrived with `Origin: null` and `Sec-Fetch-Site: cross-site`. This is standard
behavior, not a quirk: for a non-CORS request whose method is not `GET`/`HEAD`, the
Fetch standard serializes the request origin as `null` when the referrer policy is
`no-referrer`, or when it is `strict-origin-when-cross-origin` (the browser default),
`strict-origin` or `no-referrer-when-downgrade` and the request goes from an `https:`
page to a non-`https:` URL. git-moxfield normally runs on plain http (localhost or a LAN
address), so every real same-tab capture looks like this. The first implementation
required `Origin: https://moxfield.com` and therefore rejected every real capture with
403; the mock Moxfield did not reproduce it because mock and app both run on http.

`Origin: null` cannot authenticate anything: any site can produce it (a `no-referrer`
policy, a sandboxed frame). So the endpoint is protected by a **capture token**:

- Each installation has a secret token: 32 random bytes as 64 hex characters, created
  atomically on first use and stored in the `app_settings` table (key `capture-token`).
- The setup page bakes it into the same-tab bookmarklet, which posts it as the form
  field `token` next to `payload`. The endpoint compares it in constant time (SHA-256
  digests and `timingSafeEqual`) and answers 403 with reinstall instructions otherwise.
  It logs whether a token was missing or wrong, never its value.
- The `Origin` check remains as defence in depth: `null`, a missing header, or one of
  `CAPTURE_ALLOWED_ORIGINS` (e.g. `https://moxfield.com` when git-moxfield is served
  over https) pass; any other explicit origin is a third-party site and gets 403.
- The popup bookmarklet carries no token. It hands the deck to git-moxfield's own
  capture page by `postMessage` (exact origins and a one-time nonce), and that page
  submits it same-origin to `/api/capture`.
- The same-tab bookmarklet is therefore a credential for this installation: it only
  runs on the Moxfield site origin, and the token sits in a hidden form field for the
  moment of the post. Bookmarklets made before the token existed, or by another
  installation, get the 403 page and must be reinstalled from `/setup`.
- To revoke the token, delete it (`DELETE FROM app_settings WHERE key = 'capture-token'`
  in the app's SQLite database); a new one is created on the next visit to `/setup`, and
  the same-tab bookmarklet must be reinstalled.

The mock Moxfield's deck page sends `Referrer-Policy: no-referrer`, so the e2e suite
sees `Origin: null` on the same-tab post too (`tests/e2e/same-tab-capture.spec.ts`).

## Failure handling

| Situation                | Detection                                                                            | Result                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Malformed URL / id       | URL parser                                                                           | `invalid-ref`, nothing fetched                                                                                                        |
| Deleted deck / wrong id  | 404                                                                                  | `not-found`                                                                                                                           |
| Private deck             | 401/403 JSON                                                                         | `forbidden`                                                                                                                           |
| Cloudflare block         | 403 + `text/html` (or `cf-ray`, non-JSON), or `cf-mitigated: challenge`              | `blocked`, server fetch paused                                                                                                        |
| Rate limit               | 429                                                                                  | `rate-limited` with `Retry-After`; every server request waits that long (60 s without the header)                                     |
| Moxfield down            | 5xx (including an HTML maintenance page behind Cloudflare) / network error / timeout | `unavailable` / `network` / `timeout`; one retry for 5xx/network, after `Retry-After` when that is at most 5 s (no retry when longer) |
| Schema change            | zod validation                                                                       | `schema` error listing the failing paths; partial fields produce warnings                                                             |
| Primer missing / failing | primer request fails                                                                 | deck still ingested, primer `null` + warning                                                                                          |
