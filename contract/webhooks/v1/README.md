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
Recording and Transcript lifecycle Events are subscribable. Recording completion
is emitted with the verified Export MP4 commit; Transcript completion is emitted
with the ready document commit. Capture readiness and terminal worker failures
produce their corresponding lifecycle Events transactionally.

## Participant timing and computing attendance

`participant.joined` fires when API admission is committed by Sync and the Participant becomes active, not when the first socket or media connection opens. `joined_at` and `occurred_at` are that activation transaction's timestamp. Admission can precede the browser's joined callback. The background lifecycle consumer applies the API intent; a Sync handshake can also apply the same pending intent before admitting its socket. Reusing an already-admitted seat does not emit another joined Event.

`participant.left` fires after an explicit leave or removal is finalized. Its `left_at` and `occurred_at` are the departure transaction's timestamp. When an Episode ends (participant, server, or deadline), Chalk commits a departure for every still-admitted Participant with `left_at` equal to `episode.ended.data.object.ended_at` and `reason: "episode_ended"`. Participants already left do not receive another departure. Pending, never-admitted Participants do not receive attendance Events. These departures are queued before `episode.ended`, but HTTP arrival order is **not guaranteed**.

Socket loss, closing a tab, and brief network interruptions do not emit a departure today. A reload can reuse the same Participant without another join. These timestamps measure durable admission, not verified continuous media presence.

To compute attendance, subscribe to both Participant Events. Store one segment per `(episode_id, id)` using the snapshot's `joined_at` and `left_at`, deduplicate by `event.id`, and preserve an existing time out when a delayed join arrives. A left Event includes both times, so it can create a closed segment even if the join has not arrived. Ignore duplicate departures for a closed segment. Do not use request arrival time or depend on `episode.ended` to close segments.

## Delivery retries

Return `2xx` within ten seconds to acknowledge an Event. Network failures, timeouts, `5xx`, and `408`, `425`, or `429` are retryable. Other `4xx`, including `401`, are terminal after that attempt; returning `401` while repairing verification discards that delivery rather than postponing it.

Automatic attempts are scheduled at offsets from Event occurrence: immediately, 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 24 hours, 48 hours, and 72 hours (11 attempts maximum). Retries have deterministic early jitter of up to 10% of their offset. A supported `Retry-After` can delay them further; worker availability and an already-late attempt can also delay actual arrival. Delivery is duplicate-prone and unordered, including across retries and endpoints. Inspect deliveries and use manual redelivery after correcting a terminal failure.
