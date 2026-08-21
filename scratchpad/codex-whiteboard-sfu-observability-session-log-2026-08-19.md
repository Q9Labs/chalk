# Whiteboard and SFU observability session log

Date: 2026-08-19

## Diagnosis

- The React Space surface created the Board collaboration engine without starting the Whiteboard scene subscription. Snapshot calls therefore reached an idle transport and threw `Whiteboard is not connected`.
- The collaboration engine also attached rejection handlers after calling `requestSnapshot`, so a synchronous transport error escaped as an uncaught exception.
- Cloudflare SFU failures were mapped to a safe public `media.unavailable` response, but internal telemetry discarded the provider's useful error code, message, response size, track counts, and trace identifiers.

## Fix

- The React surface now owns the Board scene subscription while the Board is open, waits for the initial snapshot before mounting collaboration, and stops the subscription during cleanup.
- Snapshot requests now convert synchronous transport failures into rejected promises handled by the collaboration engine.
- SFU failure telemetry now records bounded provider diagnostics, trace correlation, response size, and track counts. Provider text is scrubbed and fingerprinted before logging; request credentials, identifiers, SDP, and media values remain excluded.

## Verification

- Focused React and Whiteboard tests and type checks passed.
- Focused Cloudflare SFU adapter tests passed.
- The SFU execution-trace scenario passed and proved sensitive request values are absent from telemetry.
- Release metadata prepared for SDK version 4.1.4.
- The first browser dogfood pass reached the local API but exposed an unrelated invalid bootstrap idempotency key. A second pass uses a valid local seed path to exercise the real web, API, and Sync flow.
- Post-commit review found that the initial Board snapshot could arrive before the canvas subscribed and that arbitrary Unicode or dotted numeric provider text could survive redaction. The transport now replays its latest live snapshot to late subscribers without a second scene transfer, snapshot failures are surfaced and cleared on retry, and the scrubber replaces every numeric and non-ASCII token.
