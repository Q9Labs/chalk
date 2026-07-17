# Debugging And RCA Lessons

## Join And Reconnect Diagnostics

Several join failures were difficult to reason about until the SDK exposed a
structured timeline. The useful lesson is that the join path needs phase-level
events across UI intent, room lookup, participant creation, RealtimeKit
preload/join, websocket lifecycle, and media transport state.

Useful public guidance:

- capture compact structured events, not raw user/session logs
- include outcome, duration, phase, and sanitized error excerpts
- distinguish room resolution failures from participant join failures and
  transport/media failures
- avoid logging tokens, tenant identifiers, room identifiers, IP addresses, or
  raw websocket URLs

## Debug Reports

Debug exports should be safe by construction. They should redact obvious token
fields, compact noisy timelines, and summarize browser/network hints without
capturing raw personal or tenant-specific data.

## Websocket Transport

Reconnect and websocket investigations showed that public SDK behavior should
not depend on private app retry assumptions. The SDK should expose enough state
to make reconnect attempts, close/error events, and token refresh behavior
visible to callers without making consumers parse raw logs.

## Mobile Rendering And Media

Mobile work surfaced several recurring patterns:

- prejoin screens need resilient preview fallbacks when native media is not
  ready
- last-frame and media-visibility bugs often come from lifecycle transitions,
  not just track state
- device and simulator checks are necessary for camera, screen share, and
  native meeting panels
- native surfaces should fail into explicit UI states rather than blank screens

## Incident Lessons

Durable incident memory:

- stale or mismatched release configuration can masquerade as SDK runtime
  failure
- deploy verification should prove both artifact version and live behavior
- queue/worker systems need terminal failure semantics and observable retries
- public status or incident systems should avoid leaking implementation detail
  while still providing useful customer-facing updates

## Monitor Contract Drift

An uptime worker can remain present, tested, and deployable while no longer
observing the rebuilt system. Verify every configured probe path, expected
status, and ingest endpoint against the current application router after route
or architecture resets. Exercise the complete probe-to-ingest-to-alert loop;
unit tests against mocked legacy endpoints do not prove active monitoring.

## Partial Status Needs A Completion Boundary

A partial badge without an explicit completion boundary makes readers infer the
missing work and quickly becomes misleading. Keep the unfinished capability or
proof next to the status interaction, distinguish missing implementation from
missing deployment verification, and fail local validation when a partial item
has no public-safe gap definition.

## Provider Visibility Ceilings

End-to-end observability cannot turn provider-owned internals into observed
facts. Mark evidence as observed, derived, inferred, unknown, stale, or
intentionally excluded. Correlate provider API outcomes with evidence from both
clients and synthetic probes, and keep unknown visible in dashboards. A green
panel without evidence confidence can conceal the exact blind spot operators
need to understand.

## Sampling Must Preserve The Journey

Sampling detailed spans or client diagnostics can erase the only evidence that
an otherwise healthy operation happened. Retain a lightweight root-to-terminal
journey skeleton for every meaningful managed operation. Sample expensive
detail after the skeleton is stored, and treat a missing phase or terminal
event as a queryable failure instead of silently dropping the journey.

## Journeys Begin At The First Observable Cause

Operational journeys do not always begin in a UI. Record the root type, first
observed layer, and whether upstream visibility is complete, external, or
unknown. Follow every downstream branch to an explicit terminal state. This
keeps provider callbacks, scheduled work, recovery loops, and monitor events
fully diagnosable without manufacturing a causal history outside the system's
evidence boundary.

## A Dashboard Is Not A Journey Ledger

A single visualization surface does not guarantee a complete operational
record. If clients, gateways, or collectors may drop data, a promise to retain
every journey requires an explicit delivery contract, durable acceptance point,
idempotent event identity, deduplication, late-event handling, and backfill.
Grafana can remain the cockpit while a separate durable record preserves the
journey skeleton through telemetry-backend outages.

## Transactional Producers Need Post-Commit Signals

Do not emit committed or fanout counters while a webhook producer is still
inside its enclosing product transaction; a later rollback creates phantom
success telemetry. Emit from the original post-commit return path, using a
bounded lookup keyed by the durable transition, and keep replay or duplicate
resolution silent.

Postgrex defaults JSON/JSONB handling to optional Jason callbacks. An Elixir
application using the standard `JSON` module should configure Postgrex's JSON
library explicitly, or production builds that omit a dev-only transitive Jason
dependency can compile yet fail on their first persisted JSONB read.

## Generated Decoders Must Preserve Validated Authority Fields

A generated decoder can validate an exact wire field and still break the
runtime if it omits that field from the normalized value. Assert the semantic
decoded shape as well as fixture acceptance and generated-file drift. Real
transport proofs should treat a protocol error after apparent convergence as a
failure, because racing to stop after the event can hide a rejected delivery
acknowledgement.
