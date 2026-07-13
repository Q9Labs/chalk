# Chalk webhook contract version 1

This directory is the shared source of truth for outbound webhook producers,
the dispatcher, and receiver SDKs.

- `event.schema.json` defines every known version 1 Event body, including the
  capability-gated Recording and Transcript types.
- `fixtures.json` stores the exact compact UTF-8 bytes expected from Go and
  Elixir encoders. `body_utf8` is the fixture; whitespace around the containing
  JSON document is not part of a webhook body.
- `signature-vectors.json` signs the Participant fixture containing Unicode,
  quotes, a backslash, and HTML-sensitive characters with current and previous
  32-byte secrets. Implementations must reproduce both signatures without
  parsing, HTML-escaping, or reserializing `body_utf8`.
- `journey-events.json` fixes the durable internal journey vocabulary. These
  names and identifiers never enter the customer request.

The wire encoder writes envelope fields in `id`, `event`, `api_version`,
`occurred_at`, `tenant_id`, `data` order and uses each object order shown in the
fixtures. Timestamps are UTC RFC 3339 with exactly three fractional digits.
Optional snapshot facts are explicit `null`. The body has no insignificant
whitespace or trailing newline and is stored once before delivery.

Adding optional fields is compatible with version 1. Removing or renaming a
field, changing its JSON type or meaning, or moving an Event's authoritative
emission boundary requires a new numeric API version and new fixtures.
Recording and Transcript schemas are reserved contracts until their independent
pipeline capabilities are enabled; their presence here does not authorize
subscription or emission.
