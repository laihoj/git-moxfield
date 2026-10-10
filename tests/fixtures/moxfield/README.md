# Moxfield fixtures

Captured from the live API on 2026-10-09 and then sanitized:

- `v3-deck.json`: shape of `GET https://api2.moxfield.com/v3/decks/all/{publicId}`.
  Real field names and value formats (card ids, `boardType: "partners"`, DFC `card_faces`,
  empty boards). It was trimmed to a few cards per board, with large reference fields
  removed (oracle text, prices, store URLs, legalities). Deck ids, names and user
  names are replaced with fixture values.
- `v1-primer.json`: shape of `GET https://api2.moxfield.com/v1/decks/{id}/primer`.
  The content is synthetic and uses Moxfield's primer directives, plus deliberately
  hostile markup for sanitizer tests.
- `v2-deck.json`: synthetic deck in the legacy `v2/decks/all/{publicId}` shape (boards as
  top-level maps keyed by card name, counts in `<board>Count`), used to keep the adapter's
  legacy-shape support honest. All ids and names are fixture values.
