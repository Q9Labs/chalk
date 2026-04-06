# Cloudflare Worker Post-Meeting Transcription Spec

Date: 2026-04-05
Status: revised implementation spec
Owner: Chalk API / Post-Meeting

## Goal

Keep Cloudflare as the post-meeting transcription provider while eliminating the API-instance OOM failure mode.

The fix target is not "change providers".
The fix target is "move the byte-heavy Cloudflare transcription path out of the Go API process".

## Problem

Current flow:

1. Recording completes.
2. Chalk API stores the recording in R2.
3. Chalk API auto-queues transcription for internal tenants.
4. The API transcription worker downloads the full recording from R2.
5. The current Cloudflare provider reads the entire file into memory, base64-encodes it, and JSON-marshals it before calling Workers AI.

This is the OOM trigger.

Source of failure:

- [webhooks.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/interfaces/http/handlers/webhooks.go#L251)
- [service.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/domain/transcription/service.go#L75)
- [cloudflare.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/infrastructure/transcription/cloudflare.go#L49)

## Non-Goals

- Reintroducing Whisper workers
- Switching the default provider away from Cloudflare
- Reworking the recording upload pipeline in this change
- Replacing Chalk's existing `post_meeting_transcripts` lifecycle with a brand-new job system unless needed later

## Proposed Fix

Replace the current in-process Cloudflare provider with a Cloudflare Worker-backed provider.

New high-level shape:

1. Chalk API still owns transcript records and business state.
2. Chalk API no longer performs media-heavy transcription work itself.
3. Chalk API sends a lightweight transcription job request to a dedicated Cloudflare producer Worker.
4. The Cloudflare Worker fetches the R2 presigned URL and calls Workers AI using a streamed body:
   - `audio: { body: response.body, contentType }`
5. A Cloudflare Queue buffers transcription jobs.
6. A Cloudflare consumer Worker reads jobs from the queue, runs Workers AI, and posts the final transcript result back to Chalk API through a signed callback endpoint.
7. Chalk API stores transcript text, segments, language, duration, and downstream AI summary/action items exactly as it does today.

Consequence:

- Cloudflare remains the provider.
- Workers AI remains the model runtime.
- The EC2 API instance stops handling large audio bytes in heap.

## Why This Design

This keeps ownership boundaries clean:

- Chalk API remains the source of truth for recordings, transcripts, tenant policy, and downstream AI/webhooks.
- Cloudflare Queue becomes the buffering and retry boundary.
- Cloudflare consumer Worker becomes the execution surface for byte-heavy media fetch + Workers AI invocation.

This also preserves current product semantics:

- internal tenants still auto-queue transcription
- transcript records still live in `post_meeting_transcripts`
- the rest of post-meeting summary and webhook behavior can remain mostly unchanged

## Architecture

### Components

1. Chalk API
- creates transcript row
- dispatches Cloudflare transcription job to a producer Worker or directly to a queue-backed producer binding
- exposes callback endpoint for Worker result
- persists transcript result
- triggers existing AI summary + post-meeting webhook flow

2. Cloudflare Producer Worker
- validates signed job request from Chalk API
- publishes normalized job payload to Cloudflare Queue

3. Cloudflare Queue
- buffers jobs away from the API request path
- provides retry semantics and dead-letter routing

4. Cloudflare Consumer Worker
- consumes queued transcription jobs
- fetches the presigned R2 URL
- streams audio to Workers AI
- normalizes result
- posts signed callback to Chalk API

5. Workers AI
- runs `@cf/openai/whisper-large-v3-turbo`

6. Postgres
- existing `post_meeting_transcripts` row remains the durable job record

### End-to-End ASCII Flow

```text
+-------------------------+
| Cloudflare RealtimeKit  |
| recording webhook       |
+-----------+-------------+
            |
            | POST /api/v1/webhooks/recording-status
            v
+-------------------------+
| Chalk API               |
| webhook handler         |
+-----------+-------------+
            |
            | validate webhook + load recording row
            v
+-------------------------+
| Chalk API               |
| recording processor     |
+-----------+-------------+
            |
            | stream download from Cloudflare recording URL
            v
+-------------------------+
| Chalk API               |
| R2 upload               |
+-----------+-------------+
            |
            | complete recording in DB
            v
+-------------------------+
| Chalk API               |
| post_meeting_transcripts|
| create row: pending     |
+-----------+-------------+
            |
            | signed dispatch request
            v
+-------------------------+
| Cloudflare Producer     |
| Worker                  |
+-----------+-------------+
            |
            | validate signature + publish message
            v
+-------------------------+
| Cloudflare Queue        |
| transcription jobs      |
+-----+-------------+-----+
      |             |
      | deliver     | exhausted retries
      v             v
+----------------+  +-------------------------+
| Cloudflare     |  | Cloudflare DLQ          |
| Consumer Worker|  | failed transcription    |
+--------+-------+  | messages                |
         |          +-----------+-------------+
         |                      |
         | fetch presigned R2   | failure handler / replay tooling
         | URL                  | marks transcript failed
         v                      v
+-------------------------+   +-------------------------+
| Cloudflare R2           |   | Chalk API               |
| recording object        |   | transcript failure path |
+-----------+-------------+   +-------------------------+
            |
            | response.body stream
            v
+-------------------------+
| Workers AI              |
| @cf/openai/whisper...   |
+-----------+-------------+
            |
            | transcript result
            v
+-------------------------+
| Cloudflare Consumer     |
| Worker                  |
+-----------+-------------+
            |
            | signed callback
            | POST /api/v1/post-meeting/transcription/callback
            v
+-------------------------+
| Chalk API               |
| transcript callback     |
+-----------+-------------+
            |
            | store transcript text/json
            | mark transcript completed/failed
            v
+-------------------------+
| Chalk API               |
| AI summary/action items |
+-----------+-------------+
            |
            | enqueue / send post-meeting webhook
            v
+-------------------------+
| Chalk API webhook       |
| delivery worker         |
+-----------+-------------+
            |
            | POST tenant webhook
            v
+-------------------------+
| Tenant endpoint         |
| receives post-meeting   |
| payload                 |
+-------------------------+
```

### Cloudflare Transcription Failure Path

```text
+-------------------------+
| Chalk API               |
| transcript row: pending |
+-----------+-------------+
            |
            | dispatch
            v
+-------------------------+
| Producer Worker         |
+-----------+-------------+
            |
            | enqueue
            v
+-------------------------+
| Cloudflare Queue        |
+-----------+-------------+
            |
            | deliver
            v
+-------------------------+
| Consumer Worker         |
+-----------+-------------+
            |
            | fetch R2 / run Workers AI
            | fails
            v
+-------------------------+
| Queue retry logic       |
+-----+-------------+-----+
      |             |
      | retry       | retries exhausted
      v             v
+----------------+  +-------------------------+
| Consumer Worker|  | Cloudflare DLQ          |
| tries again    |  | terminal failure        |
+----------------+  +-----------+-------------+
                                |
                                | DLQ handler / replay processor
                                | marks transcript failed
                                v
                     +-------------------------+
                     | Chalk API               |
                     | transcript row: failed  |
                     | provider_error_* set    |
                     +-----------+-------------+
                                 |
                                 | queue post-meeting webhook
                                 v
                     +-------------------------+
                     | Chalk API webhook       |
                     | delivery worker         |
                     +-----------+-------------+
                                 |
                                 | POST tenant webhook
                                 v
                     +-------------------------+
                     | Tenant endpoint         |
                     | receives recording +    |
                     | errors[]; no transcript |
                     +-------------------------+
```

### Recommended Request Flow

Decision update:

- v1 now includes Cloudflare Queues
- v1 still avoids Cloudflare Workflows unless later operational evidence shows they are needed

#### A. Queue

When Chalk decides to transcribe a recording:

1. create `post_meeting_transcripts` row with `status='pending'`
2. create a short-lived signed dispatch payload
3. `POST` payload to Cloudflare producer Worker `/jobs/transcribe`
4. producer Worker validates and enqueues queue message
5. if accepted:
   - keep transcript status as `pending` or move to queue-dispatched state via logs/metadata
   - store queue execution metadata in structured logs
5. if dispatch fails:
   - leave as `pending` for retry, or mark failed after retry budget

#### B. Execute

Queue message contains:

- `transcript_id`
- `recording_id`
- `room_id`
- `audio_url`
- `content_type`
- `language_hint`
- `callback_url`
- `issued_at`
- `expires_at`
- `signature`

Consumer Worker then:

1. validates signature and TTL
2. fetches `audio_url`
3. passes `response.body` directly to Workers AI
4. receives transcription result
5. posts callback to Chalk API

#### C. Complete

Chalk API callback handler:

1. authenticates Worker callback
2. loads transcript row by `transcript_id`
3. verifies idempotency
4. stores transcript text/json/language/duration
5. marks transcript `completed`
6. lets the existing AI summary + post-meeting webhook flow continue

#### D. Terminal failure

If consumer retries are exhausted and the message lands in the DLQ:

1. DLQ handling marks the transcript row `failed`
2. provider error metadata is stored on the transcript row
3. Chalk queues the tenant-facing post-meeting webhook
4. tenant receives a final webhook with:
   - meeting metadata
   - participant list
   - recording block if enabled
   - no transcript text
   - no summary
   - no action items
   - `errors[]` entry describing the transcription failure

## Data Model

Recommended default:

Reuse `post_meeting_transcripts` as the primary state machine.

Current statuses already support the basics:

- `pending`
- `processing`
- `completed`
- `failed`

Recommended addition:

Add execution metadata without creating a parallel queue table in v1.

Preferred new columns:

- `provider_job_id` nullable text
- `provider_queue_message_id` nullable text
- `provider_attempts` integer default 0
- `provider_last_queued_at` timestamptz nullable
- `provider_completed_at` timestamptz nullable
- `provider_error_code` nullable text
- `provider_error_stage` nullable text

Reason:

- keeps operational visibility close to the transcript row
- avoids reviving Whisper-specific job machinery
- gives enough debugging surface for retries and callbacks

If we want to keep schema changes smaller in v1, these can be emitted only in wide logs first and migrated later.

## API Contracts

### 1. Chalk API -> Producer Worker

`POST /jobs/transcribe`

Body:

```json
{
  "transcript_id": "uuid",
  "recording_id": "uuid",
  "room_id": "uuid",
  "audio_url": "https://...",
  "content_type": "audio/webm",
  "language_hint": "en",
  "callback_url": "https://chalk-api.../api/v1/post-meeting/transcription/callback",
  "issued_at": "2026-04-05T12:00:00Z",
  "expires_at": "2026-04-05T12:10:00Z",
  "signature": "hmac"
}
```

Success:

```json
{
  "ok": true,
  "provider_job_id": "cf-producer-request-id",
  "provider_queue_message_id": "optional-if-returned"
}
```

### 2. Consumer Worker -> Chalk API callback

`POST /api/v1/post-meeting/transcription/callback`

Body:

```json
{
  "transcript_id": "uuid",
  "provider": "cloudflare",
  "provider_job_id": "string",
  "status": "completed",
  "language": "en",
  "duration_seconds": 1234,
  "word_count": 567,
  "text": "full transcript",
  "segments": [
    { "start": 0.0, "end": 1.2, "text": "hello" }
  ]
}
```

Failure callback:

```json
{
  "transcript_id": "uuid",
  "provider": "cloudflare",
  "provider_job_id": "string",
  "status": "failed",
  "error_code": "worker_timeout",
  "error_stage": "ai_run",
  "error_message": "human readable error"
}
```

## Worker Runtime Design

### v1

The queue consumer Worker should:

- fetch the presigned R2 URL
- inspect `Content-Type` and `Content-Length`
- pass `response.body` to `env.AI.run`
- avoid `arrayBuffer()`
- avoid base64 encoding in the Worker
- return or callback the normalized transcript

Recommended Workers AI invocation shape:

```ts
const audio = await fetch(audioUrl);

const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
  audio: {
    body: audio.body,
    contentType: audio.headers.get("content-type") ?? "audio/webm",
  },
  language,
});
```

### v2 fallback path

If Worker execution limits prove too tight for long recordings:

- add a Cloudflare-native async orchestration layer
- likely Cloudflare Queues or Workflows in front of the Worker
- keep the same Chalk API contract and callback shape

The spec should preserve this upgrade path without requiring Chalk API contract changes.

## Deployment Shape

Recommended location:

- new Worker app under `infrastructure/`, parallel to the old Whisper worker layout

Suggested path:

- `infrastructure/cloudflare-worker`

Reason:

- matches the user's requested placement model
- keeps deploy/runtime ownership close to infra
- preserves the "worker lives in infrastructure" precedent from `infrastructure/whisper-worker`

Required config/secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- queue name
- dead-letter queue name
- Worker route / workers.dev hostname
- callback signing secret
- dispatch signing secret
- optional allowlisted Chalk API origin

## Security

### Dispatch auth

Chalk API signs each dispatch request with HMAC over:

- body
- timestamp
- expiry

Producer Worker rejects:

- bad signature
- expired request
- replay outside TTL

### Callback auth

Consumer Worker signs callback body with a separate HMAC secret.

Chalk API verifies:

- signature
- transcript exists
- callback not expired
- callback is idempotent

### URL handling

- presigned R2 URLs should stay short-lived
- Worker should not log raw URLs
- Chalk API should not persist presigned URLs in DB

## Observability

Add wide events on both sides.

### Chalk API events

- `transcription.dispatch`
- `transcription.dispatch_retry`
- `transcription.queue_enqueued`
- `transcription.queue_dead_lettered`
- `transcription.callback_received`
- `transcription.callback_rejected`
- `transcription.completed`
- `transcription.failed`

Suggested fields:

- `transcript_id`
- `recording_id`
- `provider`
- `provider_job_id`
- `recording_size_bytes`
- `dispatch_duration_ms`
- `callback_duration_ms`
- `attempt`
- `outcome`
- `error_code`
- `error_stage`

### Worker logs

- `cf_transcription.producer_received`
- `cf_transcription.queue_enqueued`
- `cf_transcription.consumer_received`
- `cf_transcription.audio_fetch_started`
- `cf_transcription.ai_started`
- `cf_transcription.ai_completed`
- `cf_transcription.callback_sent`
- `cf_transcription.failed`
- `cf_transcription.dead_lettered`

## Retry Model

Recommended v1:

- API retries dispatch failures with bounded exponential backoff
- Queue handles consumer retries
- configure DLQ for terminal failures
- callback retries are bounded inside the consumer Worker
- callback retries are bounded and logged
- transcript row stays authoritative for whether work is still pending or has terminally failed

Idempotency rules:

- same `transcript_id` may be dispatched more than once
- callback completion must be idempotent
- if transcript is already `completed`, callback should return success without rewriting
- queue consumer must `ack()` successful messages explicitly when individual message handling is used
- queue consumer should `retry()` transient failures with delay

## Rollout Plan

### Phase 1

- add Queue-backed Cloudflare provider
- keep current provider name as `cloudflare`
- behind env flag, route Cloudflare provider through producer/queue/consumer path instead of in-process base64 path
- add Cloudflare Queue + DLQ
- add callback endpoint
- add wide logs

### Phase 2

- enable for internal tenants only
- verify no API memory spikes during large recording transcription

### Phase 3

- remove old in-process Cloudflare implementation
- keep only the Worker-backed Cloudflare path

## Migration Plan

No product-facing migration should be required.

Implementation migration:

1. add new Cloudflare Worker app
2. add Cloudflare Queue and DLQ
3. add Chalk API callback route
4. add provider implementation that dispatches to producer Worker / queue path
4. gate with env flag
5. enable in prod for internal tenants
6. delete legacy in-process path after verification

## Failure Handling

If Worker dispatch fails:

- transcript remains retryable
- API should not crash
- no tenant-facing post-meeting webhook is sent yet
- the job has not reached terminal transcription outcome

If consumer Worker fetch of audio fails:

- callback with `failed`
- include `error_stage=audio_fetch`

If Workers AI fails:

- callback with `failed`
- include `error_stage=ai_run`

If a recording exceeds practical Worker or Workers AI limits:

- Worker returns terminal failure with a specific provider error
- Chalk stores the failure cleanly
- API process remains unaffected

If consumer retries are exhausted:

- message is sent to DLQ
- DLQ event is surfaced in logs and, ideally, an alert
- Chalk marks the transcript `failed`
- persist provider error metadata on the transcript row
- Chalk then queues the tenant-facing post-meeting webhook with error information

If callback fails:

- Worker retries within bounded budget
- Chalk API remains source of truth

## Cloudflare Transcription Failure Semantics

This section defines the intended product and system behavior when Cloudflare transcription does not succeed.

### 1. While the Cloudflare job is still retrying

While the message is still in the Cloudflare Queue retry lifecycle:

- transcript row should remain non-terminal
- tenant-facing post-meeting webhook should not be sent yet
- Chalk should treat the transcript as in-flight, not failed

Reason:

- avoids premature "transcription failed" webhooks for transient provider issues
- lets Cloudflare retry semantics do their job before Chalk emits a final downstream event

### 2. When the Cloudflare job reaches terminal failure

When retries are exhausted and the message lands in the DLQ:

- transcript row becomes `failed`
- Chalk stores explicit provider failure metadata
- failure metadata should include enough detail to distinguish:
  - dispatch failure
  - queue failure
  - audio fetch failure
  - Workers AI runtime failure
  - callback failure
  - DLQ exhaustion

Recommended transcript metadata fields:

- `provider_error_code`
- `provider_error_stage`
- `provider_attempts`
- `provider_job_id`
- `provider_queue_message_id`

### 3. What Chalk should send to the tenant

After terminal transcription failure, Chalk should still send the tenant-facing post-meeting webhook.

This preserves the existing product contract that post-meeting completion does not silently disappear just because transcription failed.

The final webhook should contain:

- `meeting`
- `participants`
- `recording` if enabled
- no `transcript` block unless transcript text actually exists
- no `summary`
- no `action_items`
- `errors[]` containing a transcript failure record

Recommended error shape:

```json
{
  "field": "transcript",
  "code": "transcription_failed",
  "message": "human readable provider failure"
}
```

This matches the current Chalk payload-building direction, where transcript content is only included when text exists, while error information is emitted separately.

### 4. If the tenant webhook itself fails

This is a separate failure domain from Cloudflare transcription.

After Chalk has decided the transcript is terminally failed and has queued the tenant-facing webhook:

- the webhook delivery worker should retry tenant delivery independently
- the transcript outcome should remain `failed`
- tenant webhook delivery failure must not reopen or mutate transcript processing state

Current Chalk retry shape already does this:

- delivery rows are created in `webhook_deliveries`
- pending/failed deliveries are re-polled
- retry backoff increases over time
- permanent exhaustion leaves the webhook delivery failed

This same separation should remain in the new architecture.

### 5. Queueing fallback vs terminal transcription failure

There are two different failure moments:

#### A. Queueing failure

If Chalk fails to enqueue the transcription job at all:

- transcript has not entered provider execution
- tenant webhook should not be sent as a transcription failure yet by default
- API should retry dispatch first

Only after dispatch has reached a terminal failure policy should Chalk emit the final tenant-facing error webhook.

#### B. Provider execution failure

If the job was accepted by Cloudflare but later fails in the consumer path:

- Queue retries happen first
- DLQ marks the terminal boundary
- Chalk then emits the final downstream webhook with transcription failure in `errors[]`

### 6. Summary of the failure contract

In short:

- transient Cloudflare failures: retry, do not notify tenant yet
- terminal Cloudflare transcription failure: mark transcript failed, then notify tenant with recording + `errors[]`
- tenant webhook delivery failure: retry separately, without changing transcript state

## Chalk Compatibility Notes

This design intentionally stays aligned with current Chalk post-meeting behavior:

- transcription failure currently still attempts post-meeting webhook send after processing fails
- post-meeting payloads already support `errors[]`
- transcript content is already omitted when transcript text is absent

Relevant current code paths:

- transcription failure still tries webhook send in [transcription_worker.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/infrastructure/jobs/transcription_worker.go#L128)
- post-meeting webhook flow after transcription in [post_meeting.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/domain/webhook/post_meeting.go#L135)
- transcript failure error injection in [post_meeting.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/domain/webhook/post_meeting.go#L219)
- tenant payload only includes transcript when transcript text exists in [service.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/domain/webhook/service.go#L199)
- webhook delivery retry behavior in [webhook_worker.go](/Users/macmini/Desktop/Code/chalk/apps/api/internal/infrastructure/jobs/webhook_worker.go#L76) and [webhook_deliveries.sql](/Users/macmini/Desktop/Code/chalk/apps/api/db/queries/webhook_deliveries.sql#L13)

## Test Plan

### API

- dispatch request signing tests
- callback verification tests
- idempotent completion tests
- retry/failure status tests

### Worker

- bad signature rejection
- expired request rejection
- producer enqueue success
- consumer streamed `audio.body` invocation
- consumer callback success
- consumer retry/failure
- DLQ routing after retry exhaustion

### End-to-end

- internal recording completes
- transcript row moves `pending -> processing -> completed`
- large file does not increase API RSS materially
- summary/action-items still generate

## Implementation Checklist

### 1. Schema and transcript state

- add transcript provider execution metadata fields to `post_meeting_transcripts`
- update checked-in SQL migration files
- update embedded runtime migrations in `apps/api/internal/infrastructure/postgres/postgres.go`
- regenerate sqlc outputs if needed
- confirm transcript state model covers:
  - `pending`
  - `processing`
  - `completed`
  - `failed`
- confirm DLQ terminal failure maps cleanly onto transcript `failed`

### 2. Chalk API callback and dispatch path

- add signed dispatch payload builder in `apps/api`
- add provider implementation that dispatches to Cloudflare producer Worker instead of transcribing in-process
- keep provider name `cloudflare`
- add callback verification logic for consumer Worker callbacks
- add callback endpoint under the post-meeting transcription surface
- make callback completion idempotent
- persist provider error metadata on failure callback
- ensure transcript completion path still feeds summary/action items generation
- ensure terminal failure path still queues tenant-facing post-meeting webhook

### 3. Replace old in-process Cloudflare provider behavior

- remove `io.ReadAll` + base64 + JSON-heavy execution from the active Cloudflare path
- keep Cloudflare provider factory wiring, but point runtime behavior to dispatch/callback flow
- delete legacy in-process path once Worker-backed path verifies
- add or update regression tests proving API no longer reads full recording into memory for Cloudflare transcription

### 4. Cloudflare Worker project

- create `infrastructure/cloudflare-worker`
- choose project structure for:
  - producer route handler
  - queue consumer
  - shared auth/signing helpers
  - callback client
  - Workers AI invocation helper
- add Worker config (`wrangler.toml` or `wrangler.jsonc`)
- define Queue producer binding
- define Queue consumer binding
- define DLQ binding
- add local dev/test scripts

### 5. Producer Worker

- implement dispatch endpoint
- verify HMAC signature and expiry
- normalize and validate payload
- enqueue queue message
- return provider job metadata to Chalk API
- emit structured logs for dispatch accept/reject

### 6. Consumer Worker

- consume queue messages
- fetch presigned R2 URL
- stream `response.body` to Workers AI
- avoid `arrayBuffer()` and base64 encoding
- normalize transcript result
- sign and send callback to Chalk API
- implement transient retry vs terminal failure distinction
- route exhausted failures to DLQ
- emit structured logs for fetch, AI run, callback, retry, and DLQ outcomes

### 7. DLQ handling

- provision dedicated DLQ from day one
- define DLQ replay/inspection strategy
- implement terminal failure handler that marks transcript `failed`
- persist provider error metadata:
  - `provider_error_code`
  - `provider_error_stage`
  - `provider_attempts`
  - `provider_job_id`
  - `provider_queue_message_id`
- ensure tenant-facing post-meeting webhook is queued after terminal transcription failure

### 8. Tenant-facing post-meeting webhook semantics

- preserve current behavior where terminal transcription failure still results in a tenant-facing webhook
- ensure failure webhook includes:
  - meeting metadata
  - participants
  - recording if enabled
  - `errors[]`
- ensure failure webhook omits:
  - transcript text when absent
  - summary
  - action items
- keep tenant webhook delivery retries separate from transcript processing state

### 9. Webhook delivery worker compatibility

- verify existing `webhook_deliveries` flow needs no semantic change
- verify delivery retries still work for terminal transcription-failure payloads
- verify permanent webhook delivery failure does not reopen transcript state
- add tests for transcription-failed payload delivery

### 10. Config and secrets

- add Worker dispatch URL config to Chalk API
- add dispatch signing secret
- add callback signing secret
- add Cloudflare Worker/Queue environment configuration
- add required GitHub Actions secrets
- add required local dev env docs
- verify production secret placement across SSM/GitHub/Worker secrets

### 11. Infrastructure and deploy

- provision Cloudflare Queue
- provision Cloudflare DLQ
- provision Worker deployment config under `infrastructure/`
- wire producer route and consumer bindings
- add deployment workflow for `infrastructure/cloudflare-worker`
- verify deploy order between API and Worker changes

### 12. Observability

- add Chalk API wide events for dispatch, callback, completion, failure, and queue/DLQ outcomes
- add Worker logs for producer, consumer, retry, and DLQ paths
- make sure transcript/recording/provider identifiers are present in logs
- avoid logging presigned URLs or secrets
- add alerts for:
  - DLQ entries
  - repeated callback failures
  - elevated transcription failure rate

### 13. Verification

- verify happy-path recording -> transcription -> summary -> tenant webhook end to end
- verify transient Cloudflare failure retries without premature tenant notification
- verify DLQ terminal failure marks transcript `failed`
- verify terminal failure still sends tenant webhook with `errors[]`
- verify tenant webhook retry behavior remains intact
- verify API RSS stays flat during large recording transcription

### 14. Cleanup

- remove old in-process Cloudflare transcription implementation after verification
- remove any now-unused config or code paths tied only to the legacy implementation
- update `apps/api/CHANGELOG.md` if code changes ship
- update operational docs for replaying DLQ jobs and debugging failed transcripts

## Decision Lock

The following implementation decisions are locked:

1. Execution model
- use asynchronous Cloudflare Queue + consumer Worker flow in v1
- do not add Cloudflare Workflows in v1

2. Deployment placement
- place the new Worker under `infrastructure/`
- assumed path for planning: `infrastructure/cloudflare-worker`

3. File-size gating
- do not add a conservative pre-dispatch file-size cap in v1
- rely on the Worker/Workers AI execution path to accept or reject based on real runtime limits
- still log content length and failure reason for operational visibility

4. Legacy path
- do not keep the old in-process Cloudflare path after verification
- remove it once the Worker-backed path is proven

5. State model
- reuse `post_meeting_transcripts` as the main job record

6. Provider naming
- keep provider name `cloudflare`
- change implementation behind the scenes without tenant/provider churn

7. DLQ
- provision a dedicated DLQ from day one

8. Worker packaging
- use one Worker project under `infrastructure/cloudflare-worker`
- producer and consumer can share the same project if code remains small

9. DLQ terminal policy
- when a message lands in the DLQ, mark the transcript `failed`
- persist explicit provider error metadata on the transcript row
