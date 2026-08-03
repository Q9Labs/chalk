# Changelog

All notable public changes to this project will be documented in this file.

This changelog starts from the public-source cleanup. Earlier internal release
notes were archived privately before publication because they included
deployment, customer, and incident-specific detail that is not appropriate for a
public repository.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Added independently composable palette and texture options to the React
  `ConferenceView`, including seven dark palettes plus clean, paper, and slate
  materials, and made the SDK preview open the active collaboration surface
  directly for visual comparison.
- Consolidated the React UI primitives under `@q9labsai/chalk-ui`, preserving the
  public SDK subpath while aligning shared styling with the paper, cool-neutral,
  watercolor, and chalk-stick design language.

### Breaking

Phase 1 unifies the published TypeScript SDK vocabulary. Historical names are
removed without compatibility aliases.

| Package                        | Old export                                 | New export                           |
| ------------------------------ | ------------------------------------------ | ------------------------------------ |
| `@q9labsai/chalk-react`        | `SessionMeetingRoom`                       | `MeetingRoom`                        |
| `@q9labsai/chalk-react`        | `SessionMeetingRoomProps`                  | `MeetingRoomProps`                   |
| `@q9labsai/chalk-react-native` | `ChalkNativeProvider`                      | `ChalkProvider`                      |
| `@q9labsai/chalk-react-native` | `ChalkNativeProviderProps`                 | `ChalkProviderProps`                 |
| `@q9labsai/chalk-react-native` | `createChalkNativeSession`                 | `createChalkSession`                 |
| `@q9labsai/chalk-react-native` | `ChalkNativeSessionOptions`                | `ChalkSessionOptions`                |
| `@q9labsai/chalk-react-native` | `createChalkClientSession`                 | `createClientSession`                |
| `@q9labsai/chalk-react-native` | `ChalkClientSession`                       | `ClientSession`                      |
| `@q9labsai/chalk-react-native` | `ChalkClientSessionCredential`             | `ClientSessionCredential`            |
| `@q9labsai/chalk-react-native` | `CreateChalkClientSessionOptions`          | `CreateClientSessionOptions`         |
| `@q9labsai/chalk-react-native` | `ChalkClientSessionError`                  | `ClientSessionError`                 |
| `@q9labsai/chalk-react-native` | `uploadNativeChatAttachment`               | `uploadChatAttachment`               |
| `@q9labsai/chalk-react-native` | `NativeChatAttachmentFile`                 | `ChatAttachmentFile`                 |
| `@q9labsai/chalk-react-native` | `UploadNativeChatAttachmentOptions`        | `UploadChatAttachmentOptions`        |
| `@q9labsai/chalk-react-native` | `createNativeTelemetry`                    | `createTelemetry`                    |
| `@q9labsai/chalk-react-native` | `NativeTelemetryJourney`                   | `TelemetryJourney`                   |
| `@q9labsai/chalk-react-native` | `NativeWhiteboardMetric`                   | `WhiteboardMetric`                   |
| `@q9labsai/chalk-react-native` | `NativeSessionTelemetry`                   | `SessionTelemetry`                   |
| `@q9labsai/chalk-react-native` | `NativeRtcPeerConnection`                  | `RtcPeerConnection`                  |
| `@q9labsai/chalk-react-native` | `NativeTelemetry`                          | `Telemetry`                          |
| `@q9labsai/chalk-react-native` | `nativeCallKit`                            | `callKit`                            |
| `@q9labsai/chalk-react-native` | `NativeCallKitCallOptions`                 | `CallKitCallOptions`                 |
| `@q9labsai/chalk-react-native` | `NativeCallKitConfiguration`               | `CallKitConfiguration`               |
| `@q9labsai/chalk-react-native` | `NativeCallKitEndCallOptions`              | `CallKitEndCallOptions`              |
| `@q9labsai/chalk-react-native` | `NativeCallKitEndReason`                   | `CallKitEndReason`                   |
| `@q9labsai/chalk-react-native` | `NativeCallKitEvent`                       | `CallKitEvent`                       |
| `@q9labsai/chalk-react-native` | `NativeCallKitHandleType`                  | `CallKitHandleType`                  |
| `@q9labsai/chalk-react-native` | `NativeVideoConferenceCallKitOptions`      | `VideoConferenceCallKitOptions`      |
| `@q9labsai/chalk-react-native` | `NativeEndScreen`                          | `EndScreen`                          |
| `@q9labsai/chalk-react-native` | `NativeEndScreenProps`                     | `EndScreenProps`                     |
| `@q9labsai/chalk-react-native` | `NativeMeetingEndData`                     | `MeetingEndData`                     |
| `@q9labsai/chalk-react-native` | `NativeJoiningLoadingScreen`               | `JoiningLoadingScreen`               |
| `@q9labsai/chalk-react-native` | `NativeJoiningLoadingScreenProps`          | `JoiningLoadingScreenProps`          |
| `@q9labsai/chalk-react-native` | `NativeMediaView`                          | `MediaView`                          |
| `@q9labsai/chalk-react-native` | `NativeMeetingRoom`                        | `MeetingRoom`                        |
| `@q9labsai/chalk-react-native` | `NativeMeetingRoomDiagnosticsSnapshot`     | `MeetingRoomDiagnosticsSnapshot`     |
| `@q9labsai/chalk-react-native` | `NativeMeetingRoomFeatures`                | `MeetingRoomFeatures`                |
| `@q9labsai/chalk-react-native` | `NativeMeetingRoomProps`                   | `MeetingRoomProps`                   |
| `@q9labsai/chalk-react-native` | `NativePreJoinLobby`                       | `PreJoinLobby`                       |
| `@q9labsai/chalk-react-native` | `NativePreJoinLobbyProps`                  | `PreJoinLobbyProps`                  |
| `@q9labsai/chalk-react-native` | `NativeJoinSettings`                       | `JoinSettings`                       |
| `@q9labsai/chalk-react-native` | `NativeVideoConference`                    | `VideoConference`                    |
| `@q9labsai/chalk-react-native` | `NativeMeetingJoinedData`                  | `MeetingJoinedData`                  |
| `@q9labsai/chalk-react-native` | `NativeVideoConferenceDiagnosticsSnapshot` | `VideoConferenceDiagnosticsSnapshot` |
| `@q9labsai/chalk-react-native` | `NativeVideoConferencePhase`               | `VideoConferencePhase`               |
| `@q9labsai/chalk-react-native` | `NativeVideoConferenceProps`               | `VideoConferenceProps`               |
| `@q9labsai/chalk-react-native` | `NativeReactionPicker`                     | `ReactionPicker`                     |
| `@q9labsai/chalk-react-native` | `NativeFaceAvatar`                         | `FaceAvatar`                         |
| `@q9labsai/chalk-react-native` | `NativeGradientSurface`                    | `GradientSurface`                    |
| `@q9labsai/chalk-react-native` | `NativeRtcVideoView`                       | `RtcVideoView`                       |
| `@q9labsai/chalk-react-native` | `NativeChatMessageList`                    | `ChatMessageList`                    |
| `@q9labsai/chalk-react-native` | `NativePlatformVariant`                    | `PlatformVariant`                    |
| `@q9labsai/chalk-react-native` | `resolveNativePlatformVariant`             | `resolvePlatformVariant`             |
| `@q9labsai/chalk-react-native` | `NativeDeviceInfo`                         | `DeviceInfo`                         |
| `@q9labsai/chalk-react-native` | `getNativeDeviceInfo`                      | `getDeviceInfo`                      |
| `@q9labsai/chalk-react-native` | `NativeClipboardReader`                    | `ClipboardReader`                    |

The React Native root no longer exports `useNativeTelemetry`, `useChat`,
`useConnection`, `useInteractions`, `useLayout`, `useMedia`, `usePanels`,
`useRoom`, `useScreenShare`, or `useWhiteboard`, nor their `UseXReturn` types.
Those feature hooks remain internal. The root now exposes the canonical hook set
and adds `useChalkSnapshot`, `useChalkSelector`, `useChalkActions`,
`useParticipants`, `useLocalMedia`, `useRemoteMedia`, and
`useChalkWhiteboardTransport` with the React package's store semantics.

Phase 2 completes the join-settings vocabulary across the React and React
Native packages. The exported settings type and media fields now use the same
names in both packages.

| Package                        | Old export or field         | New export or field                 |
| ------------------------------ | --------------------------- | ----------------------------------- |
| `@q9labsai/chalk-react-native` | `JoinSettings`              | `PreJoinSettings`                   |
| `@q9labsai/chalk-react-native` | `JoinSettings.audioEnabled` | `PreJoinSettings.microphoneEnabled` |
| `@q9labsai/chalk-react-native` | `JoinSettings.videoEnabled` | `PreJoinSettings.cameraEnabled`     |

Phase 5 adopts the canonical component vocabulary across the React and React
Native packages. These are breaking export and prop renames; no compatibility
aliases are retained.

| Package                        | Old export or prop                   | New export or prop                          |
| ------------------------------ | ------------------------------------ | ------------------------------------------- |
| `@q9labsai/chalk-react`        | `MeetingRoom`                        | `ConferenceView`                            |
| `@q9labsai/chalk-react`        | `MeetingHeader`                      | `ConferenceHeader`                          |
| `@q9labsai/chalk-react`        | `MeetingHub`                         | `ConferenceInfoDialog`                      |
| `@q9labsai/chalk-react`        | `PreJoinLobby`                       | `PreJoinScreen`                             |
| `@q9labsai/chalk-react`        | `LoadingScreen`                      | `JoiningScreen`                             |
| `@q9labsai/chalk-react`        | host-facing `WaitingRoom`            | `AdmissionPanel`                            |
| `@q9labsai/chalk-react`        | `VideoGrid`                          | `ParticipantGrid`                           |
| `@q9labsai/chalk-react`        | `VideoTile`                          | `ParticipantTile`                           |
| `@q9labsai/chalk-react`        | `WhiteboardPanel`                    | `WhiteboardView`                            |
| `@q9labsai/chalk-react`        | panel `ParticipantList`              | `ParticipantsPanel`                         |
| `@q9labsai/chalk-react`        | `TranscriptionPanel`                 | `TranscriptPanel`                           |
| `@q9labsai/chalk-react`        | `ControlButton`                      | `ControlBarButton`                          |
| `@q9labsai/chalk-react`        | `DeviceControlButton`                | `DevicePopover`                             |
| `@q9labsai/chalk-react`        | `InviteModal`                        | `InviteDialog`                              |
| `@q9labsai/chalk-react`        | `LeaveConfirmationDialog`            | `LeaveDialog`                               |
| `@q9labsai/chalk-react`        | `ConnectionLostOverlay`              | `ReconnectingOverlay`                       |
| `@q9labsai/chalk-react`        | `NotificationStack` / `Notification` | `ToastStack` / `Toast`                      |
| `@q9labsai/chalk-react`        | `AudioRenderer`                      | `AudioOutput`                               |
| `@q9labsai/chalk-react`        | `LayoutSwitcher`                     | `LayoutPicker`                              |
| `@q9labsai/chalk-react`        | `IncomingMediaRequestDialog`         | `MediaRequestDialog`                        |
| `@q9labsai/chalk-react`        | `SplitStage`                         | one Stage with a Layout                     |
| `@q9labsai/chalk-react`        | `/atomic`, `/composite`, `/full`     | explicit `/components` exports              |
| `@q9labsai/chalk-react`        | `layout: spotlight` / `screen-share` | `layout: focus` / `presentation`            |
| `@q9labsai/chalk-react`        | `layout: sidebar`                    | `layout: focus` plus Filmstrip              |
| `@q9labsai/chalk-react`        | `variant: dock`                      | `placement: floating`                       |
| `@q9labsai/chalk-react`        | `DevicePopover.appearance: dock`     | `appearance: floating`                      |
| `@q9labsai/chalk-react`        | `variant: mobile`                    | `placement: floating`, `density: compact`   |
| `@q9labsai/chalk-react`        | default `variant`                    | `placement: inline`, `density: comfortable` |
| `@q9labsai/chalk-react-native` | `MeetingRoom`                        | `ConferenceView`                            |
| `@q9labsai/chalk-react-native` | `PreJoinLobby`                       | `PreJoinScreen`                             |
| `@q9labsai/chalk-react-native` | `JoiningLoadingScreen`               | `JoiningScreen`                             |
| `@q9labsai/chalk-react-native` | `MeetingRoomDiagnosticsSnapshot`     | `ConferenceViewDiagnosticsSnapshot`         |
| `@q9labsai/chalk-react-native` | `MeetingRoomFeatures`                | `ConferenceViewFeatures`                    |
| `@q9labsai/chalk-react-native` | `MeetingRoomProps`                   | `ConferenceViewProps`                       |
| `@q9labsai/chalk-react-native` | diagnostics field `meetingRoom`      | `conferenceView`                            |
| `@q9labsai/chalk-react-native` | `layout: speaker` / `sidebar`        | `layout: focus` plus Filmstrip              |

Phase 6 makes the React package's turnkey surface and active composition
concrete. `VideoConference` now owns the embedded lifecycle and exports from
the package root with `ChalkProvider` and the canonical session hooks. The
props-driven `ConferenceView` and all composable visuals are available from
`@q9labsai/chalk-react/components`; the old root component exports and
provider-wired active view are removed.

The client snapshot still does not expose an admission-wait status. React
therefore observes the canonical `waiting` phase for controlled/runtime input
but renders `JoiningScreen` until the client can distinguish waiting from an
ordinary join attempt. Host admission remains available through
`AdmissionPanel` in the active composition.

### Added

- One-command local core and mobile development profiles. `pnpm dev` starts
  the Postgres-backed API and Sync path, local Worker broker, web, SDK
  watchers, observability, and real Cloudflare SFU media on localhost, with
  status, logs, smoke, stop, fixture refresh, and destructive reset commands.

- Added bounded, parent-linked Chalk join traces covering media permission,
  participant access, media and Sync startup, the Sync-live wait, and terminal
  outcomes without recording media, tokens, SDP, or room identity.

- A shared client `ConferencePhase` derivation primitive and tested internal lifecycle hooks for React and React Native, preserving the existing UI phase surfaces and public component APIs.
- A single light-first Chalk design system for marketing, lobby, meeting, SDK,
  and mobile surfaces, with normative tokens, component and layout rules,
  accessibility guidance, and a high-fidelity visual reference board.
- React Native and mobile parity with Chalk v2: canonical `ChalkSession` and
  SyncEngine v1 ownership, native client-session broker routes, Cloudflare
  WebRTC media, moderation, reactions, hand raising, protected chat files,
  whiteboard, screen sharing, durable telemetry, resumable mobile sessions,
  and production Android and iOS release surfaces without the legacy
  RealtimeKit runtime.
- A shared, fail-closed Sync reliability harness with pull-request correctness,
  nightly multi-node/network/PostgreSQL failover, and release soak, restart, and
  real-browser profiles; every run emits replayable commit-bound evidence.
- Chalk room actions across Sync v1 and the public TypeScript/React SDKs:
  transient reactions, durable paged Postgres chat with read receipts and
  protected file attachments, host moderation and ask-to-unmute/start-camera
  flows, plus a separate `whiteboard-v1` Excalidraw transport with staged
  participant-authenticated file uploads and seven-day cleanup. Native hosts
  now have a pinned offline Excalidraw renderer and public React Native bridge;
  first-party live exposure remains gated on the canonical session store.
- Atomic multipart `whiteboard-v1` updates that retain the 128-element and
  256-KiB frame bounds while carrying logical operations of up to 10,000
  elements and 16 MiB, with timeout recovery through canonical snapshots.
- A public Pages meeting entry that starts a capability-secured meeting from the
  restored React SDK lobby and supports invite-link guests, host refresh, live
  participant updates, Cloudflare media, and terminal Leave cleanup.
- Production meeting launch infrastructure for the restored web experience,
  including a capability-secured Cloudflare broker, rootless managed runtime
  artifacts for the API and Sync services, and canonical web, API, Sync, and
  broker availability monitors.
- Production Podman 4.9 Quadlet compatibility for the managed runtime,
  including complete Redis no-snapshot command rendering and a watchdog
  sandbox that runs under the rootless user manager.
- A meeting-only production API profile that preserves fail-closed defaults
  while allowing unrelated integrations and transcription capabilities to be
  explicitly disabled for the initial hosted meeting release.
- Connected React SDK meeting experience restored from the original Chalk design,
  including a device-aware prejoin lobby, responsive live meeting shell, layout
  controls, participant list, invitations, remote audio playback, camera-independent
  screen sharing, configurable branding, and leave flows.
- Polished React meeting interaction surfaces with compact device and participant
  menus, reserved in-call controls, meeting information and settings dialogs,
  realistic screen-share preview, Chalk-themed Excalidraw, notification previews,
  simplified prejoin media state, and quieter participant indicators.
- Managed web SDK launch surface with scoped tenant API-key lifecycle, distinct
  short-lived Sync and media credentials, a server-only Promise client, the
  framework-neutral `ChalkSession` runtime, and React provider and hooks.
- Clean packed-artifact browser proof covering two-party media, screen sharing,
  credential refresh, Sync and SFU recovery, denied access, remote removal, and
  leak-free Leave, plus a public server/browser quickstart.
- Participant-media-only Cloudflare SFU authorization with exact tenant, room,
  session, participant generation, provider, and connection binding.
- A private mutual-TLS Sync-to-API provider bridge that makes participant Leave
  close active Cloudflare publications before Sync finalizes the participant.
- Implementation-ready web SDK launch board with frozen consumer contracts,
  file-level pseudodiffs, dependency-ordered task cards, an interactive
  lifecycle companion, and a packed two-browser release gate.
- Consumer SDK launch audit covering npm availability, missing meeting runtime
  and credential boundaries, stale readiness inventory entries, and the
  install-to-live-call release gate.
- Domain-grouped `product.yaml` and `checklist.md` inventories with 88 evidence-backed boolean capabilities, separating repository implementation from missing end-to-end or production proof.
- Interactive system architecture atlas with drillable product planes,
  end-to-end journey swimlanes, runtime topology, Postgres data domains,
  implementation-status semantics with explicit completion gaps for partial
  work, global search, and accessible keyboard navigation.
- Standalone protected architecture Worker deployment with content-hashed local
  assets, encrypted-secret access-code verification, signed secure sessions,
  native login rate limiting, anonymous-boundary monitoring, and one-command
  deployment integrity verification.
- Recorder pipeline foundation with bounded reservation admission, PostgreSQL
  leased jobs and fencing, mTLS worker identity, encrypted capture bundles,
  deterministic 720p render fixtures, generated API/SDK contracts, public-safe
  pool health checks, and fail-closed recorder infrastructure gates.
- Track-aware asynchronous transcription foundations, including recorder-owned
  source manifests, fenced PostgreSQL artifact and cleanup jobs, private R2
  transcript artifacts, DeepInfra and Cloudflare adapters, and a scale-to-zero
  Lambda dispatcher with deterministic OpenTofu release contracts.
- Tenant-scoped outbound webhooks for the eight core Room, Session, and
  Participant lifecycle events, with durable signed retries and redelivery,
  generated management clients, server-only TypeScript receiver processing,
  and linked journey observability.
- Declarative SyncEngine v1 TypeScript client support for exact four-stream
  recovery, role-derived capabilities, durable target commands, conference
  operations, live media targets, directed consent requests, and isolated web
  and React Native pending-target persistence.
- Declarative SyncEngine v1 server authority for immutable Session policy,
  roles and admission, generation-fenced deadlines, confirmed moderation and
  Recording operations, single-share leases, exact-next live projections, and
  bounded terminal retention on PostgreSQL 18.
- A checksummed four-phase SyncEngine v1 breaker that executes 37 seeded
  durable, provider, delivery, recovery, wire, and production-SDK schedules and
  reproduces the complete semantic artifact twice.
- API-issued five-minute Ed25519 sync participant tokens with fail-closed
  production verification, overlap key rotation, authenticated refresh, and
  generated SDK contracts.
- Public-safe release-topology failure scheduling with validated deterministic
  schedules, local/staging execution safeguards, and sanitized evidence
  bundles.
- Test-only sync breaker harness with deterministic model histories, real
  WebSocket campaigns, controlled writer faults, replay-ready JSONL traces, and
  failure-first Markdown reports.
- End-to-end observability v1 across the TypeScript client, Go API, Elixir sync
  server, Cloudflare provider adapters, durable journey ledger, OpenTelemetry
  signals, and a provisioned local Grafana/Tempo/Prometheus/Loki surface with
  critical pipeline alerts and a reproducible full-journey proof.
- Development-only sync server lab that starts empty and exercises live
  WebSocket participants, shared state, raw protocol frames, reconnects,
  redacted human-readable traces, and production failure drills.
- OpenRouter BYOK transcription support in the Go API, including a tenant
  `ai_provider_config` path, OpenRouter adapter, recording transcription route,
  and trace harness scenario.
- Go API database foundation for external integrations, including provider/service
  connection records for Composio-backed integrations.
- npm publish workflow and package metadata for publishing the public SDK
  packages under the `@q9labsai` scope.
- Resend-backed outbound email adapter foundation for the Go API, including a
  provider-neutral email port and env-based Resend configuration.
- Cloudflare R2-backed object storage adapter foundation for Go API media,
  image, and file objects.
- Local Redis and combined Postgres/Redis service helpers for Go API
  development.
- MIT license metadata across the workspace.
- Private language-neutral contract codegen with a validated canonical IR,
  reproducible frontend comparison, generated OpenAPI/TypeScript/Effect output,
  generated TypeScript and Elixir sync bindings, and non-mutating drift checks.
- Generic Go API logging/observability hooks and local performance harness for
  request, database, lifecycle, and footprint profiling.
- Go API Execution Trace Harness with a colorized local `tenant-create`
  scenario for reviewing a full HTTP-to-service-to-repository flow as a
  timeline.
- Go API tenant-scoped routes for rooms, room sessions, recordings,
  transcripts, and audit logs, plus tenant provider configuration fields for
  media plane, AI, and storage integrations.
- Public-safe scratchpad structure for architecture decisions, debugging
  lessons, deployment lessons, and summarized session memory.
- Public repository hygiene guidance for keeping raw logs, generated debug
  bundles, production identifiers, and private operational runbooks out of
  tracked source.

### Changed

- Redesigned the public marketing site, reusable React prejoin lobby, and live
  meeting room around Chalk's light brand palette, a speaker-first stage,
  responsive setup and non-overlapping call controls, flat participant colors,
  refined People and Chat panels, and consistent light menus, dialogs, and
  fields without decorative eyebrow labels.
- Replaced the mobile app's placeholder native meeting adapter with the
  RealtimeKit admission and media runtime; features that require canonical
  Chalk session authority remain explicitly unavailable instead of silently
  degrading.
- Made terminal Cloudflare SFU cleanup production-safe by accepting expired
  sessions as already absent, allowing the provider's documented connection
  wait, and keeping Sync readiness responsive during durable provider work.
- Made the scratch-based production API healthcheck use Podman's exec-form
  array so container health runs without requiring `/bin/sh` in the image.
- Made legacy Session deadline claiming compatible with Sessions created before
  Sync control records existed, and updated affected Go and Elixir dependencies
  to patched releases.
- Made the localhost web demo assign the first participant as host and made SFU
  track responses project authoritative local locations so SDK publishing can
  complete against Cloudflare's location-less provider response.
- Replaced the first-party web room's direct token, Sync, and SFU orchestration
  with the public Chalk client and React SDK surfaces and a localhost-only
  server boundary that keeps tenant credentials out of the browser.
- Made Cloudflare track closure idempotent and authoritative: provider-confirmed
  removals update publication observations, while incomplete provider responses
  fail closed.
- Replaced the always-full local gate and partial PR checks with one
  context-aware contract that reports its decisions, follows affected
  workspace dependents, includes Go and Elixir service-backed gates, runs tests
  once with coverage, and retains nightly and release full verification.
- Replaced stale readiness claims in the root docs and web marketing surface with current implementation boundaries, open product gaps, and target-only performance language.
- Replaced synchronous application-node OpenRouter transcription with an
  API-owned artifact lifecycle and short-lived, job-scoped worker authority.
- Tightened API and service completion rules around end-to-end observability,
  uptime-monitor registration, and consumer SDK support, while removing stale
  implementation and store-review documentation.
- Made sync-breaker snapshot-boundary verification audit the complete persisted
  event stream in bounded pages and retain event/head evidence before replica
  convergence checks.
- Made Session creation, participant admission and removal, and Session end
  share the sync authority boundary through atomic lifecycle transactions with
  durable request-key idempotency.
- Upgraded the web app build stack to Vite 8.1, including compatible React,
  TanStack Start, Nitro, and Cloudflare Vite plugins plus native Vite tsconfig
  path resolution.
- Moved shared UI background and sound asset delivery to the Cloudflare R2 CDN
  surface at `assets.chalkmeet.com`, leaving `@q9labsai/chalk-ui/assets` to
  export CDN metadata instead of bundled media binaries.
- Replaced the first-pass generic shared UI backgrounds with six generated,
  video-call-oriented backgrounds and documented the reusable generation prompt.
- Renamed the Cloudflare uptime monitor package to `@chalk/uptime-worker`,
  wired it into workspace gates, and hardened its ingest fallback alerting,
  storage failure handling, and manual run authentication.
- Hardened the Go API HTTP edge with protected resource routes, tenant
  authorization checks, Redis-backed public auth and authenticated-write rate
  limiting, trusted proxy client-IP handling, request body limits, production
  database TLS guardrails, safer diagnostics mounting, and escaped Cloudflare
  provider paths.
- Migrated Go API v1 route registration to declarative endpoint contracts for
  auth, users, memberships, rooms, recordings, transcripts, audit logs,
  integrations, and contract generator previews.
- Reorganized customer SDKs under `sdks/typescript`, extracted shared assets to
  `packages/assets`, moved whiteboard sources to `packages/whiteboard`, and kept
  existing public npm package names and UI asset compatibility exports.
- Moved reusable React whiteboard rendering, collaboration lifecycle, file sync,
  and math authoring into `@q9labsai/chalk-whiteboard/react`, leaving the React
  SDK to provide meeting composition and Chalk-specific presentation.
- Replaced private historical scratchpad entries with curated public summaries.
- Replaced internal agent/runbook guidance with public contributor guidance.
- Renamed public package scopes from `@q9labs/*` to `@q9labsai/*` for npm.

### Fixed

- Accepted committed Sync acknowledgements and matching terminal control events
  as final proof for participant Leave and Session end when the initiating
  client is removed before a final acknowledgement, and skipped redundant
  participant Leave after a confirmed Session end.
- Preserved terminal lifecycle confirmation across native Sync closure by
  retaining terminal control events until their exact delivery acknowledgement,
  draining final frames before teardown, and accepting authoritative terminal
  recovery heads for participant Leave and Session end.
- Made resumed mobile client-session keys compatible with Expo SecureStore so
  Android and iOS can persist broker credentials without rejecting invite-token
  keys.
- Made React Native Sync snapshot verification portable beyond Web Crypto,
  preserved the primary join failure when durable cleanup could not be
  confirmed, removed stale mobile broker credentials after failed joins, kept
  bounded mobile telemetry local when no supported intake credential exists,
  and added bounded native Sync WebSocket close diagnostics.
- Gave React Native Sync startup a 30-second budget while preserving the
  10-second web and client default, allowing Android to retry after its native
  WebSocket connection attempt times out.
- Kept incremental screen-share publication and remote-track discovery failures
  scoped to the affected media operation so an SFU signaling rejection no
  longer forces every participant into whole-session recovery. Screen retries
  now reuse one logical provider track identity, roll back failed local offers,
  and skip initial-connection waits on an already-live peer. Cloudflare SFU
  failures now expose only bounded stage, status, and provider-code telemetry
  while keeping SDP, provider descriptions, secrets, and media identifiers out
  of logs, spans, metrics, and consumer responses.
- Made live camera and microphone controls reach the configured provider bridge,
  carry the active participant generation, and confirm browser-owned publication
  grants without an unnecessary Cloudflare mutation. Browser preflight now also
  permits the `PUT` requests used to close active SFU tracks. The web client
  waits for Cloudflare peer and ICE connectivity before issuing follow-up media
  operations, uses explicit no-renegotiation track closure, and assigns a fresh
  provider track identity to every publication attempt. Cloudflare add-track
  responses now fail closed on sanitized provider, per-track, duplicate,
  missing, or unexpected results instead of discarding provider error fields.
- Kept microphone and camera commands pending through bounded transient Sync
  provider failures instead of rejecting them after a few hundred milliseconds.
  Confirmed disables now retire the browser sender without repeating the
  provider close that Sync already completed, and the server-confirmation
  deadline no longer races authorized local media work.
- Reused each local media source's transceiver and MID across microphone,
  camera, and screen-share disable and re-enable cycles. Temporary disables now
  detach the sender without accumulating stopped SDP media sections, while
  every republish still receives a fresh provider track identity and failed
  attempts roll back to a detached reusable sender.

### Removed

- An unpublished earlier SyncEngine implementation and its generated
  contracts, server transport, breaker harness, tests, and TypeScript client
  and persistence surfaces were removed before the current v1 surface.
- Raw scratchpad session logs, local upload artifacts, private agent skills, and
  internal release archaeology from the tracked tree.
