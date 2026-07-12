# Chalk Outbound Webhooks Spec

Status: Proposed

Owner: Hasan Shoaib

## Purpose

Chalk will let a tenant register HTTPS endpoints and subscribe them to durable
product lifecycle events. The launch contract is a public API and generated SDK
surface, at-least-once delivery, Standard Webhooks-compatible signatures, an
inspectable delivery history, and manual redelivery. Webhooks notify a
customer's backend that a fact occurred; PostgreSQL and the existing REST
resources remain the authorities for current state.

The version 1 contract defines reusable Rooms, live Sessions, Participants,
Recordings, and Transcripts, but rollout is capability-gated. Core launch ships
Room, Session, and Participant Events. Recording and Transcript Events remain
reserved until their independent production pipelines pass their companion
specs and staging gates. High-frequency or transient meeting activity such as
media toggles, reactions, hand raises, active-speaker changes, screen-share
changes, transport connectivity, and Sync recovery remains excluded because it
belongs in the live Session client and would add volume, privacy exposure, and
false durability expectations to a business-integration surface.

## Primary customer workflows

1. **Configure a receiver.** A tenant Admin creates an Endpoint with an explicit
   Event allowlist, stores the returned signing secret in the consumer backend,
   installs the server-only webhook SDK entry point, sends an `endpoint.test`
   Event, and verifies the signature from the raw body before enabling business
   side effects.
2. **React to a lifecycle fact.** The receiver validates the attempt timestamp
   and signature through the SDK, validates the versioned body, durably claims
   the Event ID through an application-supplied inbox, dispatches to a typed
   handler, applies its idempotent side effect, and returns `2xx` within ten
   seconds. When the snapshot is insufficient or an Event arrives out of order,
   it reads the current authorized resource through the Chalk API.
3. **Recover a failed integration.** An Admin lists exhausted or pending
   Deliveries, inspects bounded Attempt facts, fixes the receiver, and requests
   redelivery while the Event remains inside the 30-day retention window.
4. **Rotate trust without downtime.** An Admin rotates the secret, deploys the
   new value while Chalk signs with old and new versions for 24 hours, confirms
   a test Event, and lets the previous secret expire. Suspected compromise uses
   immediate previous-secret revocation.

There is no launch dashboard. The public API, generated SDK, receiver
documentation, and delivery-inspection responses are the complete management
experience. A future dashboard may compose those contracts without becoming a
second source of truth.

## Settled product decisions

- Delivery is at least once while its Endpoint Revision remains eligible. A
  consumer can receive the same Event more than once and must deduplicate by
  `id`; Chalk does not claim exactly-once delivery. Explicit Endpoint disable,
  destination replacement, deletion, Event erasure, or retention expiry can
  cancel pending work as specified below.
- Delivery order is not guaranteed, including between Events for the same
  resource. The immutable Event says what happened and when, while an API read
  returns the current resource state.
- Tenants manage endpoints, subscriptions, secret rotation, tests, delivery
  inspection, and redelivery through `/v1` API routes and generated SDKs.
- The TypeScript SDK exposes server-side receiver processing that owns raw-body
  verification, timestamp and signature validation, versioned decoding, typed
  dispatch, rotation overlap, and duplicate coordination. It never claims that
  an SDK alone can make a customer's side effect exactly once.
- Payloads contain a minimal typed snapshot. They include stable identifiers,
  lifecycle status and timestamps, and a Participant's display name and
  optional User linkage. They exclude arbitrary resource metadata, Transcript
  text, object-storage keys, download URLs, credentials, internal provider
  fields, raw errors, and media.
- Recording and Transcript Events expose `started`, `completed`, and `failed`.
  Internal reservation, queue, lease, rendering, provider, verification, retry,
  and fallback states remain implementation details. These Events are reserved,
  unavailable subscription values at core launch, and become available only
  after the production artifact pipelines are independently complete.
- Room definition changes and Session occurrences are both in launch scope.
  Chalk has no Room delete operation today; archival and restoration are the
  durable Room lifecycle transitions.

## Canonical language

A **Webhook Endpoint** is one tenant-owned receiver identity, its enabled state,
and its signing-secret versions. Each destination or subscription change
creates an immutable **Endpoint Revision** containing the encrypted URL, API
version, and selected Event types.

A **Webhook Event** is an immutable, API-versioned tenant-scoped fact created
from one authoritative database transition. Its ID, type, occurrence time, API
version, and JSON body never change after commit. If retained personal data
must be erased, Chalk destroys the body and cancels delivery rather than
rewriting the Event under the same ID.

A **Webhook Delivery** is the obligation to send one Event to one immutable
Endpoint Revision that was enabled and subscribed when the Event occurred.
Ordinary retries cannot drift to a later URL or subscription. Disabling or
deleting an Endpoint cancels its pending Deliveries and prevents new ones.

A **Delivery Attempt** is one signed HTTP request for a Delivery. Retries and
manual redeliveries create new Attempts while preserving the Event ID and body.

A **Webhook Processor** is the server-only SDK component that verifies exact
request bytes, decodes a supported Event version, coordinates a durable inbox,
and invokes the matching typed customer handler.

A **Webhook Inbox** is a customer-supplied durable lease and completion store
used to coordinate concurrent or repeated delivery of one Event ID. It reduces
duplicate handler execution but cannot atomically commit an arbitrary customer
side effect; handlers must still make downstream writes idempotent by Event ID.

An **Event producer** is the domain repository transaction that changes the
authoritative Room, Session, Participant, Recording, or Transcript state. A
producer never performs outbound HTTP.

## Version 1 event catalog and rollout

| Event type | Rollout | Emission boundary | `data.object.status` |
| --- | --- | --- | --- |
| `room.created` | Core launch | A reusable Room is committed for the first time. | `active` or `archived` |
| `room.updated` | Core launch | One or more public Room fields change without an archive-state transition. No-op writes emit nothing. | `active` or `archived` |
| `room.archived` | Core launch | A Room commits an `active` to `archived` transition. | `archived` |
| `room.restored` | Core launch | A Room commits an `archived` to `active` transition. | `active` |
| `session.started` | Core launch | A new Session occurrence commits in `active` state with `started_at`. | `active` |
| `session.ended` | Core launch | The Session's authoritative lifecycle transaction reaches `ended`, not merely `ending` or a requested provider shutdown. | `ended` |
| `participant.joined` | Core launch | The lifecycle intent is durably applied and the Participant becomes `active`. Admission requests, `joining`, and reconnects emit nothing. | `active` |
| `participant.left` | Core launch | The lifecycle intent is durably applied and the Participant becomes `left`. Disconnect and reconnect do not imply Leave. | `left` |
| `recording.started` | Artifact expansion | Capture has durably entered its active capture state. A request, reservation, or pending row is not sufficient. | `started` |
| `recording.completed` | Artifact expansion | The final Recording artifact is verified, committed, authorized, and fetchable. | `completed` |
| `recording.failed` | Artifact expansion | Recording reaches terminal failure after its retry budget; retryable failures emit nothing. | `failed` |
| `transcript.started` | Artifact expansion | Transcription work has durably begun against a committed Recording input. | `started` |
| `transcript.completed` | Artifact expansion | The normalized Transcript document is verified, committed, authorized, and fetchable. | `completed` |
| `transcript.failed` | Artifact expansion | Transcription reaches terminal failure after retry and fallback are exhausted. | `failed` |
| `endpoint.test` | Core launch, synthetic | An authorized caller requests a test for one Endpoint. It is synthetic and has no product resource. | n/a |

Endpoint create and patch reject reserved artifact types with
`409 webhook_event_type_unavailable` until the environment records the matching
artifact capability as enabled. There is no silent subscription, synthetic
artifact Event, or emission from CRUD status changes while a capability is
unavailable.

The webhook projection deliberately normalizes the detailed recorder companion
state machines to `started`, `completed`, and `failed`. Producers map
`capturing_segmented` to Recording started, `committed` to Recording completed,
and `terminal_failure` to Recording failed. They map active transcription work
to Transcript started, `complete` to Transcript completed, and
`terminal_failure` to Transcript failed. A producer enforces a unique semantic
transition key, so transaction retries or idempotent API retries cannot create
two Events for the same transition.

`room.updated` includes `data.changed_fields`, sorted lexicographically, with
names from `name`, `slug`, `media_plane`, and `recurring_policy`. `metadata` may
appear in `changed_fields` to tell the consumer that it changed, but its value
does not enter the payload. An archive or restore mutation emits only its
semantic Event, not an additional `room.updated` Event.

## Event body

Every request uses `Content-Type: application/json; charset=utf-8`. The stored
and signed body is immutable UTF-8 JSON with this envelope:

```json
{
  "id": "0de9d6b4-449b-4c50-abde-aac2ab7c36ca",
  "event": "participant.joined",
  "api_version": 1,
  "occurred_at": "2026-07-12T16:04:31.842Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {}
  }
}
```

The examples are pretty-printed for review. Wire bodies use the schema's fixed
field order, compact JSON with no insignificant whitespace or trailing newline,
UTF-8, and the shared API escaping rules. Producers serialize once inside the
authoritative transaction after final values are known, validate the 256 KiB
bound, store those exact bytes plus their SHA-256 hash, and deliver only the
stored bytes. Go and Elixir share golden byte fixtures for every Event type;
neither dispatcher nor redelivery parses and reserializes a body.

The launch webhook API version is the integer `1`, pinned on each immutable
Endpoint Revision. A sequential integer fits this contract better than a date:
Chalk already has the `/v1` transport boundary, there is one launch webhook
schema, and consumers need to compare or select a discrete schema generation
rather than infer compatibility from a calendar. Adding an optional field is
backward compatible and does not increment the version. Removing or renaming a
field, changing its meaning or JSON type, or changing an Event's emission
boundary increments the integer. At a transition, the producer creates one
Event for each distinct API version among matching Endpoints and fans it out to
Endpoints pinned to that version. Its semantic transition uniqueness key
includes the API version. An Event retains its version and exact body during
redelivery; changing an Endpoint's version affects only future Events.

All Endpoint, Endpoint Revision, Event, Delivery, and Attempt IDs are UUIDv4
strings, matching Chalk's existing public ID parser, PostgreSQL types, and SDK
schemas. Timestamps are truncated, never rounded, to UTC RFC 3339 millisecond
precision before the snapshot and `occurred_at` are serialized. Optional absent
facts are encoded as `null`, not omitted, in typed resource snapshots. Event
consumers must ignore unknown fields and unknown Event types, although Chalk
sends only types selected on the Endpoint. `endpoint.test` is synthetic and is
not a selectable subscription value.

### Room body

```json
{
  "id": "0de9d6b4-449b-4c50-abde-aac2ab7c36ca",
  "event": "room.updated",
  "api_version": 1,
  "occurred_at": "2026-07-12T16:04:31.842Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "id": "80675472-7ea3-40c9-b893-54965ba2f9fe",
      "name": "Weekly design review",
      "slug": "weekly-design-review",
      "status": "active",
      "media_plane": "cf_rtk",
      "created_at": "2026-07-01T08:00:00.000Z",
      "updated_at": "2026-07-12T16:04:31.842Z"
    },
    "changed_fields": ["name", "recurring_policy"]
  }
}
```

The snapshot omits `metadata`, `recurring_policy`, and creator identity. The
consumer can fetch the Room when its authorized integration needs those fields.

### Session body

```json
{
  "id": "7121c664-663f-48f1-92c7-d650a3a47756",
  "event": "session.ended",
  "api_version": 1,
  "occurred_at": "2026-07-12T17:05:08.291Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "id": "eb340a44-d02d-4627-a598-bf54459c6422",
      "room_id": "80675472-7ea3-40c9-b893-54965ba2f9fe",
      "status": "ended",
      "started_at": "2026-07-12T16:00:00.000Z",
      "ended_at": "2026-07-12T17:05:08.291Z",
      "created_at": "2026-07-12T15:59:58.914Z",
      "updated_at": "2026-07-12T17:05:08.291Z"
    }
  }
}
```

### Participant body

```json
{
  "id": "0de9d6b4-449b-4c50-abde-aac2ab7c36ca",
  "event": "participant.joined",
  "api_version": 1,
  "occurred_at": "2026-07-12T16:04:31.842Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "id": "aec90d63-2af8-440f-ac9a-187b756a5c26",
      "user_id": "7fd0d921-aab8-4a6e-9d31-6919dadbd9af",
      "room_id": "80675472-7ea3-40c9-b893-54965ba2f9fe",
      "session_id": "eb340a44-d02d-4627-a598-bf54459c6422",
      "name": "Ada",
      "status": "active",
      "joined_at": "2026-07-12T16:04:31.842Z",
      "left_at": null
    }
  }
}
```

A guest has `user_id: null`. `name` is the authorization-time display-name
snapshot and may be `null`. Capabilities and arbitrary Participant metadata are
excluded. A `participant.left` body has the same shape with `status: "left"`
and a non-null `left_at`.

### Recording body

```json
{
  "id": "b4fbf678-9aef-4ab8-9f61-fb96dff250ee",
  "event": "recording.completed",
  "api_version": 1,
  "occurred_at": "2026-07-12T18:12:40.105Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "id": "67059591-7df6-4e61-b879-73e0c7d05e8d",
      "room_id": "80675472-7ea3-40c9-b893-54965ba2f9fe",
      "session_id": "eb340a44-d02d-4627-a598-bf54459c6422",
      "status": "completed",
      "started_at": "2026-07-12T16:00:02.714Z",
      "completed_at": "2026-07-12T18:12:40.105Z",
      "failed_at": null,
      "failure": null,
      "created_at": "2026-07-12T15:59:50.000Z",
      "updated_at": "2026-07-12T18:12:40.105Z"
    }
  }
}
```

A failed body sets `failed_at` and includes a stable, customer-safe object such
as `{"code":"recording_processing_failed"}`. It never includes a raw worker,
provider, object-storage, or media error. A started body has null terminal
timestamps and failure. Storage provider, storage key, metadata, checksums, and
download URLs are excluded.

### Transcript body

```json
{
  "id": "cc9ad836-a8d1-477a-a9cd-81664db41cf3",
  "event": "transcript.completed",
  "api_version": 1,
  "occurred_at": "2026-07-12T18:19:16.603Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "id": "12d40717-991c-4344-a579-3ef02f2112f0",
      "recording_id": "67059591-7df6-4e61-b879-73e0c7d05e8d",
      "room_id": "80675472-7ea3-40c9-b893-54965ba2f9fe",
      "session_id": "eb340a44-d02d-4627-a598-bf54459c6422",
      "status": "completed",
      "languages": ["en"],
      "started_at": "2026-07-12T18:13:02.447Z",
      "completed_at": "2026-07-12T18:19:16.603Z",
      "failed_at": null,
      "failure": null,
      "created_at": "2026-07-12T18:12:58.000Z",
      "updated_at": "2026-07-12T18:19:16.603Z"
    }
  }
}
```

Transcript text, segments, model, provider, metadata, object key, and download
authority are excluded. A failed body uses a stable safe code such as
`transcription_failed`; a started body leaves terminal fields null.

### Test body

```json
{
  "id": "79b5ff1c-d54c-4bc4-96f7-b398650271ea",
  "event": "endpoint.test",
  "api_version": 1,
  "occurred_at": "2026-07-12T18:23:41.805Z",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "data": {
    "object": {
      "endpoint_id": "61165343-7a12-4114-b287-b84dc62ce35c"
    }
  }
}
```

## Signing and request contract

Chalk follows the Standard Webhooks HMAC-SHA256 scheme so consumers can use
existing verification libraries. Each attempt includes:

```http
POST /chalk-webhooks HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: Chalk-Webhooks/1.0
webhook-id: 0de9d6b4-449b-4c50-abde-aac2ab7c36ca
webhook-timestamp: 1783872271
webhook-signature: v1,BASE64_HMAC_SHA256
```

The signed bytes are exactly:

```text
<webhook-id>.<webhook-timestamp>.<raw HTTP body bytes>
```

Secrets contain 32 random bytes and are returned as `whsec_` plus base64. The
HMAC key is the decoded 32 bytes, not the printable prefixed form. Secrets are
encrypted at rest with the environment KMS key and are never logged or returned
after creation or rotation. Consumers verify against the raw request body,
compare signatures in constant time, reject attempt timestamps outside a
five-minute tolerance, and deduplicate the Event ID in durable storage before
applying side effects.

Secret rotation returns the new secret once. Chalk signs with both the previous
and current secret for 24 hours, placing two space-delimited `v1,...`
signatures in `webhook-signature`, then irreversibly removes the previous
secret. An emergency rotation can set `revoke_previous_immediately: true`.

## TypeScript receiver SDK

The TypeScript SDK exposes webhook receiver processing from the dedicated
`@q9labsai/chalk-client/webhooks` subpath. It is not exported from the package
root, `telemetry`, `effect`, React, or React Native entry points. The subpath is
built separately as runtime-neutral server/edge code over `Uint8Array`, Web
Crypto, and Web `Headers`; it imports no browser state and no Node-only crypto
primitive. Package `browser` and `react-native` conditions resolve to a small
module that throws `WebhookServerOnlyError`, so accidental client bundling fails
immediately and is caught by package-resolution tests. Applications remain
responsible for keeping Endpoint secrets in server-side environment storage;
the SDK cannot prevent application code from exposing a secret independently.

The checked-in version 1 webhook JSON schemas and signature vectors under
`contract/webhooks/v1/` are the source of truth for the Go/Elixir encoders and
generated TypeScript Event types and validators. SDK code does not hand-copy
the body union. The public surface is:

```ts
type ChalkWebhookEvent =
  | RoomWebhookEvent
  | SessionWebhookEvent
  | ParticipantWebhookEvent
  | RecordingWebhookEvent
  | TranscriptWebhookEvent
  | EndpointTestWebhookEvent
  | UnknownWebhookEvent;

function verifyWebhook(input: {
  rawBody: Uint8Array;
  headers: Headers | Record<string, string | string[] | undefined>;
  secrets: readonly string[];
  toleranceSeconds?: number;
  now?: () => Date;
}): Promise<ChalkWebhookEvent>;

interface WebhookInbox {
  acquire(input: {
    eventId: string;
    leaseMilliseconds: number;
  }): Promise<
    | { state: "acquired"; token: string }
    | { state: "completed" }
    | { state: "busy"; retryAfterSeconds: number }
  >;
  complete(input: { eventId: string; token: string }): Promise<void>;
  release(input: { eventId: string; token: string }): Promise<void>;
}

function createWebhookProcessor(options: {
  secrets: readonly string[] | (() => Promise<readonly string[]>);
  inbox: WebhookInbox;
  handlers: Partial<WebhookHandlerMap>;
  onUnknownEvent?: (event: UnknownWebhookEvent) => Promise<void> | void;
  onDiagnostic?: (event: WebhookDiagnosticEvent) => Promise<void> | void;
  toleranceSeconds?: number;
  leaseMilliseconds?: number;
}): WebhookProcessor;
```

`verifyWebhook` accepts raw bytes only; there is no overload for a parsed JSON
object or reserialized string. It case-insensitively reads the three Standard
Webhooks headers, validates their grammar and bounds, decodes all active
`whsec_` values, rejects timestamps outside the default five-minute tolerance,
checks every supplied signature in constant time, and only then parses JSON. It
validates `api_version`, the envelope, the typed `data` body, and equality
between `webhook-id` and body `id`. It returns an immutable discriminated union
on `event`. Rotation works by supplying both current and previous secrets; a
match against either is sufficient.

Verification failures use stable typed errors for missing headers, malformed
headers, invalid secret, stale timestamp, invalid signature, invalid JSON,
identifier mismatch, unsupported API version, and invalid Event body. Error
messages and diagnostic hooks never include the secret, signature, raw body,
Participant name, URL, or other payload content. `now` exists only for
deterministic testing and is marked unsafe outside tests.

The Processor executes this fixed order:

1. Verify the exact raw body and decode the versioned Event.
2. Ask the durable inbox to acquire a bounded lease for the Event ID.
3. A completed Event returns `200` without invoking the handler. A busy lease
   returns `503` plus bounded `Retry-After` so Chalk retries later.
4. An acquired known Event invokes its typed handler. Success durably marks the
   inbox completed before returning `200`; failure releases the lease and
   returns or throws a typed `500` result so Chalk retries.
5. An authenticated unknown Event defaults to an acknowledged `200` with an
   `ignored` result, as forward-compatible consumers must ignore unknown Event
   names. A supplied `onUnknownEvent` may observe it without turning it into a
   typed known body.

The Processor returns a framework-neutral `WebhookProcessResult` containing the
safe HTTP status, optional `Retry-After`, outcome, Event ID, Event name, and API
version. A `toWebhookResponse(result)` helper produces a Web `Response` without
echoing content. Thin documented recipes cover an unconsumed Web `Request`,
Node HTTP, Express raw-body middleware, Next.js route handlers, and Hono. Chalk
does not add those frameworks as dependencies and does not accept their parsed
body abstractions.

The SDK ships no in-memory inbox in the production entry point and no default
database dependency. Documentation includes reference PostgreSQL and Redis
implementations that demonstrate an atomic acquire, lease expiry, completion,
and release contract. A test-only `@q9labsai/chalk-client/webhooks/test` subpath
may provide a deterministic signer, fixture loader, and in-memory inbox with
names that make their non-production status explicit.

The inbox prevents concurrent duplicate handlers and remembers completed Event
IDs for at least the 30-day Chalk redelivery window, but it cannot make an
arbitrary customer side effect exactly once. A process can crash after the side
effect and before `complete`; the retry will invoke the handler again after
lease expiry. Every handler therefore receives `event.id` as its downstream
idempotency key and the documentation requires it to transact that key with its
own writes or pass it to a downstream API that supports idempotency.

`onDiagnostic` is local and opt-in. It reports only bounded phases, outcome,
duration, Event name, API version, and opaque IDs; it never exports by itself.
The public SDK does not phone home or extend Chalk's internal journey beyond the
customer HTTP response boundary.

## Endpoint and egress safety

Launch Endpoints must use HTTPS with a publicly trusted certificate and port
443. Userinfo, fragments, IP-literal hosts, wildcard hosts, and URLs containing
credentials are rejected. Query strings are allowed because some receivers use
opaque routing tokens, but Chalk redacts them from logs, metrics, traces, audit
details, and list responses.

The dispatcher resolves DNS for every attempt and rejects loopback, link-local,
private, carrier-grade NAT, multicast, documentation, benchmark, reserved, and
cloud-instance metadata ranges for every resolved IPv4 or IPv6 address. It
connects only to an address that passed validation, revalidates after DNS
changes, does not follow redirects, verifies hostname and certificate, and
blocks proxy environment variables. This policy applies equally in local,
staging, and production; local receiver testing uses a public HTTPS tunnel
owned by the developer, not a localhost exception in the service.

The client has a three-second connect timeout and ten-second total timeout.
Request bodies are capped at 256 KiB; a producer that would exceed the cap
fails its transaction rather than committing an undeliverable Event. Responses
are read up to 64 KiB and then closed. Only a `2xx` response is success. Chalk
does not follow `3xx`; bounded `Retry-After` on `429` or `503` may delay the next
attempt but cannot extend the 72-hour retry horizon.

## Delivery behavior

The first Attempt is eligible immediately after the producing transaction
commits. A Delivery gets at most 11 automatic Attempts at offsets of 0, 30
seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, 24 hours,
48 hours, and 72 hours from Event occurrence. Attempts 2–11 use equal jitter in
the final 10 percent of their offset window and stay at least 15 seconds apart.
A valid `Retry-After` on `429` or `503` can move eligibility later, capped at 24
hours from the prior Attempt and never beyond the 72-hour final window. A failed
11th Attempt, or inability to start it before 72 hours plus the ten-second
request timeout, exhausts the Delivery. Service recovery only claims work whose
stored `next_attempt_at` is already eligible; it never bypasses spacing.

Each Endpoint has a concurrency ceiling of four and each tenant has a ceiling
of 20, while the global worker pool uses fair claiming so one failing tenant or
Endpoint cannot starve another. An Endpoint failure does not block deliveries
to another Endpoint and does not block the product transaction that created the
Event. Future Events continue after one Delivery exhausts its retries; Chalk
does not silently disable an Endpoint based only on receiver failures.

The Delivery state machine is:

```text
pending -> delivering -> succeeded
                     -> retry_wait -> delivering
                     -> exhausted
pending | retry_wait -> canceled
exhausted | succeeded -> manual redelivery creates a new pending Delivery
```

Leases fence concurrent workers. A worker claims a bounded batch in a short
transaction using `FOR UPDATE SKIP LOCKED`, commits the lease, performs network
I/O outside the transaction, and conditionally records the result against the
lease token. Lease expiry makes a crashed Attempt retryable. A response may be
lost after the receiver applied the Event but before Chalk records success;
this is the core reason consumers must deduplicate.

Chalk stores Attempt start/end time, latency, outcome, HTTP status, and a stable
bounded error code. It discards receiver response headers and bodies at launch,
along with DNS answers and raw TLS errors. Delivery inspection cannot safely
retain arbitrary receiver text because a receiver may echo personal data or a
credential that Chalk cannot later discover for subject erasure.

## Public management API

All routes use the existing endpoint-contract pattern, tenant authorization,
cursor pagination, stable API errors, OpenAPI generation, and generated Effect
TypeScript SDK. Add explicit `webhooks:read`, `webhooks:write`, and
`webhooks:delete` API-key scopes. Tenant users need at least Admin role because
Endpoint URLs and signing secrets can move tenant data outside Chalk.

| Method and path | Behavior |
| --- | --- |
| `POST /v1/tenants/{tenant_id}/webhook-endpoints` | Create an Endpoint and return its secret once. Requires `Idempotency-Key`. |
| `GET /v1/tenants/{tenant_id}/webhook-endpoints` | List redacted Endpoints. |
| `GET /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}` | Read one redacted Endpoint. |
| `PATCH /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}` | Change name, URL, enabled state, API version, or subscribed Event types. Requires `If-Match` and `Idempotency-Key`. |
| `DELETE /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}` | Soft-delete the Endpoint, revoke secrets, and cancel pending Deliveries. Requires `If-Match` and `Idempotency-Key`. |
| `POST /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/rotate-secret` | Return a new secret once and begin rotation overlap. Requires `Idempotency-Key`. |
| `POST /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/test` | Create an `endpoint.test` Delivery. Requires `Idempotency-Key`. |
| `GET /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries` | List Deliveries, filterable by state and Event type. |
| `GET /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}` | Read the Event body and bounded Attempt history. Secrets remain redacted. |
| `POST /v1/tenants/{tenant_id}/webhook-endpoints/{endpoint_id}/deliveries/{delivery_id}/redeliver` | Create a new Delivery for the stored Event body. Requires `Idempotency-Key`. |

Create request and response:

```json
{
  "name": "CRM production",
  "url": "https://hooks.example.com/chalk",
  "enabled": true,
  "api_version": 1,
  "event_types": [
    "session.started",
    "session.ended",
    "participant.joined",
    "participant.left"
  ]
}
```

```json
{
  "id": "61165343-7a12-4114-b287-b84dc62ce35c",
  "tenant_id": "8ab93efb-8dbd-4f4f-a823-bb77e8bcfcb4",
  "name": "CRM production",
  "url_redacted": "https://hooks.example.com/chalk",
  "enabled": true,
  "revision": 1,
  "api_version": 1,
  "event_types": ["participant.joined", "participant.left", "session.ended", "session.started"],
  "secret": "whsec_BASE64_SECRET_RETURNED_ONCE",
  "created_at": "2026-07-12T18:30:00.000Z",
  "updated_at": "2026-07-12T18:30:00.000Z"
}
```

List and get use the same Endpoint shape without `secret`. `url_redacted`
replaces any query with `?REDACTED`; the unredacted encrypted URL is never
readable through the API after creation. Event type arrays are unique, sorted,
non-empty, limited to the catalog for the selected API version, and currently
available in the environment. Core launch rejects reserved artifact types. Launch
allows ten active or disabled Endpoints per tenant. Endpoint names are 1–100
trimmed Unicode characters; URLs are at most 2,048 bytes.

PATCH accepts any non-empty subset of `name`, `url`, `enabled`, `api_version`,
and `event_types`. Omitted fields remain unchanged and JSON `null` is invalid
for every field. The caller sends the last observed integer revision as
`If-Match: "1"`; success increments `revision` and returns the Endpoint shape
without a secret. A mismatch returns `412 webhook_endpoint_revision_conflict`.
This prevents two Admins from silently overwriting destination or subscription
changes. DELETE uses the same `If-Match` rule so a stale client cannot delete an
Endpoint after an unseen configuration change.

Endpoint lists return:

```json
{
  "webhook_endpoints": [],
  "page": {"next_cursor": null}
}
```

They order by `(created_at, id)` descending and accept `page_size` from 1–100,
default 20, plus the opaque `cursor`. Deleted Endpoints are excluded. Delivery
lists order by `(created_at, id)` descending, use the same page contract, and
accept repeatable `state` and `event_type` filters restricted to documented
values. Each list item is:

```json
{
  "id": "5fca53ac-e3bc-4c83-a73b-33b590f83614",
  "event_id": "0de9d6b4-449b-4c50-abde-aac2ab7c36ca",
  "event_type": "participant.joined",
  "endpoint_id": "61165343-7a12-4114-b287-b84dc62ce35c",
  "endpoint_revision": 1,
  "state": "succeeded",
  "attempt_count": 1,
  "next_attempt_at": null,
  "terminal_at": "2026-07-12T16:04:32.103Z",
  "created_at": "2026-07-12T16:04:31.842Z",
  "updated_at": "2026-07-12T16:04:32.103Z"
}
```

Delivery detail adds `event`, containing the exact parsed Event body shown in
this spec, and an `attempts` array ordered by attempt number. Attempt items
contain UUID `id`, integer `number`, `started_at`, `finished_at`,
`latency_milliseconds`, `outcome`, nullable `http_status`, and nullable stable
`error_code`; no receiver body or headers are returned. If the Event body was
erased, detail returns `410 webhook_event_erased` and never substitutes a
tombstone body under the original Event ID.

Test and manual-redelivery success return `201` with:

```json
{
  "event_id": "79b5ff1c-d54c-4bc4-96f7-b398650271ea",
  "delivery_id": "5fca53ac-e3bc-4c83-a73b-33b590f83614",
  "endpoint_id": "61165343-7a12-4114-b287-b84dc62ce35c",
  "endpoint_revision": 1,
  "state": "pending"
}
```

`endpoint.test` bypasses Event subscription selection but requires an enabled,
non-deleted Endpoint and uses normal Event, Delivery, Attempt, signature, retry,
inspection, and retention behavior. Manual redelivery requires a retained and
readable Event, an enabled non-deleted current Endpoint Revision, and an
original Delivery in `succeeded` or `exhausted`. The current revision must still
select that Event type and API version; otherwise the request returns
`409 webhook_delivery_not_redeliverable`. One idempotency key can create only
one child Delivery. A successful request preserves the Event ID and exact body
but returns the current target revision explicitly.

Secret rotation accepts
`{"revoke_previous_immediately":false}` and returns `200` with Endpoint ID,
current revision, the new one-time `secret`, and nullable
`previous_secret_expires_at`. Delete returns `204` with no body. Create returns
`201`; get, list, patch, rotate, and delivery detail return `200`; test and
redelivery return `201`.

Stable errors include `invalid_webhook_endpoint_id`, `invalid_webhook_url`,
`unsafe_webhook_url`, `invalid_webhook_event_type`,
`webhook_event_type_unavailable`,
`invalid_webhook_api_version`, `webhook_endpoint_limit_reached`,
`webhook_endpoint_not_found`, `webhook_delivery_not_found`,
`webhook_delivery_not_redeliverable`, `webhook_event_erased`,
`webhook_endpoint_revision_conflict`, `idempotency_key_required`,
`idempotency_key_conflict`, `idempotency_key_expired`, `forbidden`,
`rate_limited`, and `service_unavailable`. Invalid inputs are `400`, missing
resources are `404`, authorization failures are `401` or `403`, revision
conflicts are `412`, erased retained Events are `410`, redelivery state
conflicts are `409`, rate limits are `429`, and unavailable dependencies are
`503`.

An idempotent replay of Endpoint creation or secret rotation returns the exact
original response, including the secret, for the 24-hour idempotency-record
window. Chalk encrypts that cached response and deletes it when the window
expires. This is the sole exception to secret one-time visibility and prevents
a lost HTTP response from permanently losing the only usable secret. A replay
after expiry returns `idempotency_key_expired`; the caller must fetch the
Endpoint and rotate its secret.

## Persistence and source-of-truth rules

PostgreSQL adds six tenant-scoped durable records:

- `webhook_tenant_state` has one row per enabled tenant and is the serialization
  lock for Event fanout and Endpoint mutation.
- `webhook_endpoints` owns the receiver identity, name, enabled/deleted state,
  current revision number, encrypted current and previous secret versions,
  rotation expiry, creator, and timestamps.
- `webhook_endpoint_revisions` owns an immutable revision number, encrypted URL,
  redacted display URL, API version, selected Event types, and creation time.
- `webhook_events` owns the immutable Event ID, tenant, Event name, API version,
  occurrence time, exact serialized body bytes, SHA-256 body hash,
  bounded semantic transition key, resource type and ID, optional linked User
  ID for erasure, `journey_id`, parent journey Event ID, producing trace/span
  reference, body-erasure state, and creation time. The signed body is
  stored in bounded `bytea`, covered by the database's encryption at rest, and
  never reconstructed from JSONB; searchable projections live in their own
  typed columns.
- `webhook_deliveries` owns the Event-to-Endpoint-Revision obligation, state,
  next attempt time, attempt count, lease token/owner/expiry, terminal time,
  journey branch Event IDs, manual redelivery ancestry, and timestamps.
- `webhook_delivery_attempts` owns the bounded diagnostic result for each
  network attempt plus its linked trace and span IDs.

Every table has a unique `(tenant_id, id)` key. Composite foreign keys enforce
tenant identity from Endpoint Revision to Endpoint, Delivery to Endpoint
Revision and Event, Attempt to Delivery, and a manual redelivery to its parent.
Every claim, cleanup, inspection, cancellation, and redelivery query predicates
on `tenant_id`; HTTP authorization is not the only isolation boundary.

Every authoritative producer uses one PostgreSQL transaction to mutate the
resource, insert one immutable Event with its final payload per distinct
subscribed API version, and insert a Delivery for every currently enabled
matching Endpoint. The transaction uses a unique semantic transition and API
version key to collapse retries. It commits all three effects or none; there is
no database-to-external-queue dual write and no post-commit best-effort Event
creation.

Before reading the matching subscription set, every producer locks the
tenant's `webhook_tenant_state` row. Endpoint create, enable, disable, delete,
URL/API-version/subscription patch, and revision creation lock the same row, so
each change is unambiguously before or after fanout under PostgreSQL `READ
COMMITTED`. Producers acquire their domain locks first and the webhook tenant
lock last; Endpoint operations never acquire Room, Session, Participant,
Recording, or Transcript locks. Tests enforce this lock order and the launch
load gate must show that short tenant-level serialization does not violate
Participant admission or Session-end latency.

The first Endpoint-create transaction inserts `webhook_tenant_state` if absent
and then locks it; tenant creation may provision the row eagerly as an
optimization. Concurrent first creates use the tenant-key uniqueness constraint
and retry the lock acquisition without creating two state rows.

The matching subscription and destination revision are captured at occurrence
time. Enabling a new Endpoint does not backfill older Events. Disabling or
deleting an Endpoint synchronously cancels pending or retry-wait Deliveries.
A URL, API-version, or subscription patch creates a new Endpoint Revision and
cancels pending work for the old revision; it cannot redirect retained tenant
data to a new receiver. Name-only changes do not create a revision. Secret
rotation may sign pending work with current plus eligible previous keys because
it changes authentication, not the destination. Manual redelivery is the only
path for a retained older Event and always targets the current enabled Endpoint
Revision, which the response identifies.

`session.started` is produced by the API Session-creation transaction.
`participant.joined`, `participant.left`, and `session.ended` are inserted by
the Sync PostgreSQL transaction that applies the lifecycle intent, updates the
product and control state, and marks the intent applied. The API transaction
that creates a `joining` Participant or pending intent emits nothing because
Sync may later reject or supersede it. This boundary requires coordinated API
and Sync migrations, shared payload fixtures, and both language-specific gates.

Sync is in scope only for that atomic production boundary and journey
continuation. It does not manage Endpoints, read signing secrets, sign payloads,
claim Deliveries, retry HTTP, resolve DNS, or contact customer receivers. Moving
join, leave, or Session-end Event creation back to the API would announce a
requested transition before Chalk's actual durable authority accepted it;
moving it to a later polling worker would lose the same-transaction guarantee.

Room, Recording, and Transcript repositories gain transaction-aware transition
methods; generic partial updates cannot bypass Event creation. The
implementation must replace the current free-form Recording and Transcript
transition behavior with guarded semantic state transitions before artifact
Events are enabled. The Recording completed transaction writes every final
private-object and authorization fact needed for
`GET /v1/tenants/{tenant_id}/recordings/{recording_id}` and
`POST /v1/tenants/{tenant_id}/recordings/{recording_id}/download-url` to succeed
immediately after commit. The Transcript completed transaction writes the
normalized authorized document facts needed for
`GET /v1/tenants/{tenant_id}/transcripts/{transcript_id}` to return `200`
immediately after commit. Started, completed, failed, and safe failure timestamps
or codes in webhook snapshots must be columns or deterministic projections
owned by those guarded transitions; a webhook serializer never infers them
from logs or worker state.

The Sync control Event stream is not the webhook outbox. It has bounded
Session-history and projection semantics, omits Room and artifact lifecycles,
and contains high-frequency control Events that are not in this catalog. Audit
logs remain operator/customer audit history and are not a delivery queue.

## Retention, deletion, and recovery

Events, Deliveries, and Attempts are retained for 30 days after Event
occurrence. Manual redelivery is allowed during that window. A daily bounded
cleanup job deletes expired Attempt rows, then Deliveries, then Events when no
retained Delivery refers to them. Endpoint deletion immediately revokes its
secret and cancels work, but retains its redacted configuration and delivery
history until the same 30-day window expires so an Admin can investigate.

Tenant deletion removes all Endpoint, Event, Delivery, Attempt, encrypted URL,
and secret material inside the tenant-deletion SLA. User deletion
pseudonymizes creator references. Because Participant names are present in
retained Events, Events are indexed by their optional User linkage for erasure.
The existing user-deletion job must physically delete matching signed body
bytes within 24 hours, mark each Event `erased`, retain only its body hash and
content-free facts, cancel pending Deliveries, and reject future automatic or
manual delivery. It never substitutes new signed bytes under an existing Event
ID. Restore reconciliation reapplies the erasure tombstone before delivery
claims can resume. Prior content-free Attempt audit remains available until
normal expiry.

PostgreSQL backup and PITR policy covers this state, but restore reconciliation
must never reactivate revoked secrets, deleted Endpoints, canceled Deliveries,
or already-expired work. The dispatcher can lose a claim and retry; it cannot
lose a committed Event. A database outage stops new authoritative mutations and
delivery claims safely. Existing meetings continue according to their own
control-plane contract; webhook health never becomes a live media dependency.

## Observability and operations

Webhook work participates in Chalk's existing journey model rather than forming
a disconnected queue dashboard. `journey_id` remains separate from trace ID so
one product transition can fan out into several Endpoint branches and each
retry can have a fresh linked trace. The internal journey identifiers and trace
context never enter the customer webhook body or headers.

Room and Session API operations propagate or create a journey at the first
observed boundary. Participant and Session-end requests persist that
`journey_id` and parent journey Event on the durable lifecycle intent so the
later Sync apply transaction can continue the same causal graph. Recording and
Transcript jobs must likewise retain their originating journey before their
reserved Events can be enabled. If a reconciler discovers work without a
provable origin, it creates a background-worker root with
`upstream.visibility=unknown`; it never invents earlier history.

The producing transaction stores `journey_id`, the parent journey Event ID, and
the producing trace/span reference on the Webhook Event. In the same
transaction it appends `webhook.event.committed` and one
`webhook.delivery.queued` journey branch per Delivery to
`observability_journey_events`. Every dispatcher Attempt starts a new
OpenTelemetry trace with a span link to the producing span and records the same
journey ID. The durable skeleton then records, as applicable:

```text
webhook.event.committed
  -> webhook.delivery.queued
  -> webhook.delivery.attempt_started
  -> webhook.delivery.attempt_succeeded
     | webhook.delivery.retry_scheduled -> attempt_started
     | webhook.delivery.exhausted
     | webhook.delivery.cancelled
     | webhook.delivery.erased
```

Every Delivery branch terminates as `succeeded`, `exhausted`, `cancelled`, or
`erased` within its retry and retention rules. A missing terminal branch after
the 72-hour delivery window plus a five-minute reconciliation allowance is a
stuck journey and pages the webhook owner. Test and manual-redelivery API calls
are their own operation roots and link to the original Event journey rather
than rewriting its history.

Metrics cover committed Events by Event name and API version, fanout count,
pending and leased Deliveries, oldest eligible age, event-to-first-attempt
latency, attempt outcome and HTTP status class, request latency, retry,
exhaustion, cancellation and erasure counts, lease expiry, Endpoint and tenant
fairness throttles, SSRF rejections by bounded class, signing/KMS failures,
cleanup lag, journey-branch age, and redelivery results. The internal service
objective is that an eligible Delivery begins its first Attempt within 60
seconds at p99 under the qualified launch load; receiver availability and final
`2xx` success are customer dependency outcomes, not Chalk availability SLOs.
Labels contain Event name, API version, state, status class, and bounded error
class, never tenant IDs, Endpoint IDs, hosts, paths, query strings, payload
fields, names, response bodies, or secrets.

Structured logs and traces use opaque Event, Delivery, and Attempt IDs with
redacted error classes and the internal journey correlation fields. Attempt
spans cover claim wait, DNS validation, connection, TLS, request write, response
wait, conditional result commit, and retry scheduling without recording URL or
payload content. Audit logs record Endpoint create/update/disable/delete,
secret rotation, test, and manual redelivery with actor and outcome. They never
record the URL query, secret, raw payload, Participant name, Transcript text,
or receiver response.

Readiness distinguishes the management API, event persistence, and dispatcher.
A dispatcher backlog or external receiver outage alerts independently and does
not make the public API or Sync process unready. Alerts cover oldest eligible
Delivery beyond five minutes, a first-attempt p99 breach, exhausted-rate
changes, lease churn, missing journey terminal branches, cleanup outside its
daily bound, and a canary Endpoint missing its signed test Event. The canary
must prove Event commit, Delivery claim, signature verification, receiver
`2xx`, Attempt commit, complete journey skeleton, trace linkage, metric
exemplar, and Grafana searchability from the originating journey ID.

## Artifact dependency and current implementation state

Recording processing is not implemented in the current repository. The API has
tenant-scoped Recording CRUD, the four coarse statuses `pending`, `processing`,
`completed`, and `failed`, mutable storage metadata, and an R2 download-URL path
for a row already marked completed. It has no capture worker, renderer, leased
artifact jobs, guarded recorder state machine, speaker-turn manifest, retry or
dead-letter execution, or reconciliation described by the recorder pipeline
spec. The current generic create and PATCH routes can assert statuses; they do
not prove that media was captured, rendered, verified, or committed.

Transcription is partial. The API can synchronously read a completed Recording
object, call the OpenRouter transcription adapter inside the HTTP request, and
insert a completed Transcript whose text remains in PostgreSQL. That path is
useful scaffolding and has route, service, adapter, repository, tests, and an
Execution Trace Harness scenario, but it is not the production design. It lacks
the speaker-turn chunk pipeline, PostgreSQL leased jobs, DeepInfra primary and
Cloudflare fallback adapters, fenced single-result commit, retry/dead-letter
and reconciliation, R2 normalized document authority, deletion proof, and the
production conformance gates.

The webhook executor does not own building either artifact pipeline; those are
separate projects governed by
`scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md` and
`scratchpad/chalk-transcription-spec-2026-07-12.md`. This spec owns their Event
contracts and integration hooks. An environment may enable the Recording or
Transcript webhook capability only after the matching companion checklist,
language gates, staging load/failure tests, public fetchability proof, and
end-to-end artifact canary pass. The current CRUD status fields and synchronous
OpenRouter route are never accepted as that proof.

## Implementation checklist

- [ ] **Phase 1 — Contract and durable core.** Add the versioned Event schemas, webhook scopes,
   endpoint contracts, migrations, SQL queries, domain service, encrypted
   secrets/URLs, semantic transition keys, and PostgreSQL leased delivery
   state. Wire Room and Session creation in the API transactions, and wire
   Participant and Session-end production into the Sync transaction that
   applies lifecycle intents. Keep API and Sync migration compatibility.
- [ ] **Phase 2 — Dispatcher and customer operations.** Add SSRF-safe delivery, Standard
   Webhooks signing, retries, lease recovery, delivery inspection, tests,
   secret rotation, manual redelivery, cleanup, complete journey skeletons,
   linked traces, metrics, audit logs, canary coverage, and the Execution Trace
   Harness scenario.
- [ ] **Phase 3 — Generated clients and core documentation.** Regenerate OpenAPI, Effect schemas,
   generated `HttpApi`, and TypeScript client artifacts. Generate the version 1
   receiver Event union and validators, add the server-only `./webhooks` and
   `./webhooks/test` subpaths, implement verification, typed processing, inbox
   coordination, safe responses and diagnostics, and publish raw-body recipes
   for supported server runtimes. Document artifact Event types as reserved and
   unavailable. Demo apps remain thin and do not own delivery behavior.
- [ ] **External prerequisite — Production artifact pipelines.** Complete and independently
   verify the recorder and transcription companion specs. This checkbox belongs
   to those projects and does not block the core webhook launch.
- [ ] **Phase 4 — Artifact Event expansion.** After the external prerequisite is checked,
   wire guarded Recording and Transcript started/completed/failed transitions,
   enable their subscription capabilities, regenerate contracts and docs, and
   pass artifact-to-receiver journey canaries. Never emit from the current
   generic PATCH or synchronous prototype path.

## Execution orchestration

The top-level integrator owns the schema, lock order, Event encoder fixtures,
journey vocabulary, capability gate, and final end-to-end proof because those
interfaces cross every lane. After that boundary is fixed, implementation
splits without overlapping file ownership:

- an API/dispatcher implementation agent owns Endpoint management, public
  contracts, authorization, Postgres adapters, code generation inputs, claims,
  signing, SSRF-safe HTTP, retries, cleanup, delivery metrics/traces, canary
  receiver support, and Go tests; these concerns share the webhook domain and
  stay in one lane to avoid file and transaction-boundary collisions;
- a Sync implementation agent owns lifecycle-intent journey propagation and atomic
  `participant.joined`, `participant.left`, and `session.ended` Event production
  in `apps/sync`, against the already-fixed migration and byte fixtures;
- an SDK/documentation implementation agent starts after the shared body schemas and signature
  vectors land; it owns generated Event types, the isolated receiver subpaths,
  inbox and processor contracts, build-condition safety, framework recipes,
  generated management clients, and public documentation;
- an advisor performs one security and failure-semantics critique after API,
  dispatcher, and Sync integration, before the parent runs the integrated gates.

All three implementation lanes use the general-purpose agent role with
`gpt-5.6-sol` and `high` reasoning, explicitly configured on every spawn with
`service_tier="standard"` and `fork_turns="none"`. The typed worker role is not
used because it is fixed to a different model. The critique uses the advisor
role with `gpt-5.6-sol` at `high`, also explicitly configured with
`service_tier="standard"`; it advises only and never edits or executes
implementation work.
Workers do not spawn agents, run `codex review`, commit, or cross their assigned
file boundaries. Follow-up fixes return to the agent that already owns the lane.

API management, dispatcher internals, Sync integration, and receiver SDK work
may proceed in parallel only after the shared schemas, migration, and signature
fixtures exist. Generated management clients wait for actual routes. Artifact
Event integration waits for the independently verified artifact pipelines
rather than coding against predicted outputs. The top-level integrator resolves
seam failures, runs the Execution Trace Harness, performs browser/API receiver
proof, and alone runs the bounded final code review required by the repository
protocol.

## Verification gates

Focused automated tests must prove:

- every enabled Event is emitted once at its exact semantic boundary and no-op,
  retryable, reconnect, or excluded Sync activity emits it; reserved artifact
  types reject subscription and emit nothing before their capability gate;
- resource mutation, Event insert, and Delivery fanout commit or roll back
  together under injected failures and concurrent Endpoint changes;
- the stored raw body matches the documented schemas and signature test vectors
  byte for byte, including Unicode names and dual-secret rotation;
- duplicate worker claims, lease expiry, response-loss injection, API process
  restart, and database failover produce at-least-once behavior without losing
  or corrupting Events;
- retry horizon, `Retry-After` bounds, per-Endpoint and per-tenant concurrency,
  and fair claiming hold under a failing-endpoint load test;
- DNS rebinding, IPv4/IPv6 private and metadata targets, redirects, proxy
  variables, invalid TLS, slow reads, oversized responses, and URL-log leakage
  are blocked;
- disabling/deleting an Endpoint, changing subscriptions, rotating/revoking a
  secret, retention cleanup, user erasure, and restored backups cannot revive
  unauthorized work or credentials;
- every management route enforces tenant isolation, Admin role or webhook API
  scopes, idempotency, pagination, rate limits, stable errors, and secret
  one-time visibility;
- generated OpenAPI and SDK artifacts contain every route and exact body type,
  with no contract drift;
- official producer vectors pass through SDK raw-byte verification for current
  and rotation-overlap secrets, while mutated bytes, parsed/reserialized bodies,
  stale timestamps, malformed headers, invalid signatures, mismatched IDs,
  unsupported versions, and invalid typed bodies fail with the documented safe
  errors;
- Processor tests prove typed handler narrowing, completed duplicate
  acknowledgement, busy-lease retry, handler-failure release, crash-and-lease
  recovery, unknown-Event acknowledgement, 30-day inbox retention, and the
  unavoidable duplicate window between customer side effect and inbox
  completion;
- package and bundle tests prove `./webhooks` is absent from the root bundle,
  browser and React Native resolution fail with `WebhookServerOnlyError`, no
  framework becomes a dependency, and no secret, signature, body, name, or URL
  reaches errors or diagnostic callbacks;
- Node HTTP, Web `Request`, Express raw-body, Next.js, and Hono recipes each pass
  an end-to-end signed fixture without accepting a pre-parsed body;
- every Event-to-Delivery fanout appears as a complete journey graph with
  linked attempt traces, bounded metric labels, terminal branches, stuck-branch
  detection, and successful Grafana lookup from the originating journey ID.

The language-focused gates are `apps/api/scripts/gate.sh` and
`apps/sync/scripts/gate.sh`; the repository gate is `pnpm run gate`. The change
is not done until a localhost end-to-end harness
creates an Endpoint against an HTTPS test receiver, triggers each enabled Event family,
verifies the signature from raw bytes, forces retries and restart recovery,
inspects and redelivers a Delivery through the public API, and observes one
deduplicated consumer side effect per Event. The Execution Trace Harness must
show the producing transaction, Event and Delivery rows, claim, signature
metadata without the secret, Attempt result, retry, and terminal outcome.

## Definition of done and stopping boundary

Core webhook launch is done when Phases 1–3 are checked and the following
observable statements are true in the integrated staging-like local
environment:

- a tenant Admin can create, read, list, patch, disable, delete, test, and rotate
  an Endpoint, inspect its Deliveries, and manually redeliver a retained Event
  through documented `/v1` routes and the generated TypeScript SDK;
- a conforming HTTPS receiver can verify the documented raw-body signature,
  process it through `@q9labsai/chalk-client/webhooks`, observe one idempotent
  customer side effect after Chalk deliberately sends duplicate Attempts, and
  fetch the current Chalk resource by the IDs in each body;
- every core-launch Event reaches that receiver from its documented
  authoritative transition, every reserved artifact subscription is rejected,
  and every explicitly excluded transient action produces no webhook Event;
- injected receiver failure, dispatcher restart, lease expiry, database
  transaction rollback, DNS rebinding, secret rotation, Endpoint deletion,
  retention expiry, and user erasure produce the states and safety outcomes
  specified here;
- `apps/api/scripts/gate.sh`, `apps/sync/scripts/gate.sh`, and `pnpm run gate`
  pass, generated contract drift is zero, the Execution Trace Harness captures
  the full path, and the changelog and public receiver documentation describe
  the shipped contract.

Artifact Event expansion is separately done when the external artifact-pipeline
prerequisite and Phase 4 are checked, every reserved type becomes selectable,
each guarded artifact transition reaches the receiver, the REST artifact is
fetchable at completion, and its complete cross-worker journey and failure
canaries pass. Core webhook launch does not wait for this boundary.

Work stops at that boundary. A dashboard, ephemeral in-call Events, custom
headers, private-network delivery, ordered delivery, an external broker,
additional SDK languages, Event versions after `1`, and implementation of the
recorder or production transcription pipelines remain outside core launch scope.
Production deployment and production receiver tests require explicit approval
in the active thread and are not implied by implementing this spec.

## Non-goals and anti-slop rules

- No exactly-once or ordered-delivery claim.
- No outbound HTTP inside a product transaction or request handler.
- No external broker until measured PostgreSQL dispatcher load or isolation
  proves the existing leased-job pattern insufficient.
- No reuse of Sync Events, audit logs, telemetry events, or provider callbacks
  as the customer webhook source of truth.
- No wildcard Event subscription at launch; callers select explicit catalog
  values so new Event types cannot silently begin exporting tenant data.
- No arbitrary customer headers, unsigned mode, disabled TLS verification,
  private-network destination, redirect following, or production localhost
  exception.
- No Transcript text, media, arbitrary metadata, storage path, download URL,
  raw failure, credential, or provider payload in an Event or operational log.
- No artifact Event before its companion durable state machine and committed
  artifact boundary exist.
- No app-only implementation. The API domain and generated SDK contract own the
  feature; apps consume it.
- No receiver helper in the browser-facing root export, React, or React Native;
  signing secrets and webhook processing are server/edge concerns.
- No parsed-body verification API, automatic telemetry export, framework
  dependency, production in-memory inbox, or SDK claim of exactly-once customer
  side effects.

## References

- Standard Webhooks payload, signature, header, and rotation conventions:
  https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
- Stripe's at-least-once retry, duplicate handling, asynchronous processing,
  and unordered-delivery guidance:
  https://docs.stripe.com/webhooks
- GitHub's HTTPS, subscription minimization, signature, delivery-ID, bounded
  response-time, and asynchronous receiver guidance:
  https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
- Chalk SDK ubiquitous language: `sdks/ubiquitous-language.md`
- Chalk API route workflow: `apps/api/docs/route-workflow.md`
- Chalk recorder and artifact pipeline:
  `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`
- Chalk transcription pipeline:
  `scratchpad/chalk-transcription-spec-2026-07-12.md`
