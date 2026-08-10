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

## Protected Services Should Monitor Their Denial Boundary

A private service does not need a public health bypass. Its anonymous synthetic
can expect the authentication denial status plus stable security and build
headers, proving that the deployment is reachable and still protected without
disclosing credentials or authenticated content. Treat a bare denial response
without the expected boundary headers as a failed check.

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

## A Page Journey Does Not Correlate An Episode Journey

Starting a browser `web.application` journey at the document root does not
instrument a later Episode journey. The Episode-start path must receive the
active page journey or create a child Episode journey, then propagate W3C trace
context through the AccessGrant, media, and Sync boundaries and emit a terminal
outcome; otherwise an enabled exporter only proves that the page loaded.

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

## State Galleries Must Reach The Production Empty Boundary

A fixture harness can label a route as empty while the production component
still renders a blank surface. Drive zero-data scenarios through the same
component used by the product, assert meaningful status semantics, and verify
the result at desktop and mobile widths. Preview chrome also needs a tested
restore affordance above product-owned mobile docks; DOM presence alone does
not prove that the control is visible or usable.

## Browser Boundaries Need Contract Adapters

Generated API clients validate the upstream wire contract, but a browser
boundary may deliberately remove credentials or add CSRF and cookie behavior.
Keep those security transformations at the boundary adapter, then use the
generated client for resource calls whose response shape remains exact.

## Access Grant Adapters Must Preserve Optional Credentials

An API can issue a valid diagnostics credential while the browser still records
no evidence if an SDK adapter rebuilds the AccessGrant and drops that optional
field. Test the normalized grant after every adapter boundary, not only the
upstream wire response, because silent field loss looks like a healthy but empty
diagnostics pipeline.

## Public Status Needs A Narrow Projection

An anonymous status page should receive only the stable component summary it
can render. Keep monitor keys, target URLs, error details, and credentials on
the worker and API side, and make the browser boundary allowlist both fields
and trace headers so a future upstream response cannot widen public exposure.

## Status Projections Must Be Monotonic

Persist each monitor result for auditability, then update the current projection
only when its checked timestamp advances. Missing or stale rows are `unknown`,
not healthy, and public responses should be built from an allowlisted catalog
so internal monitor identity and failure detail never cross the boundary.

## Explicit Orchestration Is A Role Boundary

When the production owner asks for orchestration, keep the root thread out of
execution detail. Give bounded discovery, reproduction, and implementation to
Luna workers. The root thread owns the task map, seam decisions, integration,
final verification, and production authorization. Do not drift back into
hands-on diagnosis merely because a gate fails.

## Live State Queues Must Prefer The Newest Snapshot

A connection callback can enqueue an older recovery snapshot after a direct
waiter has already observed the live state. Coalesce queued snapshots and read
the latest connection state before starting recovery, or the lifecycle can stop
a healthy client and loop until recovery is exhausted.

## Debugger Entry Points Should Start From Product Records

Operators should not hunt through logs for an internal diagnostic reference.
Link the debugger from the authorized Episode record, resolve its safe Episode
reference inside the tenant boundary, and show the canonical diagnostic
reference after resolution for precise handoffs.

## Generated UUID Validators Must Match The API Parser

Do not make generated browser schemas stricter than the API's accepted UUID
text contract. If the API accepts PostgreSQL-shaped hexadecimal UUID values,
test every branded generated ID against that same shape so valid production
records cannot make an otherwise successful list response fail in the browser.

## GitHub Workflow Dispatch Needs An Explicit Repository

`gh repo view` can infer a repository from a local Git remote, while
`gh workflow run` can still fail when no GitHub CLI default repository is set.
Release scripts should pass `--repo owner/repo` or set and verify the intended
default before dispatching a workflow, especially in clones with multiple
remotes. This failure happens before GitHub Actions starts, so it does not
prove anything about the workflow, npm credentials, or package state.

## npm Release Scopes Must Belong To The Publishing Organization

A valid npm token can still return `404` on `PUT` when the package scope
belongs to another organization. Verify every release scope belongs to the
publishing account or organization. Publish retries should query the registry
and skip exact versions that succeeded before a later package failed.
