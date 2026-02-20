# Chalk Deep Dive Progress — 2026-02-20

Scope locked: `q9labs` account, `us-east-1`, requested incidents + error classes.

## Incident 1 — Monday ~2:50pm PST service error
Status: completed
- exact window used:
  - UTC: `2026-02-16T22:20:00Z` → `2026-02-16T23:20:00Z`
  - PST: `2026-02-16 14:20:00` → `2026-02-16 15:20:00` (anchor `14:50 PST`)

- timeline:
  - `22:20:02Z` CloudTrail first `AccessDenied` (`ecs:RegisterContainerInstance`) from `arn:aws:sts::688819141892:assumed-role/chalk-whisper-prod-role/i-0bc9fcac61c6c87e4` to `arn:aws:ecs:us-east-1:688819141892:cluster/default`.
  - `22:24:29Z` first API `WARN` `http.request` `status_code=404` `path=/` (total `11` in-window; last `23:17:59Z`).
  - `22:50:00Z` anchor minute: `ws.metrics` healthy (`clients=0`, `rooms=0`, `write_errors=0`, `ping_errors=0`); `whisper.queue_depth=0`.
  - `23:19:53Z` CloudTrail last in-window `RegisterContainerInstance AccessDenied`.

- impacted components/endpoints/tenants (visible):
  - Endpoint signal: only `GET /` probes returning `404` (`11` events).
  - Component signal: `whisper` EC2 role/boot path continuously attempting ECS register on `cluster/default`.
  - Tenant impact: none visible (`tenant_id` empty on in-window `http.request` events).

- likely cause + confidence:
  - No confirmed backend outage at anchor. Most likely client/edge-facing error interpretation around `404 /` or transient outside captured backend path. Confidence: `medium`.
  - Confirmed parallel infra issue: IAM/boot misconfig on whisper host causes continuous `ecs:RegisterContainerInstance AccessDenied` spam (non-API path). Confidence: `high`.

- concrete evidence lines:
  - Axiom `chalk-api-prod` (window): `154` events total; `http.request` only `11` rows, all `status_code=404`, `path=/`; no `5xx`.
  - Axiom `chalk-prod-traces` (window): `52` spans, `errors=0`, dominant route `/health` `200`.
  - CloudWatch metrics (window): ALB `RequestCount` sparse (`0–2/min`), `HTTPCode_ELB_5XX_Count` no datapoints, `HTTPCode_Target_5XX_Count` no datapoints; `Chalk/WebSocket` write/ping/drop metrics all `0`.
  - CloudTrail (window): `434` `ecs:RegisterContainerInstance AccessDenied` events, steady `~6–8/min`, first `22:20:02Z`, last `23:19:53Z`.

- immediate mitigation:
  - Stop/disable ECS agent on whisper EC2 instances now (`ecs` service) to end retry storm + noise.
  - Add explicit `/` handler/redirect + clear error body (avoid generic “service error” on root path).
  - Add temporary alert: CloudTrail `RegisterContainerInstance AccessDenied` rate + `GET / 404` burst.

- permanent fix:
  - In `infrastructure/terraform/modules/whisper`: stop using ECS-optimized AMI for non-ECS worker (switch to standard AL2/AL2023), or hard-disable ECS agent in user-data.
  - If ECS registration actually intended, then set explicit target cluster + dedicated instance profile permissions; otherwise keep ECS perms removed and disable agent.
  - Improve incident telemetry: client error payload + request-id + absolute UTC timestamp in reports.

## Incident 2 — Monday ~5:01pm PST token exchange failed (Service Unavailable)
Status: completed

- Exact window used:
  - UTC: `2026-02-17T00:31:00Z` → `2026-02-17T01:31:00Z`
  - PST: `2026-02-16 16:31:00` → `2026-02-16 17:31:00` (anchor `17:01 PST`)

- Timeline (token-exchange failures):
  - `00:31Z–01:31Z`: no token-exchange events in Axiom (`/api/v1/auth/token` reqs=`0`, errors=`0`; participant token reqs=`0`).
  - `00:31Z–01:31Z`: API Gateway access logs show zero events (`recordsMatched=0`, `recordsScanned=0`) in `/aws/apigateway/chalk-prod-http-api`.
  - `00:31Z–01:31Z`: ALB shows no 5xx (`HTTPCode_Target_5XX_Count` empty); only sparse fast 4xx probes (`~0.0005s–0.001s` target response).
  - `00:31Z–01:31Z`: CloudTrail shows no deploy/config mutation (`UpdateService`/`UpdateStage`/`RunInstances`/`TerminateInstances` absent).
  - Closest matching failure signature (outside requested window): `2026-02-17T13:24:58Z` to `13:25:03Z` (`05:24:58–05:25:03 PST`) with API Gateway `POST` `503`, latency `30005–30007ms`, responseLength `33` (`{"message":"Service Unavailable"}`).

- Impacted API routes/services:
  - In requested window: no confirmed token-exchange route impact in `chalk-api`.
  - Outside-window matching incident (inference from timing + logs): `POST /api/v1/auth/token` on `chalk-api` behind API Gateway HTTP API (`0q1nkc6b90`), routeKey logged as `ANY /{proxy+}`.

- Likely cause + confidence:
  - Requested window RCA: timestamp mismatch or edge/client-side transient not captured in current AWS/Axiom datasets. Confidence: `medium`.
  - Matching later incident RCA (same error signature): auth token exchange latency exceeded API Gateway ~30s cap, gateway returned `503 Service Unavailable` while backend later logged `200` with `43.5s–45.5s` duration. Confidence: `high`.

- Supporting evidence lines:
  - Axiom (`chalk-api-prod`, window): `/api/v1/auth/token` summary `reqs=0, errors=0, warns=0`.
  - CloudWatch Logs Insights (`/aws/apigateway/chalk-prod-http-api`, window): `recordsMatched=0`, `recordsScanned=0`.
  - CloudWatch Metrics (`AWS/ApplicationELB`, window): no `HTTPCode_Target_5XX_Count`; only `HTTPCode_Target_4XX_Count` + sub-ms response.
  - Outside-window correlation:
    - API Gateway access log `2026-02-17 13:24:58.481/13:25:00.764/13:25:03.732Z`: `status=503`, `latency~30007ms`, `integrationStatus=200`, `responseLength=33`.
    - Axiom `2026-02-17T13:25:43.991/13:25:46.091/13:25:47.891Z`: `/api/v1/auth/token`, `status_code=200`, `duration_ms=45,484 / 45,099 / 43,499`.

- Immediate mitigation:
  - Add incident-time fallback check: if token exchange > `25s`, fail fast with explicit app error + retry hint; stop waiting for API Gateway hard timeout.
  - Add monitor/alert on `/api/v1/auth/token` p95 + p99 latency and API Gateway `5xx` spikes.
  - Validate reported timestamp with client logs next incident (absolute UTC in alert payload).

- Permanent fix:
  - Make API-key resolution strictly indexed/O(1) in DB path (no tenant scan fallback on hot path).
  - Keep/extend tenant lookup cache warm strategy and cap slow-path work per request.
  - Add route-level API Gateway access logging fields (path correlation id) to remove `ANY /{proxy+}` ambiguity during RCA.
  - Add regression perf test gate for `/api/v1/auth/token` under high tenant cardinality (protect <30s SLA).

## Incident 3 — Wednesday ~7:19pm PST failed to fetch (consumer)
Status: completed
- exact window: `2026-02-19T02:34:00Z` → `2026-02-19T04:04:00Z` (PST `2026-02-18 6:34pm` → `8:04pm`); anchor `2026-02-19T03:19:00Z` (`7:19pm PST`)
- mapping (`failed to fetch` -> backend/network 5xx/timeout/disconnect): **no backend 5xx/timeout/disconnect evidence**
  - ALB (`app/chalk-prod/cec7c64737109afb`, TG `chalk-prod-api`): `RequestCount=13`; `HTTPCode_Target_5XX_Count=0`; `HTTPCode_ELB_5XX_Count=0`; `TargetConnectionErrorCount=0`; `UnHealthyHostCount max=0`; `TargetResponseTime max=0.001004s`
  - Axiom `chalk-api-prod`: `226` events; `ERROR/CRITICAL=0`; status class 5xx not present; `ws.metrics` stable (`clients=0`, `write_errors_total` flat `10`, `backpressure_closes_total` flat `1`)
  - anchor-adjacent API traffic: only scanner-style `404` probes; nearest to anchor `2026-02-19T03:18:47.646Z GET / 404`
- impacted consumers/tenants visible: **none visible**
  - `tenant_id` empty for all events in window (`with_tenant=0`)
  - no `consumer` route/event hits in Axiom during window
- likely cause: client-side fetch failure before/at edge request path (browser/network/CORS/wrong host), not API backend failure
  - confidence: **high** for “not backend 5xx/timeout/disconnect”; **medium** for exact client root cause
- evidence:
  - Axiom dataset checks: `chalk-api-prod`, `chalk-prod-traces` (no 5xx signal)
  - CloudWatch Logs `/aws/ecs/chalk-prod`: only `ws.metrics` INFO heartbeat in window
  - CloudTrail: repeated `ecs:RegisterContainerInstance AccessDenied` from `chalk-whisper-prod-role` to `cluster/default` begins ~`03:20Z`; likely unrelated to `chalk-prod-api` consumer fetch path
  - VPC flow logs: rejects exist on private `:8080` scan traffic (`17`), none on `:443` rejects in window
- mitigation + prevention:
  - client SDK/webapp: emit structured `fetch_failed` telemetry (url, method, DNS/TLS/CORS hint, network type, tenant, request-id) to Axiom
  - edge/API: enable/retain access logs at ALB/API layer with request-id correlation into app logs
  - add synthetic consumer probe (global + us-east-1) and alert on fetch-fail without matching backend request
  - clean up whisper IAM misconfig (`RegisterContainerInstance` to wrong cluster) to reduce noisy parallel failures

## Incident 4 — Thursday ~9:30pm PST participant kicked from room
Status: investigated (pre-window), pending post-window confirmation

- exact window:
  - anchor: `2026-02-19 21:30 PST` = `2026-02-20T05:30:00Z`
  - analysis window: `2026-02-20T04:45:00Z` → `2026-02-20T06:15:00Z` (±45m)
  - investigation run time: `2026-02-20T03:20Z` to `~03:23Z`; requested window still future at run time
- event sequence:
  - `2026-02-20T03:15:06Z` CloudTrail `ecs:UpdateService` by `GitHubActions` on `chalk-prod-api` to task def `chalk-prod-api:110`
  - `2026-02-20T03:16:50Z` ECS task `2fc1209e...` stopped: `Task failed to start` / `CannotPullImageManifestError: manifest unknown`
  - `2026-02-20T03:18:58Z` ECS task `0ea4ca9e...` stopped: same `CannotPullImageManifestError`
  - `2026-02-20T03:19:48Z` new replacement task attempt (`f509d854...`) submitted; later also stopped with same image-manifest error
  - old task `1b60b76d...` (task def `:115`) remained running during capture window
- room/participant failure pattern:
  - Axiom `ws.metrics` (`03:00Z`→`03:22Z`): `clients=0`, `rooms=0` every minute
  - no Axiom rows for `disconnect|kicked|evict|remove|1006|1011` in sampled pre-window period
  - no CloudWatch log events in incident target window yet (`04:45Z`→`06:15Z`) at investigation time
- likely cause + confidence:
  - likely precondition risk, not final incident verdict yet: bad deploy image/tag (`task-definition :110` points to non-pullable image) caused repeated ECS task start failures during pre-window
  - confidence: medium (`0.74`) for pre-window deploy failure root cause; low (`0.20`) for direct tie to 9:30pm PST participant kick because target window had not occurred yet at analysis time
- evidence:
  - CloudTrail `UpdateService` event id `5c542230-71c9-4b2b-97b1-5208d5cabafe` at `2026-02-20T03:15:06Z`
  - CloudTrail `SubmitTaskStateChange` events show `CannotPullImageManifestError: manifest unknown`
    - `2026-02-20T03:16:50Z` task `2fc1209e...`
    - `2026-02-20T03:18:58Z` task `0ea4ca9e...`
  - ECS `describe-tasks` confirms stopped reasons above for task def `chalk-prod-api:110`
  - CloudWatch Logs `/aws/ecs/chalk-prod` shows only `ws.metrics` heartbeat lines; no participant-kick/disconnect errors in sampled pre-window
  - CloudWatch Logs `/aws/ecs/chalk-prod` and `/aws/apigateway/chalk-prod-http-api`: empty for requested incident window at query time
- mitigation + prevention:
  - immediate:
    - fix task def image reference for `chalk-prod-api:110` (publish tag or repoint to valid digest)
    - force rollback/forward to known-good task def (`:115`) until image availability verified
  - prevention:
    - CI gate: block `UpdateService` unless image digest exists + pull test passes
    - deployment guard: fail fast on first `CannotPullImageManifestError`; auto-rollback before repeated launch attempts
    - incident follow-up query run after `2026-02-20T06:15:00Z` to confirm/deny any actual `1006/1011` or participant eviction events in true window

## Root Cause Track A — 5xx errors
Status: completed

- Top 5xx pathways:
  - API gateway 5xx from POST /api/v1/rooms/:id/participants -> handlers.Participant.Add -> participant.Service.JoinRoom when downstream Cloudflare or DB calls fail hard (no graceful degradation).
  - Cloudflare participant add 500/timeouts bubbling from apps/api/internal/infrastructure/cloudflare/client.go AddParticipant (RequestError wraps status/body, no retries, plain fmt.Errorf propagated to HTTP layer).
  - Secondary 5xx from CreateMeeting auto-creation branch plus token/db hits (apps/api/internal/domain/participant/service.go around room auto-create, participant CreateParticipant, auth.TokenIssuer.GenerateTokenPair).
- Exact code paths & logs:
  - Router wiring in apps/api/internal/interfaces/http/router.go and handlers.Participant.Add feed the JoinRoom stack that logs Cloudflare failures per apps/api/CHANGELOG.md:21 (operation, status, body, stack) so Axiom/ALB metrics can tie incidents to specific API calls.
  - cfClient.AddParticipant/CreateMeeting in apps/api/internal/infrastructure/cloudflare/client.go prints request/response, returns RequestError, and lacks retries or rate limits; failure flows straight back through JoinRoom to the gateway.
  - tests/scripts/collect-infra-snapshot.sh + infrastructure/terraform/modules/monitoring/main.tf already capture ALB/target 5xx counts to validate incident spikes.
- Why retries/timeouts/circuit breakers insufficient:
  - cloudflare.NewClient uses plain http.Client with Timeout=30s (client.go lines 34-46) and single attempt per call; any transient 5xx/timeout surfaces as a RequestError and becomes HTTP 500.
  - There is no circuit-breaker/failure-tracking layer around cfClient calls or JoinRoom, so sustained Cloudflare degradation keeps hitting the API gateway (no fast-fail or slowdown).
- Hardening plan:
  - Short-term: wrap AddParticipant/CreateMeeting in bounded retries (3 attempts, jitter, respect ctx) inside apps/api/internal/infrastructure/cloudflare/client.go, log attempt counts, and let handlers.Participant.Add map repeated RequestError -> 503 to stop gateway 5xx spikes.
  - Medium-term: add a failure-rate circuit breaker/health gate around Cloudflare client (either in cloudflare/client.go or participant.Service) to open after configurable 5xx thresholds and fallback to queueing/host-notify flows so clients see 503+Retry-After instead of 500.
- Specific code-level actions:
  - apps/api/internal/infrastructure/cloudflare/client.go: introduce retry helper + jitter/backoff, share between AddParticipant/CreateMeeting, propagate operation/status into RequestError, add hook to increment metrics for failure counts.
  - apps/api/internal/domain/participant/service.go: when cfClient returns RequestError, enrich HTTP handler response via handlers.Participant.Add (routing file) so API replies 503 with Cloudflare diagnostic (room ID, tenant, op) instead of generic 500, and surface counters for circuit breaker transitions.
  - apps/api/internal/interfaces/http/router.go (handlers.Participant) to tag requests with correlation IDs + status codes for ALB logs so we can distinguish Cloudflare vs DB 5xx in the gateway.
  - tests/scripts/collect-infra-snapshot.sh: add log or output marker when top 5xx path triggered to correlate with ALB metrics and verify instrumentation continues to capture spikes.
- Observability call-outs:
  - apps/api/CHANGELOG.md:21 records the log schema (operation/status/body/stack) that we rely on in Axiom to trace API gateway 5xx back to Cloudflare participant add failures.
  - tests/scripts/collect-infra-snapshot.sh already emits ALB 5xx aggregates (lines 90-138) so we can validate hardening impact after retries/breaker updates.

## Root Cause Track B — redis client errors
Status: completed

- Source paths + lifecycle bug(s:
  - `apps/api/cmd/main.go:34-285`: root `context.Background()` never cancelled; server starts transcription/webhook/cleanup jobs via `go ... Run(ctx)` and the signal handler at lines 277-285 only closes `router`/`pool` while the same `ctx` keeps running.
  - `apps/api/internal/interfaces/http/router.go:392-400`: `Router.Close()` shuts down the websocket hub and closes the shared `redisClient` without coordinating with other goroutines that still use it.
  - `apps/api/internal/infrastructure/transcription/whisper.go:63-120`: `WhisperProvider` enqueues (`LPush`) and polls (`Get`) results on the shared client; a closed client surfaces `redis: client is closed` before the provider can stop.
- Race/shutdown/reconnect scenarios:
  - SIGINT/SIGTERM handler (`apps/api/cmd/main.go:277-285`) tears down router while `jobs.TranscriptionWorker.Run(ctx)` (`apps/api/internal/infrastructure/jobs/transcription_worker.go:33-91`) still drains transcripts, so `ProcessTranscription` flows into `WhisperProvider.Transcribe` (`apps/api/internal/domain/transcription/service.go:73-188` -> `internal/domain/transcription/registry.go:19-86`) and hits the closed client.
  - Shared `redisClient` across hub/pubsub, transcription worker, and other jobs means the first close (or manual reconnect) races with in-flight `LPush`/`Get` which log `redis: client is closed` instead of cleanly winding down or reconnecting.
- Evidence from code references:
  - `jobs/transcription_worker.go:33-91` loops until `ctx.Done()` but `ctx` never cancelled by the signal handler, leaving worker goroutines running during shutdown.
  - `internal/domain/transcription/registry.go:19-86` and `internal/infrastructure/transcription/whisper.go:63-120` hand every transcript to `WhisperProvider` which directly issues Redis commands; once `redisClient.Close()` runs the provider cannot recover.
  - `apps/api/internal/interfaces/http/router.go:392-400` closes the client immediately after closing the hub, so any remaining background job trying to publish/subcribe sees `redis: client is closed`.
- Prevention plan (reconnect strategy, health checks, guards, backoff, observability):
  - Establish a cancelable top-level context via `signal.NotifyContext` in `main`, propagate it to every worker/hub, and call `cancel()` before closing `router`, `pool`, and `redisClient` so the shared client is still live while goroutines drain.
  - Add explicit stop/wait hooks for each background job (`transcriptionWorker`, recording checker, room cleanup, lifecycle manager) so shutdown waits on `ctx` cancellation before `router.Close()` executes.
  - Expand `internal/infrastructure/redis/redis.go` into a guarded client that exposes ping/health metadata, records `client is closed` hits, and optionally reinitializes/reconnects with backoff rather than letting callers hit the nil pointer.
  - Harden `WhisperProvider.Transcribe` and `jobs/transcription_worker.go` to catch `redis: client is closed`, surface a sentinel error, back off/retry with jitter, and emit dedicated Axiom logs/metrics for the connection failure so the noise becomes actionable.
- Prioritized fix list:
  1. `apps/api/cmd/main.go` — switch to `signal.NotifyContext`, cancel before hitting the shutdown goroutine, wait for all workers to stop, then close `router`/`redisClient` so the shared client never closes mid-flight.
  2. `apps/api/internal/interfaces/http/router.go` + `jobs/transcription_worker.go` — sequence shutdown (cancel -> stop worker -> close router), honor cancellation when `ctx.Done()` fires, and treat `provider.Transcribe` errors from redis as a stop condition instead of retrying against a closed client.
  3. `apps/api/internal/infrastructure/redis/redis.go` (and any redis caller) — add health check/reconnect wrapper, guard commands after `Close`, emit `redis.connection_error` events, and expose a retry/backoff policy so downstream jobs back off instead of flooding logs.

## Root Cause Track C — failed to get reader EOF
Status: completed

- Focus: websocket reader loop + header parsing trips where logs show `failed to get reader: EOF`. Trace from `handlers/websocket.go` upgrade → `websocket.NewClient` → `Client.readPump` → `nhooyr.io/websocket.Conn.reader` (readLoop/readFrameHeader).
- Likely failure modes: client TCP drop/close frame missing, ALB/Cloudflare idle timeout during quiet rooms, backend backpressure closing send buffer while `readPump` still reading, TLS/ALB resets during header read, or race between HTTP ctx cancel (pre-`context.Background` change) and the reader lock.
- Code path details: `HandleWebSocket` calls `websocket.Accept`, sets read limit, registers to `Hub`, starts pumps with `context.Background`; `Client.readPump` loops on `Conn.Read`, `setDisconnect`/`CloseWith`, and defers `hub.Unregister`; non `websocket.CloseError` results (EOF/ErrClosed/timeout) get classified as `StatusInternalError` (1011) and logged via slog + logging.Stdout, so `failed to get reader: EOF` surfaces as error-noise even when peer-initiated disconnect.
- Behavior classification: EOF/ErrClosed noise is expected for abrupt peer disconnects. Real incidents surface when high-volume 1011 logs coincide with `recordWSSendBackpressureClose` hits or ping/write errors, signaling backpressure/ping failures rather than benign EOFs.
- Prevention & noise-reduction plan:
  1. Short-circuit `errors.Is(err, io.EOF|io.ErrUnexpectedEOF|net.ErrClosed)`/`websocket.CloseStatus(err) == net.ErrClosed` in `readPump` to log at Info with a `peer_disconnect` tag instead of 1011, preserving metrics for real errors.
  2. Instrument `websocket.Accept` + `readFrameHeader` failures (idle timeouts, header parse errors) with structured fields (tenant/room/trace/origin) to correlate with Cloudflare/ALB idle policies.
  3. Keep 30s ping ticker and tighten `writeDeadline` on ping/write to keep idle front doors happy; consider `SetReadLimit` guard to avoid header rejection noise tied to env overrides.
  4. Surface new `ws.metrics` counters for EOF/read header failures so alerting can ignore them and focus on ping/write/backpressure signals.
- Prioritized code changes (refs):
  - `apps/api/internal/interfaces/websocket/client.go`: treat EOF/ErrClosed separately in `readPump`, log Info (`peer_disconnect`), avoid 1011, and use `DisconnectInfo` to annotate metrics/participant leave reason.
  - `apps/api/internal/interfaces/http/handlers/websocket.go`: log upgrade/header failures with tenant/room/trace info when `websocket.Accept` or `SetReadLimit` rejects a header, to spot CF/ALB idle termination.
  - `apps/api/internal/interfaces/websocket/metrics.go`: add `recordWSReadEOF`/`recordWSReadHeaderError`, expose via `ws.metrics` to differentiate true internal errors from EOF noise.
  - `apps/api/internal/interfaces/websocket/hub.go`: hook `ParticipantService.LeaveRoom` to `DisconnectInfo` so downstream systems know whether the drop came from peer/backpressure/idle timeout before tearing down room state.

## Implementation Update — 2026-02-20
Status: completed

- Cloudflare add-participant hardening shipped in code:
  - bounded retry with backoff+jitter for transient failures/timeouts
  - structured logs with `operation`, `attempt`, `status_code`, `tenant_id`, `room_id`, `request_id`, elapsed timings
  - request correlation context plumbed from participant handler
- Participant handler hardening:
  - Cloudflare upstream failures now return `503`/`502` shape with request correlation id
  - Cloudflare attempt count logged in gin private error metadata
- Redis shutdown race hardening:
  - root context now `signal.NotifyContext`
  - background workers bound to shared cancellation + waited before router/redis close
- WebSocket EOF noise reduction:
  - benign read EOF/net-closed now classified as peer disconnect (`read_eof`) instead of internal `1011`
  - added websocket counters/log fields for `read_eofs` and `read_errors`

## Implementation Update 2 — 2026-02-20
Status: completed

- Cloudflare `CreateMeeting` parity hardening shipped in code:
  - same bounded retry + jitter/backoff strategy as add-participant
  - same structured observability fields (`tenant_id`, `room_id`, `request_id`, attempt, status, elapsed)
  - added tests for transient retry + no-retry on client-side statuses
- Monitoring/alert wiring shipped in Terraform module:
  - new log metrics + alarms for `join_room_cloudflare` failures (`Chalk/API`)
  - dedicated upstream 5xx metric/alarm for Cloudflare join path
  - new websocket `read_errors` and `read_eofs` metrics + alarms (`Chalk/WebSocket`)
  - dashboard widgets updated to include Cloudflare join failures and websocket read counters
  - module validation passed: `terraform -chdir=infrastructure/terraform/modules/monitoring validate`
- API Gateway timeout finding:
  - current stack uses API Gateway **HTTP API v2** (`aws_apigatewayv2_integration`)
  - AWS HTTP API integration timeout remains capped at `30000ms` in this mode; `60s` not directly configurable without architectural migration path (e.g., REST API + quota process)
