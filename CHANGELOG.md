# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **SDK-Core: room listing + join-token APIs** — add typed `listRooms`, `createJoinToken`, and `exchangeJoinToken` client/session APIs so consumers can use SDK-first flows instead of manual HTTP calls.
- **Web: scheduled classes panel** — add dashboard UI to create scheduled classes, list upcoming/live classes, and generate join links through SDK methods.

### Changed

- **Infra: remove deprecated Terraform prod environment** — deleted `infrastructure/terraform/environments/prod` and updated infra docs/ops guides to standardize on `prod-lean` workflows only.
- **API: room list status filtering** — `GET /api/v1/rooms` now supports multi-status filters (`scheduled|active|ended`) and returns participant counts for filtered listings.
- **Web: join-link preflight behavior** — join-link flow now checks schedule window and shows a “not meeting time yet” waiting state with countdown before auto-entering.

### Fixed

- **Infra: R2 browser uploads/downloads CORS** — configure `cloudflare_r2_bucket_cors` on recordings bucket with browser-safe rules (`GET/HEAD/PUT`, wildcard headers/origins by default, preflight cache TTL) so whiteboard/image presigned URL uploads no longer fail preflight (`No 'Access-Control-Allow-Origin' header`).
- **SDK-React/Whiteboard: image sync progress UX** — add live whiteboard file-sync states (`uploading`, `awaiting remote upload`, `downloading`, `error`) and a top-center status pill so the 3–5s peer propagation window feels in-progress instead of failed.
- **Internal auth: localhost magic-link callback support** — internal auth start now accepts a safe callback override (configured app origin + localhost) and `apps/web` sends its current callback URL, so local dev login links open the local app callback instead of forcing hosted-only flow.

## [0.0.70] - 2026-03-07

### Added

- **API: Room scheduling endpoint** — add `POST /api/v1/rooms/schedule` for scheduled room creation with start/end windows and early-join controls.
- **SDK-Core: Room scheduling APIs** — add room scheduling support in the SDK client API so app integrations can create and manage scheduled rooms directly.

### Changed

- **SDK-React: Pre-join loading experience refresh** — loading screen now supports participant-aware gradients and richer animated visual states during room join.
- **Ops: Agent guidance update** — artsy communication mode is now explicitly opt-in and defaults to concise engineering mode.

### Fixed

## [0.0.69] - 2026-03-07


### Added

- **Infra: Lean control-plane stack** — add `prod-lean` Terraform environment for EC2 `t4g.micro` + PlanetScale Postgres + Upstash Redis + Cloudflare R2, with SSM-backed runtime env management.
- **Infra: Lean EC2 runtime module** — add `ec2-api-lean` module (arm64 host bootstrap, Docker runtime, Caddy reverse proxy/TLS, minimal CloudWatch alarms, SSM/ECR IAM wiring).
- **CI: Lean infrastructure workflow** — add `.github/workflows/infra-lean.yml` with plan/apply/destroy for `prod-lean`.
- **CI: Lean API deploy workflow** — add `.github/workflows/api-lean.yml` with arm64 image build/push and EC2 restart through SSM.
- **Docs: Lean migration operations** — add cost baseline and cutover runbook docs for migration, rollback, and decommission sequencing.
- **API: Client incident telemetry endpoint** — add `POST /api/v1/debug/client-incident` (API-key protected) for browser-side incident ingestion.
- **SDK-Core/SDK-React: PostHog session replay integration** — add optional `posthog` config to auto start/stop replay on Chalk room lifecycle and emit replay-friendly lifecycle events (`session_joined`, `session_join_failed`, `session_left`).
- **Testing: Agent-browser room join stress runner** — add `tests/load/agent-browser` runner + wrapper script for multi-room join latency/error analysis (`--count` default `100`, configurable concurrency), with per-attempt artifacts and summary report outputs.

### Changed

- **SDK-Core: dead branch cleanup + type barrel consolidation** — remove unreachable Effect/helper barrels, trim unused manager-layer exports, route `types/api` through the current generated OpenAPI file, and fix sdk-core bridge/websocket compile blockers uncovered during verification.
- **SDK-Core: RTK signaling modularization** — split `conference-session/rtk-signaling.ts` into focused identity, participant-sync, chat, transcript, and shared-deps helpers while keeping `setupConferenceSessionRtkSignaling` behavior and API stable.
- **SDK-Core: ChalkSession state composition cleanup** — extract room/participant/media state API construction into `session/chalk-session-state.ts`, remove `as any` updater plumbing, and centralize leave/reset state cleanup through typed session updaters.
- **API: DB pool tunables via env** — support `DATABASE_MAX_CONNS` and `DATABASE_MIN_CONNS` with validation so lean `t4g.micro` can run lower connection pressure safely.
- **API Docker: Multi-arch build support** — Dockerfile now honors `TARGETARCH` for arm64-compatible builds used by lean EC2 deploys.
- **CI: Terraform validate scope** — include `ec2-api-lean` module in legacy infra validation loop.
- **API: WebSocket auth observability** — enrich websocket auth logs with token source + room query diagnostics (invalid/mismatch visibility) and expiry context.
- **API: Incident log schema** — emit structured `client.incident` events with tenant/request/client metadata for Axiom correlation.
- **API: Join-path observability + timeout budgeting** — participant join now emits step-level timing telemetry (`participant.join_room`), includes `join_duration_ms` in join errors, and uses tighter add-participant timeout/retry budgets for interactive joins.
- **API: Cloudflare add-participant response handling** — keep add-participant attempt context alive until response body read completes; fixes intermittent false join failures where upstream returned `201` but client recorded `context canceled`.
- **Web: PostHog wiring for Chalk replay lifecycle** — `apps/web` now initializes optional PostHog from `VITE_POSTHOG_KEY`/`VITE_POSTHOG_HOST` and passes it to `ChalkProvider.posthog` so replay starts/stops with Chalk room lifecycle events.
- **Web: Client incident transport wiring** — `apps/web` now configures `ChalkProvider.incident.reporter` using `createHttpIncidentReporter` to send support-code incidents to `POST /api/v1/debug/client-incident` (API-key header + keepalive beacon fallback).
- **Tooling: Oxfmt formatting setup** — add repo-wide `oxfmt` formatter with root scripts (`format`, `format:check`) and shared `.oxfmtrc.json` defaults (`printWidth: 300`) for consistent code style.
- **SDK-React: VideoConference composition refactor** — split `VideoConference` internals into focused modules (`join-errors`, `useJoinFlow`, `useLobbyDevices`, `useMeetingStats`, `useSessionEvents`, `useChatNotifications`, `useConferenceErrorReporter`, shared `types`) to reduce component size and isolate orchestration concerns without changing public behavior.
- **SDK-React: VideoConference shell slimming + effect isolation** — further decompose meeting controls, connection state derivation, participant moderation, and meeting-room view-model mapping into dedicated hooks; remove phase-based session event re-subscriptions by using `phaseRef` for in-callback gating.
- **SDK-React: VideoConference feature/props orchestration cleanup** — extract feature-flag resolution (`useConferenceFeatureFlags`) and meeting-room prop composition (`useMeetingRoomProps`), replacing in-component ad-hoc wiring with typed, memoized composition boundaries.
- **SDK-React: VideoConference controller-view split** — reduce `VideoConference.tsx` to a facade component and move orchestration/view-prop assembly into `useVideoConferenceController`, `useVideoConferenceMeetingRoomProps`, and `view-state` helpers for clearer composition boundaries and safer incremental edits.
- **SDK-React: Join-flow hook decomposition** — split `useJoinFlow` support concerns into focused helpers (`useRealtimeKitPreload`, `useJoinFlowTelemetry`, `join-flow-device-tasks`) so the hook stays orchestration-focused while preserving join/retry behavior.
- **SDK-React: Session-events error handling cleanup** — extract error classification and diagnostic payload shaping into `session-events-error-utils`, simplifying `useSessionEvents` event wiring and maintaining existing toast/error semantics.
- **SDK-React: PreJoinLobby composition refactor** — split lobby responsibilities into focused hooks/components (`usePreJoinUiState`, `usePreJoinTheme`, `usePreJoinMedia`, `usePreJoinAudioMeter`, modal/header/preview/panel sections), reducing the root component to a small orchestration shell while preserving props compatibility.
- **SDK-React: MeetingRoom composition refactor** — extract meeting-room state/effects/render sections into a `meeting-room/` module set (`types`, lifecycle/theme/ui/derived hooks, stage/panels/controls/overlays/top-bar sections), shrinking the root file to a concise conductor component without behavior changes.
- **SDK-React: EndScreen composition split** — decompose `EndScreen` into focused feedback/download/actions modules and shared duration utility for cleaner structure without changing user-facing flow.
- **SDK-Core: Session-first naming overhaul (breaking)** — rename core SDK vocabulary to `ConferenceClient`/`ConferenceSession` with `JoinSessionConfig`, `SessionInfo`, and `SessionConnectionState`; rename lifecycle APIs to `joinSession`, `createSession`, and `endSession`, and align `sdk-react` / `sdk-react-native` imports/re-exports/providers with the new naming.
- **SDK-Core: ConferenceSession event contract redesign (breaking)** — migrate room event names to dot notation (`connection.state.changed`, `participant.joined|left|updated`, `speaker.active.changed`, `chat.message`, `hand.*`, `recording.*`, `whiteboard.*`) and update all manager/effect/session listeners plus tests to the new event grammar.
- **SDK-Core: structural composition pass for session/client internals** — split legacy `room.ts` and `client.ts` monoliths into focused composition modules (`conference-session/*`, `conference-client/*`) while preserving public API behavior and resilience/test seams.
- **SDK-Core: listener teardown lifecycle hardening** — standardize unsubscribe cleanup across WS signaling, session state bridges, and room-attached managers (`chat`, `recording`, `interaction`, `screen-share`, `whiteboard`) so repeated room attachments/leaves do not accumulate duplicate listeners.
- **SDK-Core/SDK-React-Native: auth expiry event dot-notation (breaking)** — replace legacy auth event names (`token-expired`, `token:expired`) with canonical `token.expired` across emitters/listeners, schemas, and tests.
- **SDK/Core+React+API: whiteboard wire contract locked to v2 (breaking)** — removed v1 `whiteboard.update` send APIs and dual-path UI wiring, made outbound/inbound schemas require v2 fields (`schemaVersion=2`, `sceneId`, `syncAll`), and simplified whiteboard sync/render flows to a single collab-v2 pipeline.
- **API: whiteboard snapshot/data payloads normalized to required v2 fields** — websocket payload structs now emit non-optional v2 metadata and persistence restore now accepts only v2 state blobs.
- **SDK-Core/SDK-React/API: whiteboard contract naming + strictness cleanup** — tightened collab engine remote payloads to require v2 epoch fields (`sceneId`, `syncAll`) and renamed API websocket internal update struct from `WhiteboardUpdateV2Payload` to protocol-neutral `WhiteboardUpdatePayload` while still enforcing `schema_version=2`.

### Fixed

- **SDK-React: Join-flow resilience + retry observability** — `VideoConference` now retries transient join failures before surfacing lobby errors, preserves last join settings for in-call reconnect retries (`ConnectionLostOverlay` CTA), and emits enriched `onError` details (`stage`, attempt metadata, join retry exhaustion context) for downstream incident telemetry.
- **SDK-React: Error support code surfacing** — join and connection-failure modals now show a user-visible `Support Code`, and emitted errors include `details.supportCode` for backend correlation.
- **SDK-Core/SDK-React: SDK-native incident pipeline** — add canonical incident schema + HTTP reporter (`createHttpIncidentReporter`), thread provider/session incident config (`incident`, `onIncident`, `incidentReporter`, breadcrumb cap), and auto-emit incidents for surfaced SDK errors with support-code/trace correlation.
- **API: client incident envelope compatibility** — `POST /api/v1/debug/client-incident` now accepts both legacy flat payloads and SDK envelope payloads (`{ incident, reportedAt }`) so incident ingestion no longer drops with `400`.
- **SDK-React: join race suppression** — pre-join flow now dedupes rapid join clicks and treats `Already joining a room` as a non-fatal race instead of surfacing a blocking modal.
- **SDK-Core: stronger RTK join retries** — increase RTK join retry budget from 4 total attempts to 5 total attempts with progressive backoff to reduce transient `RoomSocketHandler.joinRoom failed` failures.
- **SDK-Core: wide-events SDK version source-of-truth** — replace hardcoded `sdk.version` with `packages/sdk-core/package.json` version and add regression coverage to prevent stale telemetry versions in production bundles.
- **SDK-Core: cohort-aware RTK join policy telemetry** — select RTK join timeout/backoff by runtime cohort (`platform`, browser `effectiveType`, `saveData`) and emit selected policy/cohort in `room.join` wide events for targeted tuning.
- **SDK-Core: post-click RTK/sync attribution telemetry** — emit per-attempt `room.join.rtk.attempt` events (attempt duration, timeout/error classification, delay, policy) and one-shot `room.sync.ready` when first RTK/WS snapshot arrives to pinpoint non-API post-click delays.
- **SDK-Core/SDK-React: RTK bundle preload before join click** — add safe `preloadRealtimeKit()` API in `ChalkClient`, reuse cached RTK module during join init, and trigger preload from `VideoConference` lobby lifecycle so join stays non-blocking even when preload fails.
- **SDK-React: join UI/media transition telemetry** — emit `ui.join.click`, `ui.join.phase_transition`, and `ui.media.device_selection` (post-click device select timing/outcome) without changing best-effort/non-blocking device selection behavior.
- **Newton observability: join-path correlation + retry telemetry** — API join logs now include `trace_id`, room slug, Cloudflare per-operation attempt/retry/timeout stats; Cloudflare client emits attempt events for create-meeting/add-participant retries; SDK API events expose `x-request-id`/`x-chalk-trace-id`/`cf-ray`; and agent-browser stress tooling now emits attempt↔backend correlation maps for incident triage.
- **API + SDK-Core: State mismatch recovery hardening** — websocket hub now fans out authoritative `room.snapshot` on participant join/leave and resolves snapshot participants from shared room-state across instances, while RTK participant handling now reconciles from `participantsUpdate`/`participantsCleared` to recover missed join/screen-share deltas.
- **SDK-Core: RTK participant reconciliation canary + fallback hardening** — participant self-healing now reads RTK snapshots from `participants.toArray()`/`joined.toArray()` in addition to map iterators, listens on both RTK participant emitters for `participantsUpdate`/`participantsCleared`, and retries reconciliation after clear events; regression tests now cover missed join + missed screen-share recovery on this fallback path.
- **SDK-Core: Participant roster self-healing on missed RTK join deltas** — remote `videoUpdate`/`audioUpdate`/`screenShareUpdate` now upsert participants when `participantJoined` is missed, and session participant state now upserts unknown `participant-updated` events to prevent one-way room visibility mismatches.
- **SDK-Core: RTK join token safety + retries regression coverage** — stop substituting `rtcToken` with `tokenProvider()` output during room join, harden JWT base64url expiry parsing, and add join-path regression tests for token mismatch, missing RTC token, and retry behavior.
- **CI: Legacy prod destroy resilience** — make infra destroy tolerant of stale state/manual deletes by using `terraform destroy -refresh=false` and non-blocking R2 lifecycle state cleanup.
- **Web CI: SPA fallback artifact check** — ensure `apps/web/scripts/prepare-pages-spa.mjs` emits both `index.html` and `404.html` from `_shell.html` for Cloudflare Pages fallback validation.
- **Post-meeting transcription timeout tuning** — raise Whisper timeout from `30m` to `2h` and include queue-depth diagnostics in timeout errors to avoid false failures under backlog.
- **Whisper stability under backlog** — disable aggressive batched inference by default on CPU workers and add OOM fallback from batched to single-mode transcription while retaining `c7i.large` spot sizing.
- **Infra: Lean whisper spot self-healing** — switch lean whisper worker spot mode to persistent requests so interruptions relaunch capacity automatically on `c7i.large` spot.
- **CI: API ECS deploy skip behavior** — handle missing ECS task definition gracefully in `api.yml` instead of failing deploy stage when legacy ECS stack is absent.
- **API: Eman Time CORS allowlist** — add `https://app.emantime.com` and `https://dev-app.emantime.com` to platform CORS origins so browser preflight requests can receive `Access-Control-Allow-Origin`.
- **API: WebSocket origin allowlist** — add Eman Time origins (`app`, `dev-app`, `portal`) to the WebSocket origin patterns to avoid handshake rejections from strict origin checks.
- **API: WebSocket tenant-origin handshake** — when an origin is validated against tenant `allowed_origins`, lock WS upgrade checks to that origin (with host-only compatibility for API Gateway/ALB forwarded Origin headers) so newly added tenant domains work without static allowlist updates.
- **Docs: WebSocket endpoint examples** — update native/android/iOS docs to use `wss://chalk-ws.q9labs.ai/ws` instead of `wss://chalk-api.q9labs.ai/ws`.
- **API: Meeting preset transcription override** — force Cloudflare participant join requests to send `transcription_enabled=false` so in-meeting preset transcription stays disabled.
- **SDK-React: PreJoinLobby device selection** — camera/microphone/speaker picks now persist during lobby and are applied after room join, fixing `NOT_IN_ROOM` failures from pre-join device changes.
- **SDK-React: Speaker output routing in meeting audio** — thread selected speaker device through `VideoConference` → `MeetingRoom` → `AudioRenderer` and apply `setSinkId` for remote mic/screen-share playback when supported.
- **SDK-React: Mobile mic-control tap reliability** — raise meeting control bar layer priority, keep pre-join controls touch-friendly, and keep invite toast away from mobile bottom controls to prevent blocked taps.
- **SDK-Core/SDK-React: PostHog session replay integration** — add optional `posthog` config on `ChalkClient`, `ChalkSession`, and `ChalkProvider` to start/stop session recording and emit `chalk_sdk_session_joined|join_failed|left` lifecycle events without introducing a hard `posthog-js` dependency.

### Removed

- **SDK-Core: whiteboard v1 outbound API surface** — removed `sendWhiteboardUpdate(elements, files, seq)` from websocket client/session action chain.
- **SDK-React + chalk-whiteboard: legacy SyncEngine branch** — removed `useV2` toggles and root `SyncEngine` export path in favor of collab-v2-only runtime.
- **chalk-whiteboard: legacy root type surface** — removed unused v1-oriented root types module and now re-export root whiteboard types directly from collab-v2.
- **API: whiteboard v1 protocol artifacts** — removed v1 compatibility handling and persisted-state v1 restore fallback; websocket updates now only accept/emit the v2 shape (`schema_version=2`).

## [0.0.59] - 2026-02-22

### Added

### Changed

- **Infra: Whisper aggressive cost mode** — downsize prod Whisper worker from `c7i.xlarge` to single Spot `c7i.large` and reduce `WHISPER_CPU_THREADS` to `2`.

### Fixed

- **SDK-Core/SDK-React: Whiteboard open/close sync** — remote whiteboard open/close events now update local state without re-broadcasting.

### Removed

## [0.0.58] - 2026-02-22

### Added

- **Native: File-based logs (iOS/Android)** — write app + MeetingKit events/errors to `chalk.log`, `chalk.debug.log`, `chalk.error.log`, and add in-app “Share logs” so errors are copyable.
- **Native: Dev build/run scripts** — add `bun run ios:*` and `bun run android:*` helpers for consistent local build/install/launch.
- **API: Debug diagnostics endpoints** — add endpoints to inspect auth/server/build health for system health checks.
- **API: Internal tenant auth groundwork** — add internal tenant identity structures and schema so hosted apps can support email login and cross-device usage.
- **API: Internal auth + dashboard** — add internal sign-in paths and meetings dashboard listing for Chalk-hosted apps.
- **API: Opaque join + share links** — add host-only room joins and shareable recording links with public exchange helpers.
- **API: Internal retention job** — auto-remove old internal tenant recordings after 7 days.
- **Web: Host dashboard + share pages** — add dashboard, share, and callback routes for invite/room flows.
- **Stress Tests: Infra capacity snapshots** — capture ECS/ALB/Aurora/Redis metrics during VU sweeps for capacity planning.

### Changed

- **Infra: Monitoring dashboard + alarms for whisper/capacity** — expand dashboards and alarms to surface pressure points during stress and production.
- **Infra: Cloudflare + WebSocket read observability alarms** — add logs and alarms for join and websocket read failures plus shared metric visibility.
- **CI: API pipeline lint gate disabled** — skip lint in API CI while keeping test/build/deploy active.
- **CI: Infra plan/apply artifact handoff** — fix infra artifact flow so apply steps use the generated plan.
- **Whisper Worker: Observability** — export processing metrics for RTF, queue times, and GPU utilization.
- **Infra: Whisper CPU canary profile** — run production worker on controlled `c7i.xlarge` CPU profile with focused RTF alarm coverage.
- **Web: Room UI** — remove host overlay copy link button.

### Fixed

- **API: Transcription default provider** — default now prefers whisper when provisioned and falls back to groq.
- **API: Join room latency** — reduce query count and add a regression test for participant join.
- **API: Cloudflare meeting/participant resilience** — add resilient retries and map upstream failures to friendlier 502/503 handling.
- **API: Redis shutdown races** — drain background workers before shutdown to avoid close-order errors.
- **API: WebSocket read EOF noise** — separate expected disconnects from internal failures in metrics.
- **SDK-React: Remote audio autoplay recovery** — recover remote audio after interaction on browsers that block autoplay.
- **SDK-React: Pre-join media hardening** — handle missing media APIs and stricter audio gesture restrictions.
- **iOS: Meeting grid tile distortion** — force square participant tiles.
- **iOS: Lobby join button blocked** — prevent overlays from blocking “Ask to join”.
- **Web: SPA deep links** — add fallback pages so direct room/share routes don't hard 404.
- **API: Recording endpoint access** — require `CanRecord` for recordings routes.
- **API: WebSocket observability** — add richer lifecycle/error logs and split-brain diagnostics.
- **API: WebSocket error coverage** — emit structured websocket errors and redis pub/sub lifecycle logs.
- **API: WebSocket hijack log spam** — stop logger warnings on upgraded websocket responses.
- **API: Whisper transcription timeout** — make transcription timeout configurable with higher default.
- **Whisper Worker: Queue/throughput observability** — publish more detailed transcription and queue processing metrics.

### Removed

- **Web: Whiteboard agent (tool-calling)** — remove the OpenRouter-backed whiteboard agent and overlay.

## [0.0.57] - 2026-02-08

### Added

### Changed

### Fixed

- **Infra: Aurora headroom + alarms** — increase prod Aurora Serverless v2 max capacity and add CloudWatch alarms for ACU nearing the ceiling; fix Redis and Whisper alarms/metrics so they stop showing `INSUFFICIENT_DATA`.
- **Infra: CORS auto-heal + tracing headers** — add hourly `cors-sync` reconcile, improve S3 origins upload determinism + dispatch retry logging, and allow common tracing headers (`baggage`, `sentry-trace`, `traceparent`) so tenant portals don’t hit preflight CORS failures.
- **SDK-React: Participant volume slider drag** — fix per-participant volume slider to be continuously adjustable (single-value slider now uses `value={number}` instead of range-mode array).
- **SDK-React: Participant volume UX** — move per-participant volume controls into the 3-dot options menu so it’s usable on mobile (no hover).
- **SDK-React: VideoConference roomName prop** — add `roomName` prop and thread it through to `PreJoinLobby` + `MeetingRoom` (displayed as the room title instead of `roomId`).
- **SDK-React: Pre-join lobby display name** — allow clearing the default "Guest" name without it reappearing.
- **SDK-React: Layout switcher icon visibility** — increase layout option icon contrast (less washed out on dark background).
- **SDK-React: Whiteboard default stroke color** — default Excalidraw stroke color is now blue.
- **SDK: iPad screen share feedback + WebKit patching** — show an in-meeting toast with a `Copy error` action (no silent click), guard missing `getDisplayMedia`, and patch non-writable `getDisplayMedia` via `defineProperty` where possible.
- **SDK-React: Invite modal Copy Link feedback** — show a brief "Copied" state after clicking.

## [0.0.55] - 2026-02-06

### Added

- **Docs: Excalidraw sync notes** — add deep-dive sync reference notes for upcoming whiteboard work.
- **Whiteboard: Sync v2 (Excalidraw-native)** — new collab engine using Excalidraw primitives (`restoreElements`/`reconcileElements`), pointer-up flush, periodic full-scene heal, and cursor presence forwarding.
- **API: Whiteboard file presign** — add R2 presigned upload/download endpoints for image sync (no WS data URLs).

### Changed

- **SDK-Core: WSClient refactor (schema-first)** — modular ws-client (decoder/transforms/outbound), runtime payload validation via Effect Schema, typed outbound messages, transcript payload casing fix, and `room-sync` event renamed to `room.sync`.
- **API: Whiteboard WS hub** — relay-only v2 updates with reliable backpressure handling, snapshot persistence (tombstones + `versionNonce` tie-break), and scene epoch semantics for clear.

### Fixed

- **Whiteboard: AppState type import** — align AppState with Excalidraw’s public types export so schema/type resolution works.
- **Whisper Worker: Temp file cleanup NameError** — add missing `os` import so worker can delete downloaded audio files safely.
- **Whisper Worker: Multilingual code-switching** — enable per-segment language detection (shorter chunking) and disable prompt carryover in multilingual mode to prevent missing later-language speech.
- **Whisper Worker: Redis timeout handling** — configure Redis socket timeouts and retry-on-timeout so transient connection timeouts don’t crash the worker loop.
- **Whisper Worker: BRPOP socket timeout** — default Redis socket timeout now exceeds BRPOP poll timeout to avoid spurious read timeouts.
- **Infra: Axiom dataset for API** — default prod `AXIOM_DATASET` to `chalk-api-prod` so Axiom ingest doesn’t 404.
- **API: Axiom ingest guardrail** — if the configured dataset is missing/unauthorized, disable Axiom handler to prevent stderr retry spam.
- **API: Gin release mode** — force Gin into release mode when `ENV=production` so ECS runs without verbose debug/preview logging.
- **CI/CD: Runner stability (Depot fallback)** — switch workflows back to GitHub-hosted runners and Docker Buildx so CI/CD keeps working when Depot runners/builds are unavailable (trial/billing/outages).
- **Infra: Redis ingress for Whisper** — stop ElastiCache SG ingress drift so the Whisper→Redis security group rule is not revoked, preventing Redis connection timeouts in the worker.

## [0.0.53] - 2026-02-03

### Added

- **Whisper Worker: Axiom wide-event logging** — emits one structured wide event per job (`whisper.transcription`) plus periodic queue depth (`whisper.queue_depth`) for fast debugging and analytics.
- **Whisper Worker: Transcript logging (testing)** — include transcript text (capped) in `whisper.transcription` events when enabled.
- **Whisper Worker: Observability guardrails** — Axiom logging failures no longer abort transcription jobs; events fall back to stdout JSON.
- **Stress Tests: VU sweep runner (200→750)** — adds `run-sweep.sh` to automate incremental capacity checks without manually rerunning scenarios.

### Changed

- **Webhooks: Include participant metadata + external IDs in tenant payloads** — post-meeting webhook payloads now include participant metadata (from VideoConference join) plus `external_id`/`external_user_id` for easier tenant identification; sdk-core webhook schema updated accordingly.
- **Infra: Whisper Worker Axiom wiring** — pass `AXIOM_TOKEN` from Secrets Manager (seeded via SSM `/chalk/prod/axiom-token`) and set `AXIOM_DATASET=chalk-whisper-worker` without leaking secrets into EC2 user-data command lines.
- **SDK-React: Remove Storybook from package** — drop Storybook config/stories and simplify SDK surface for consumers.
- **SDK-React/UI: Dev scripts** — ensure `dev` builds include CSS/assets to prevent missing styles in local SDK builds.
- **SDK-React/UI: Meeting room polish** — draggable room-name pill plus ControlBar/PreJoinLobby interaction + accessibility tweaks.

### Fixed

- **Infra: Whisper Worker secrets decrypt** — grant `kms:Decrypt` for Secrets Manager KMS key so worker can read Axiom token during boot.
- **Stress Tests: Fix large-room broadcast latency measurement** — restores deterministic sender-echo detection (no substring matching) and prevents skewed p95/p99 from flaky parsing.
- **Stress Tests: Align ws-storm short runs to active VUs** — short runs now use the target VU count and correct storm duration.
- **Stress Tests: WS token handling + debug logs** — k6 scenarios now guard missing websocket tokens and only log failures in debug mode.
- **Stress Tests: Persist per-run artifacts** — k6 now writes `.jsonl` output plus `-summary.json` exports and results link to both for debugging.
- **Admin: Persist production secret across reloads** — production admin API calls now keep the secret in local storage so refreshes don't drop auth.
- **API Gateway: Allow admin localhost origin for CORS** — add `http://localhost:3090`/`127.0.0.1:3090` to aggregated origins so local admin can call prod API.
- **API Gateway: Allow X-Admin-Secret header for CORS** — preflight now allows admin secret header to reach prod API.
- **Admin: Temporarily disable IP allowlist** — removes IP restriction so admin access is not blocked.

## [0.0.52] - 2026-02-02

### Changed

- **API: Record webhook payload and gate downloadable statuses** — webhook handler now stores the raw Cloudflare request body in the wide event log and only begins download/upload once the recording status reaches `UPLOADED`/`COMPLETED`, which matches RealtimeKit’s documented lifecycle and prevents missing the download URL.

- **CI/CD: Migrate to Depot** — Replace GitHub-hosted runners and Docker buildx with Depot runners (`depot-ubuntu-latest`) and Depot build-push-action for persistent build cache and faster CI. Applies to `api.yml` and `whisper-worker.yml` workflows. Auth via OIDC (no secrets needed).
- **CI/CD: Use full SHA tags for API images** — Avoids ECR immutable tag collisions during force deploy.
- **API: Log missing R2 env vars at startup** — Clear warning when storage credentials/bucket config are absent.
- **Infra: Require R2 credentials in prod when Cloudflare enabled** — Prevents silent misconfig in production.
- **Infra: Pass R2 credentials in workflow** — Terraform CI now injects R2 access/secret keys and falls back to GitHub secret for webhook secret.
- **API: Restore Cloudflare mock config** — Keeps local/tests working when Cloudflare credentials are absent.

### Added

- **SDK-React-Native: Wide-event logging system** — Comprehensive structured logging following canonical log line best practices
  - New `src/logger.ts` with singleton `logger` and `createLogger()` factory
  - Auto-injected environment context: platform, platformVersion, sdkVersion, isSimulator, debug mode
  - Session context tracking: roomId, participantId, displayName (set on room join, cleared on leave)
  - JSON structured output prefixed with `[Chalk]` for easy filtering
  - Respects `debug` prop from ChalkProvider (info logs only when debug=true, errors always logged)
  - Exports: `logger`, `createLogger`, `ChalkLogger` type
  - Event naming convention: `{domain}.{action}[.{phase}]` (e.g., `room.join.start`, `media.video.toggle`)
  - Coverage: ChalkProvider (room ops), RTCManager (WebRTC ops), useMedia, useParticipants, useLocalStream, usePermissions, useRecording
- **API: Local post-meeting webhook receiver** — Test-only endpoint for self-call webhook delivery verification

### Changed

### Fixed

- **Whisper Worker: Silence-safe transcription + faster-whisper v1.2.1** — upgraded worker to `faster-whisper==1.2.1`, added batched inference for queue backlogs (OOM-safe batch fallback), switched container installs to `uv`, and treat silent/near-silent recordings as `completed` with empty transcript instead of failing.

- **API: Parse Cloudflare webhook list response** — Support `data` response shape to avoid empty webhook lists.
- **SDK-Core: iPadOS/Safari screen share reliability** — `getDisplayMedia` now retries with safer constraints (no-audio, then video-only) to support iPadOS/Safari/WebKit while preserving Chrome/Firefox behavior
- **API: Stop recordings when rooms end** — `EndRoom()` now calls `StopRecording()` on Cloudflare before ending the meeting, preventing recordings from staying stuck in "recording" status forever
- **API: Webhook recording processing survives API Gateway timeout** — Recording download+upload now runs in a background goroutine with `context.Background()` instead of the request context, so API Gateway's 30s connection timeout no longer kills the transfer
- **API: Normalize Cloudflare webhook field casing** — Recording webhook payloads now accept camelCase fields (e.g., `downloadUrl`, `outputFileName`, `roomUUID`) so UPLOADED events reliably include the download URL.
- **API Gateway 503 timeout investigation** — Documented HTTP API timeout limitation
  - Investigation revealed intermittent 30-second timeouts from API Gateway
  - HTTP API has a **hard limit of 30 seconds** (cannot be increased)
  - VPC_LINK requires internal ALB (incompatible with WebSocket direct access)
  - Added `vpc_link_security_group_id` output to api-gateway module for future use
  - Next steps: Investigate why some requests take >30s to respond
- **API: Prevent room join hangs from WebSocket backpressure** — `Client.Send()` now drops messages when the per-client buffer is full (instead of blocking request handlers)
- **Monitoring: WebSocket backpressure observability** — Periodic `ws.metrics` log line + CloudWatch metric filters/alarms/dashboard for drops/errors/clients/rooms
- **Monitoring: Fix Terraform CloudWatch metric filters** — Split WebSocket log metric filters into single-metric resources to satisfy provider constraints (unblocks prod apply)
- **Infra: Fix ALB access logs S3 permissions** — Allow ALB to write access logs to the configured S3 prefix (unblocks prod apply)
- **Infra: ALB access logs principal** — Use `aws_elb_service_account` in bucket policy to satisfy AWS log delivery requirements
- **SDK-React: Participant volume slider + mute icon** — Slider drag now updates volume, and mute icon instantly sets participant volume to 0

- **Whiteboard React instance conflict in production** — Externalized `@excalidraw/excalidraw` from sdk-react bundle to prevent duplicate React instances
  - Root cause: Excalidraw was bundled into sdk-react, causing `ReactCurrentOwner` undefined errors in production
  - Added `--external @excalidraw/excalidraw` to sdk-react build
  - Added `@excalidraw/excalidraw` to vite dedupe list and sdk-react peer dependencies
  - Reduced sdk-react bundle size by ~70% (342k → 104k lines)

## [0.0.50] - 2026-01-28

### Changed

- **SDK-Core: Wide Events logging** — Replaced 250+ scattered log calls with canonical "wide events" pattern
  - Each operation emits ONE context-rich event at completion with full timing breakdown
  - New `wideEvents` API: `wideEvents.start("room.join")` → accumulate context → `ctx.complete("success")`
  - Phase timing: `ctx.markPhase("api")`, `ctx.markPhase("rtk.join")` tracks where time is spent
  - Configurable via `ChalkClientConfig.wideEvents`: `{ enabled, handler, includeDebugInfo }`
  - Custom handler support for analytics/logging services: `handler: (event) => analytics.track(event)`
  - Exports: `wideEvents`, `WideEvent`, `WideEventConfig`, `WideEventContext`
  - Removed: `createLogger`, `configureLogger`, `initLogging`, `isLoggingEnabled`, `Logger` types
  - Event types: `room.join`, `room.leave`, `api.request`, `media.toggle`, `screenshare.start/stop`, `websocket.connect/disconnect`, `session.init/dispose`

- **Unified slog-based logging** — Migrated all Go API logging from scattered `log.Printf()` to structured `slog` with wide events pattern
  - New `internal/version` package with build-time variables (CommitSHA, Version, BuildTime)
  - Enhanced central logger adds environment context (service, version, commit_sha, env, region) to all log events
  - Migrated background jobs: `room_cleanup.go`, `recording_check.go`, `storage/lifecycle.go` with injected loggers
  - Migrated WebSocket package: removed verbose per-message logging, kept lifecycle/error events only
  - Migrated remaining files: router, handlers, redis, s3/cors_origins
  - All constructors now accept optional `*slog.Logger` parameter with `slog.Default()` fallback

## [0.0.49] - 2025-01-28

### Added

- **Whiteboard sync for late joiners** — Server now maintains in-memory whiteboard state per room. New participants receive full snapshot on `whiteboard.sync` request instead of empty state.
  - New `WhiteboardState` struct tracks elements (by ID/version), files, appState, and lastSeq
  - `whiteboard.snapshot` message type delivers full state to requesting client
  - Debounced DB persistence (750ms) via `WhiteboardStateStore` interface
  - State cleaned up when last participant leaves room

- **Collaborative cursors** — Participants see each other's cursors with color-coded names
  - 8 distinct cursor colors assigned by participant ID hash
  - Stale cursor cleanup (10s timeout)
  - Cursor position updates sent even when not drawing

- **Large file batching** — Whiteboard images split into batches to prevent WebSocket message size limits
  - New config: `maxPayloadBytes` (32MB default), `maxFileBytes` (32MB default)
  - Files exceeding `maxFileBytes` are skipped
  - Batches sent sequentially with elements only in first batch

### Changed

- **Per-participant sequence tracking** — SyncEngine now tracks sequence numbers per participant instead of globally
  - Prevents cross-participant deduplication issues (participant A's seq 5 no longer blocks participant B's seq 3)
  - `remoteSeqBySource` map replaces single `remoteSeq` counter
  - Snapshot load resets all per-participant sequences

- **WebSocket read limit increased** — Default read limit raised from 32KB to 32MB for large whiteboard payloads
  - Configurable via `CHALK_WS_READ_LIMIT_BYTES` environment variable

### Fixed

## [0.0.48] - 2025-01-28

### Added

- **[chalk] debug logging prefix** - All post-meeting flow logs now use `[chalk]` prefix for easy filtering and tracing
  - Webhook handler: cloudflare webhook receive, recording download/upload, completion status
  - Post-meeting service: trigger, transcription queueing, webhook preparation
  - Transcription service: queue, process, presigned URL generation, API calls
  - Transcription worker: job processing, AI summary generation, webhook send
  - Webhook worker: delivery start, retry scheduling, success/failure tracking
  - Webhook service: payload building, delivery queueing
  - AI service: generation start, provider calls, result storage
  - OpenRouter provider: API request/response with timing
  - Groq provider: transcription request/response with timing

- **Cloudflare webhook registration** - API now registers webhooks with Cloudflare RealtimeKit
  - New `setup-webhook` CLI command (`go run ./cmd/setup-webhook`) for one-time webhook registration
  - Startup check logs warning if no webhook is configured (recordings will not be processed)
  - Webhook CRUD methods added to Cloudflare client (CreateWebhook, ListWebhooks, DeleteWebhook)
  - New config: `API_PUBLIC_URL`, `CLOUDFLARE_WEBHOOK_SECRET`

- **Comprehensive recording flow logging** - Debug and trace recording processing via Axiom
  - Webhook handler: signature verification, download/upload timing, completion status
  - R2 storage: upload/download with duration tracking
  - Recording service: start/stop with Cloudflare IDs
  - Transcription service: queue/process with provider and timing
  - Post-meeting orchestration: decision logging with config details
  - Workers: webhook delivery timing and retry tracking

- **Whisper GPU infrastructure** - Self-hosted transcription on EC2 GPU instances
  - Whisper module instantiated in production environment
  - ECR repository for whisper-worker Docker image
  - GitHub Actions workflow for whisper-worker builds
  - Secrets Manager integration for Redis auth token at runtime
  - Auto-scaling based on queue depth
  - Security group rule for Redis access

### Changed

- **API CI/CD optimization** - Reduced workflow time from ~4min to ~2min
  - Split `lint-and-test` into parallel `lint` and `test` jobs
  - Removed `-v` verbose flag from tests (failures still show full output)
  - Race detection (`-race`) now conditional: enabled on PRs only, skipped on master push
  - Added `.golangci.yml` with lean linter config (6 essential linters vs all defaults)

- **Documentation overhaul** - Complete rewrite of developer documentation
  - **New API docs**: Tenants (CRUD + config), Authentication (token/refresh), Transcription (post-meeting)
  - **Rewritten API docs**: Recordings (all 9 endpoints), Webhooks (comprehensive with signature verification examples), Rooms, Participants (with bulk and token refresh)
  - **Rewritten SDK docs**: VideoConference turnkey component with full TypeScript types
  - **Removed**: React Native, Core SDK, Testing, Pricing, Architecture docs (per plan)
  - **Updated**: Getting started guides with accurate auth flow and X-API-Key header

### Fixed

- **Audio breaking/cutting out during calls** - `AudioRenderer` cleanup effect was running on every participant update (video, speaking, transcription events), causing `srcObject=null` and `pause()` on each render. Moved cleanup to unmount-only effects to prevent audio interruptions
- **Missing database tables in production** - Embedded migration in `postgres.go` was missing tables from migrations 005-007 (transcripts, post_meeting_transcripts, webhook_deliveries, failed recording status)
- **post_meeting_webhook config now persists** - PATCH /api/v1/tenants/{id}/config was silently ignoring `post_meeting_webhook` field (missing from request struct and merge logic)

## [0.0.47] - 2026-01-26

### Added

- **Post-meeting transcription & webhooks** - Complete pipeline for post-meeting processing
  - **Multi-provider transcription**: Groq API (cloud, $0.04/hour) with BYOK support, self-hosted Whisper (optional)
  - **AI summaries**: OpenRouter integration for automatic meeting summaries and action items
  - **Webhook delivery**: HMAC-SHA256 signed webhooks with exponential backoff retry (5 attempts)
  - **Tenant configuration**: Per-tenant settings for `include_recording`, `include_transcript`, `include_summary`, `include_action_items`
  - **SDK webhook handler**: TypeScript utilities for signature verification (`createWebhookHandler`, `chalkWebhookMiddleware`)
  - **Terraform secrets**: Groq and OpenRouter API keys in AWS Secrets Manager
  - Database: `post_meeting_transcripts` and `webhook_deliveries` tables
  - New endpoints: `GET /api/v1/transcription/providers`, transcript status APIs

- **Mobile rebuild (apps/mobile2)** - New crash-resistant mobile app replacing apps/mobile
  - Locked architecture: New Architecture OFF, Hermes ON, Reanimated v3 only
  - Direct SDK imports (no lazy loading) for simpler debugging
  - Custom metro resolver blocking node: protocol imports
  - React-native export condition in sdk-react-native for browser-targeted RN builds
  - Verification script: `bun run mobile:verify` checks for common crash causes
  - Root scripts: `mobile:ios`, `mobile:android`, `mobile:start`, `mobile:prebuild`

### Changed

- **sdk-react: Sounds bundled as data URLs by default** - Zero-config sound effects
  - Base64 data URLs embedded in bundle (~690KB), no file copying needed
  - Works out of the box in Next.js and all frameworks
  - Optional `basePath` prop to use custom sound files instead

- **sdk-react-native: Dual build targets** - Now outputs both Node and React Native builds
  - `dist/index.js` - Node target (for testing, bundlers)
  - `dist/react-native/index.js` - Browser target (no node: imports, Metro-compatible)
  - Package exports include `react-native` condition for automatic resolution
  - Pinned reanimated peer dep from `>=3.0.0` to `^3.0.0` to block v4

- **sdk-react: Enhanced MeetingEndData** - Richer data for post-meeting processing
  - `participants[]` - Full participant history with join/leave times and roles
  - `totalParticipants` - Unique participant count (vs `participantCount` for peak concurrent)
  - `stats` - Feature usage (chat messages, reactions, hand raises, screen shares, whiteboard opens)
  - `startedAt`/`endedAt` timestamps and `hostId` for session context

- **sdk-react: In-meeting theme toggle** - Switch light/dark mode during calls
  - Sun/moon icon button in header controls bar
  - Smooth 300ms transitions on all color properties (`chalk-theme-transition` CSS class)
  - Persists to document.documentElement for app-wide sync

- **sdk-react: Video loading states** - Smoother video appearance
  - VideoTile: Shows avatar until video track is fully loaded
  - ScreenShareView: Loading spinner with "Connecting to screen..." message
  - Fade-in transition (700ms) when video becomes ready

- **sdk-react: New animations** - Polish for meeting transitions
  - `chalk-dock-slide-up/down` - Control bar entrance/exit with spring easing
  - `chalk-tile-pop-in` - Staggered tile appearance
  - `chalk-void-exit` - Shrink + blur effect for leaving participants
  - `chalk-harmonic-pulse` - Speaking indicator glow
  - `chalk-button-tactile` - Hover/active microinteractions

- **chalk-whiteboard: SyncEngine improvements** - More reliable collaboration
  - Separate local/remote sequence numbers for proper ordering
  - Pasted images now sync correctly (file references re-included with changed elements)
  - Pending updates stored in Map for deduplication

### Fixed

- **"Room is full" false positives after participant disconnect** - WebSocket disconnects now properly decrement active participant count
  - Root cause: `hub.unregisterClient()` removed participants from memory but never called `LeaveRoom()` to update database
  - The `CountActiveParticipantsByRoom()` query checks `left_at IS NULL`, so disconnected participants stayed in the count
  - Fix: Hub now calls participant service's `LeaveRoom()` on WebSocket disconnect, marking `left_at` in database

## [0.0.45] - 2026-01-25

### Added

- **sdk-react: Bundled sounds & logos** - Assets now included in SDK distribution
  - Added `useBundled` option to `useSoundEffects` hook for zero-config usage
  - 9 sound files bundled at `@q9labs/chalk-react/sounds/*`
  - 2 logo files bundled at `@q9labs/chalk-react/logos/*`
  - Exported `SOUND_FILES` and `LOGO_FILES` constants from SDK
  - Backward compatible: `useBundled: false` (default) uses `/sounds/` path
- **Dynamic tenant CORS origins** - Tenants can configure allowed CORS domains
  - API: `PATCH /api/v1/tenants/:id/config` now accepts `allowed_origins` array
  - Validation: Max 20 origins, http/https only, no wildcards (except localhost)
  - S3 aggregation: Tenant origins uploaded to S3 for Terraform consumption
  - API Gateway: CORS origins read from S3 bucket (updated via GitHub Actions)
  - Defense in depth: App-level CORS middleware with tenant-aware checking
  - WebSocket: Origin validation against tenant config after JWT authentication
  - New Terraform module: `cors-origins` with S3 bucket and IAM policies
  - GitHub Actions: `cors-sync.yml` workflow triggered by `repository_dispatch`

### Changed

### Fixed

- **sdk-react: Toast notifications invisible for SDK consumers** - Sonner toasts were using CSS variables only defined inside `[data-chalk]` scope, but toasts portal to `document.body`. Switched to sonner's built-in dark theme for consistent styling.
- **CORS for tenant domains** - Enable S3-based CORS origins in API Gateway
  - Set `enable_s3_cors_origins = true` in prod environment
  - API Gateway now reads CORS origins from S3 (includes TuitionHighway domains)
- **Terraform formatting** - Fix HCL alignment in cors-origins module
- **Terraform plan errors** - Fix count/for_each with unknown values at plan time
  - api-gateway: Add `enable_s3_cors_origins` boolean (known at plan time)
  - ecs: Use count instead of for_each for policy attachments

## [0.0.44] - 2026-01-24

### Changed

- **CI install performance** - Added proper dependency caching to GitHub Actions
  - Cache `~/.bun/install/cache` (Bun's global package cache)
  - Cache `node_modules` directories across monorepo
  - Skip `bun install` entirely on cache hits
  - Expected improvement: 3.4 min → ~20-30 seconds on cache hits

### Fixed

- **sdk-react: Reactions not displaying** - `activeReactions` from `useInteractions` hook was never rendered
  - Added `activeReactions` prop to `MeetingRoom` component
  - Render `ReactionBubble` components in floating container over video grid
  - Pass `activeReactions` from `VideoConference` to `MeetingRoom`

- **sdk-react: Sound effects not playing** - `autoSubscribe` was disabled by default
  - Enable `autoSubscribe: true` in `VideoConference`'s `useSoundEffects` hook
  - Add missing reaction event listener in `useSoundEffects` auto-subscribe

- **sdk-react: SSR crash in ReactionPicker** - Direct `document` access during server rendering
  - Add `typeof window === 'undefined'` guard to escape key listener effect

## [0.0.43] - 2025-01-24

### Changed

- **Logging optimizations** - Reduced noise and improved error context
  - Skip `/health` endpoint logging (reduces ~50% log volume)
  - 4xx responses logged as `warn` level with error message
  - 5xx responses logged as `error` level with stack trace
  - Stack traces are condensed (function:line format, skip runtime internals)

- **Reactions overhaul** - Enhanced picker with categories and improved animations
  - ReactionPicker: 6 emoji categories (Smileys, Gestures, Hearts, Celebration, Objects) with 150+ emojis
  - ReactionPicker: Teal-themed design with header, tabs, scrollable grid, footer hints
  - ReactionBubble: Randomized float paths (horizontal offset, rotation, scale variation)
  - ReactionBubble: Bouncy entrance animation with elastic easing
  - ReactionBubble: Particle burst effects for celebration emojis (🎉, 🔥, ⭐, etc.)
  - ReactionBubble: Optional participant name badge
  - New CSS animations: `chalk-reaction-float`, `chalk-reaction-bounce-in`, `chalk-reaction-wiggle`, `chalk-particle-burst`

### Fixed

- **Hand raise indicator not showing** - Local participant's hand raise state now syncs to UI

### Developer Experience

- **Release skill improvements** - macOS-compatible commands, merged analyze+ask phase, explicit Haiku prompt template
  - Core: `Room.raiseHand()` and `lowerHand()` now emit `participant-updated` event
  - This allows React's `useParticipants` to reflect the updated `handRaised` state

## [0.0.42] - 2026-01-24

### Changed

- **What's New dialog redesign** - Multi-release navigation with enhanced UX
  - Backend: `GET /api/v1/whats-new/releases` endpoint fetching up to 10 releases
  - Backend: Release type derivation (major/minor/patch) from semver comparison
  - React SDK: `useWhatsNew` hook extended with `releases[]`, `currentIndex`, `next`, `prev`, `markAllAsSeen`, `later`
  - React SDK: `WhatsNewDialog` redesigned with 40/60 layout (image/content), pagination dots, keyboard navigation
  - React SDK: `ReleaseBadge` atomic component showing release type (major=red, minor=blue, patch=gray)
  - Footer: "Later" (close without marking), "Skip All" (mark all seen), "Next/Done" (primary action)
  - Keyboard: Arrow keys for navigation, Esc to close

### Added

- **Invite toast on join** - Google Meet-style popup prompting users to share meeting link
  - React SDK: `InviteToast` composite component with auto-dismiss (8s), copy link, close button
  - React SDK: `MeetingRoom` prop `showInviteToastOnJoin` (default: true)
  - Hidden during guided tour to avoid UI overlap

- **Sound effects for reactions and hand raise** - Audio feedback for interactions
  - React SDK: Added `reaction` sound effect type and `playReaction` helper
  - React SDK: Hand raise and reactions now trigger sounds in VideoConference
  - Web: Added `reaction.mp3` sound file

- **Structured logging with Axiom integration** - Upgraded to `slog` with Axiom backend for searchable, filterable logs
  - Backend: `logging` package with graceful fallback to JSON stdout
  - Backend: Request ID middleware for correlation across services
  - Backend: Structured fields: `request_id`, `tenant_id`, `room_id`, `participant_id`, `latency_ms`, `status`
  - Environment: `AXIOM_TOKEN` (required for Axiom), `AXIOM_DATASET` (default: `chalk-api`)

### Fixed

### Developer Experience

- **Consolidated release skill** - Merged SKILL.md and RELEASE_GUIDE.md into single 147-line file with Opus+Haiku architecture

## [0.0.41] - 2026-01-24

### Added

- **What's New dialog** - Shows users recent release notes with auto-open on updates
  - Backend: `GET /api/v1/whats-new` endpoint proxying GitHub Releases API with Redis caching
  - React SDK: `useWhatsNew` hook for fetch + localStorage state management
  - React SDK: `WhatsNewDialog` composite component with markdown rendering
  - React SDK: `WhatsNewTrigger` atomic button with notification badge
  - Terraform: GitHub token secret for API authentication
  - Release body format: `<!-- whats-new -->` tags for user-visible content, `<!-- image: KEY -->` for R2 images
  - First-time visitors: No auto-open; only shows after user has dismissed once

## [0.0.40] - 2026-01-24

### Changed

- **Transcript panel redesign** - Complete UI overhaul for the transcription experience
  - **Speaker experience**: Avatars with initials, role badges (Host/You), speaker grouping with turn separators
  - **Search & navigation**: Cmd/Ctrl+F shortcut, text highlighting, match counter (N of M), prev/next navigation
  - **Real-time polish**: Typing dots for interim transcripts, subtle pulse animation, slide-in entry animations
  - **Export dropdown**: Download as TXT/SRT/VTT/JSON, copy all to clipboard
  - **Empty state**: Illustration with animated dots waiting indicator
  - **Low confidence visualization**: Dotted underlines with warning icon for uncertain text
  - **Click-to-copy timestamps**: Click timestamp to copy to clipboard
  - `useTranscripts` hook: Added `copyToClipboard()`, `downloadTranscript()`, JSON export format

## [0.0.39] - 2026-01-23

### Added

- **Meeting End page** - Post-meeting summary screen at `/room/end`
  - Shows meeting duration and participant count (from localStorage data)
  - Star rating feedback form with hover interactions
  - Action buttons: Rejoin, New Meeting, Home
  - Follows app theme system (light/dark mode support)
  - Room page now navigates here on meeting end

- **shadcn/ui components** - Added base-nova style shadcn components
  - Button, Card, Input, Badge, Tooltip, Toggle, ToggleGroup
  - Available via `ui` namespace: `import { ui } from '@q9labs/chalk-react'`
  - Uses `@base-ui/react` primitives with `class-variance-authority`
  - MeetingRoom layout switcher now uses shadcn Toggle + Tooltip
  - ChatPanel and ParticipantList use shadcn Button

- **Live transcription support** - Enables transcription via Cloudflare RealtimeKit presets
  - Backend: `transcription_enabled` field now sent to Cloudflare `AddParticipant` when tenant config has it enabled
  - React SDK: `onEnd` callback on `VideoConference` fires when meeting ends (leave or disconnect)
  - `MeetingEndData` includes `transcripts`, `duration`, `recordingId`, `participantCount` for consumers to persist

- **Role support for participants** - Added `role` prop to control participant permissions
  - SDK Core: `JoinOptions` and `RoomConfig` now accept `role?: "host" | "participant"`
  - React SDK: `VideoConference` accepts `role` prop, passed through to join
  - Host role triggers `force_recording` when configured in tenant settings

- **Auto-host for first participant** - New tenant config `first_participant_is_host`
  - When enabled, first participant to join a room automatically becomes host
  - Combined with `force_recording`, this auto-starts recording for every meeting

- **Manual recording recovery endpoint** - `POST /api/v1/recordings/:id/recover`
  - Manually triggers download from Cloudflare and upload to R2
  - Useful for local development where webhooks can't reach localhost
  - Returns recording status from Cloudflare if not yet ready

- **Recording sync from Cloudflare** - `POST /api/v1/rooms/:id/recordings/sync`
  - Imports recordings from Cloudflare that don't exist in our database
  - Handles `record_on_start` auto-recordings that bypassed our API
  - Returns list of synced recordings with their IDs for subsequent recovery

### Changed

- **WhiteboardPanel state persistence** - Close no longer destroys whiteboard state
  - Added `isVisible` prop to control visibility without unmounting
  - MeetingRoom now keeps WhiteboardPanel mounted (hidden) instead of conditional render
  - Drawings persist locally when closing and reopening whiteboard

- **WhiteboardPanel branding** - Removed Excalidraw branding from UI
  - Added `renderTopRightUI: () => null` to hide help button and social links

- **WhiteboardPanel header** - Redesigned with floating glassmorphism pills
  - Removed solid header bar for cleaner canvas-first experience
  - Top-left: Title pill with pencil icon
  - Top-right: Actions pill with permission controls (host) and close button
  - Bottom-left: Status pill showing "You can draw" or "View only" with teal/red indicator dot
  - Matches MeetingRoom aesthetic (backdrop-blur-md, bg-black/50, border-white/10)

- **Favicon** - Updated to Chalk icon (colorful chalk sticks)

- **MeetingRoom UI revamp** - Aligned with PreJoinLobby design patterns
  - Layout switcher: Replaced text buttons with icon buttons (Grid, Spotlight, Sidebar) with tooltips
  - Active layout state uses brand teal (#1bb6a6) background
  - Hand icon: Changed from pointing down to waving hand (raised hand gesture)
  - Muted state: Updated red color from #EF4444 to #dc2626 (darker, more cohesive)
  - Removed "More" and "Info" buttons from desktop ControlBar
  - Side panels: Applied glassmorphism (bg-card/80 backdrop-blur-xl) with rounded-2xl corners

- **Teal-themed color palette** - Updated video tile accents and avatars
  - colorGenerator: Replaced mixed color palettes with teal/cyan spectrum
  - Avatar gradients: Updated pairs to teal-themed options (brand teal, emerald, cyan, etc.)

- **Panel UI modernization** - ChatPanel, TranscriptionPanel, ParticipantsPanel
  - Transparent backgrounds to work with glassmorphic parent container
  - ChatPanel: Teal-themed empty state icon, improved input field with focus ring
  - TranscriptionPanel: Custom teal "Live" badge, styled empty state
  - ParticipantList: Semantic color tokens, teal "Add people" button with shadow

- **Landing page redesign** - Consumer-ready landing page replacing developer-focused design
  - Hero section with inline meeting join flow and `/public/devices-with-video.png` illustration
  - Trust bar with encryption, HD video, browser-based, and free messaging
  - 4 feature cards: Crystal Clear Quality, One-Click Meetings, Private & Secure, Works Everywhere
  - How It Works: 3-step process (Click Start, Share Link, Start Talking)
  - Use Cases: Remote Work, Education, Stay Connected
  - Final CTA section with prominent "Start Your Free Meeting" button
  - Updated primary color to #1bb6a6 (custom teal)
  - Removed developer content (GitHub link, code snippets, SDK references)
  - Start Meeting buttons open room in new tab

- **Theme toggle improvements** - Moved below header (top-20) with higher z-index, replaced lucide Sun/Moon with hugeicons

- **React SDK shadcn migration** - Migrated components to shadcn design patterns
  - **Tier 1 (Atomic)**: Badge, Input, Textarea, Select, Toggle, Tooltip, Toast, ProgressBar, Skeleton, Spinner, IconButton
  - **Tier 2 (Composite)**: ControlButton, StatusBadge, VolumeSlider, InviteModal, SettingsPanel, ChatPanel, TranscriptionPanel, NotificationStack, DeviceSelector, MeetingHeader, MessageBubble, WaitingRoom, BackgroundEffectsPicker, ReactionPicker
  - **Tier 3 (Domain)**: VideoTile, Avatar, TourTooltip, ScreenShareView, MobilePanel, MobileControlSheet
  - New dependencies: `@base-ui/react`, `@hugeicons/react`, `@hugeicons/core-free-icons`, `sonner`, `tw-animate-css`
  - Icon wrapper utility at `src/utils/icons.tsx` for HugeIcons compatibility
  - CSS variables updated to shadcn oklch color system with chalk fallbacks
  - All components maintain backward compatibility with existing APIs
  - Added `toast` export from NotificationStack for programmatic toast triggering

- **CSS consolidated into single styles.css** - Simplified CSS architecture
  - Merged `variables.css`, `base.css`, `animations.css`, `bundled.css` into single `styles.css`
  - Import path: `@q9labs/chalk-react/styles.css`
  - Uses shadcn oklch color system with teal primary (`oklch(0.60 0.10 185)`)
  - Semantic tokens: `--primary`, `--foreground`, `--card`, `--muted`, `--destructive`, `--success`, `--warning`
  - Video-specific variables preserved: `--chalk-bg-stage`, `--chalk-bg-tile`, `--chalk-accent-speaking`, `--chalk-shadow-*`, `--chalk-pill-*`

### Fixed

- **Transcription pipeline** - Fixed end-to-end transcription from Cloudflare RTK to UI
  - Fixed field mapping in `room.ts` - Cloudflare sends `transcript`, `isPartialTranscript`, `peerId`, `name`, `date` but SDK expected `text`, `isInterim`, `participantId`, `speakerName`, `timestamp`
  - Connected `useTranscripts` hook output to `MeetingRoom` component via `VideoConference`
  - Backend persistence: Final transcripts sent to Go API via WebSocket for database storage

- **WhiteboardPanel CSS flash** - Added CSS load tracking to prevent unstyled flash
  - Loader now shows until both Excalidraw and CSS are fully loaded
  - CSS load state tracked via `onload` handler

- **PreJoinLobby theme toggle** - Now syncs with document.documentElement so theme changes work when used within apps that have ThemeProvider

- **Light mode support for panels** - Fixed ParticipantList, ChatPanel, and TranscriptionPanel for light mode:
  - ParticipantList: Replaced hardcoded dark background with semantic `bg-card`
  - TranscriptionPanel: Updated speaker colors from white to colors visible on both light/dark backgrounds

- **Whiteboard canvas** - Now defaults to dark background (#121212) for better drawing experience regardless of app theme

- **RTK room join reliability** - Increased timeout and added retry logic
  - Timeout increased from 10s to 30s per attempt
  - Added exponential backoff retries (500ms, 1s, 2s delays) for up to 4 total attempts
  - Reduces user-facing errors from transient network issues during room join

- **Faster room join** - Parallelized WebSocket and RTK connections
  - WebSocket now connects in parallel with RTK join instead of sequentially
  - Reduced retry delays from (2s, 4s, 8s) to (500ms, 1s, 2s)
  - Saves 100-500ms on typical join, up to 10s on retries

- **Recording recovery for missed webhooks** - Recordings are now automatically recovered when Cloudflare webhook is missed
  - Root cause: `RecordingChecker` job detected ready recordings in Cloudflare but only logged a TODO instead of downloading them
  - Symptom: Recordings stuck in "processing" status forever, video files never persisted to R2
  - Fix: Added `RecoverRecording` method to recording service that downloads from Cloudflare and uploads to R2
  - The background job now automatically recovers stalled recordings older than 1 hour

- **WebSocket heartbeat timeout** - Server now responds to client ping messages with pong
  - Root cause: SDK client sends pings expecting pong response, but server only sent pings (didn't respond to them)
  - Symptom: "Heartbeat timeout - no pong received" after 75 seconds
  - Fix: Added `ping` message handler in WebSocket client that responds with `pong`

## [0.0.38] - 2026-01-21

### Fixed

- **WebSocket heartbeat timeout** - Server now responds to client ping messages with pong
  - Root cause: SDK client sends pings expecting pong response, but server only sent pings (didn't respond to them)
  - Symptom: "Heartbeat timeout - no pong received" after 75 seconds
  - Fix: Added `ping` message handler in WebSocket client that responds with `pong`

### Changed

- **React SDK visual polish** - Refined design system for a more premium, polished feel
  - **Color palette**: Richer dark mode with subtle blue/purple undertones (`#0A0A0C`, `#12121A`)
  - **Glass effects**: New CSS variables for backdrop-blur surfaces (`--chalk-bg-glass`, `--chalk-bg-control`)
  - **Control buttons**: Glass morphism with layered shadows and smooth hover scale (1.04x)
