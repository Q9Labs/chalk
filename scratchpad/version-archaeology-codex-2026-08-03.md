# Chalk version archaeology report

Status: done for static source archaeology. No files were edited and no Git operations were run. No live endpoint or test suite was executed because this was explicitly read-only.

## Executive findings

- Chalk has a real top-level Sync v1 implementation in `apps/sync`.
- There is no top-level Sync v2 implementation in the current tree.
- The active top-level Sync implementation is v3, exposed at `/v3/sync`, with frame field `"protocol": 3`.
- The TypeScript SDK has no v1 Sync client class, but it still ships generated v1 wire bindings through the public `@q9labsai/chalk-client/effect` entrypoint.
- Current Sync v3 still contains a reachable `room_actions_v1` compatibility extension and falls back from `room_actions_v2` to it.
- API `/v1`, whiteboard v1, webhook v1, internal `/internal/v1`, telemetry v1, and several schema/manifest v1 markers are independent version surfaces.
- Recommendation: remove top-level Sync v1 and the `room_actions_v1` fallback, then rename top-level Sync v3 to v1 while retaining an explicit `/v1/sync` route. Do not automatically renumber internal state schema versions.

## 1. Inventory of versioned surfaces

### Top-level Sync protocol

| Surface                     | Verified markers                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Legacy Sync v1 schema       | `contract/schema/sync-v1.json`: `$schema = chalk.sync.v1`, `"version": 1`, frame `"protocol": 1`                   |
| Active Sync v3 schema       | `contract/schema/sync-v3.json`: `$schema = chalk.sync.v3`, `"version": 3`, frame `"protocol": 3`, route `/v3/sync` |
| Elixir v1 generated binding | `apps/sync/lib/chalk_sync/contract/generated.ex`                                                                   |
| Elixir v3 generated binding | `apps/sync/lib/chalk_sync/contract/generated_v3.ex`                                                                |
| Elixir v1 protocol adapter  | `apps/sync/lib/chalk_sync/protocol.ex`                                                                             |
| Elixir v3 protocol adapter  | `apps/sync/lib/chalk_sync/protocol_v3.ex`                                                                          |
| Elixir v1 socket            | `apps/sync/lib/chalk_sync/transport/socket.ex`                                                                     |
| Elixir v3 socket            | `apps/sync/lib/chalk_sync/transport/socket_v3.ex`                                                                  |
| v1 route                    | `apps/sync/lib/chalk_sync/transport/router.ex`, `/v1/sync`                                                         |
| v3 route                    | `apps/sync/lib/chalk_sync/transport/router.ex`, `/v3/sync`                                                         |
| v1 enablement               | `apps/sync/config/config.exs`, `enable_v1: true`; `apps/sync/config/runtime.exs` disables it in production         |
| Code generation             | `tools/contract-codegen/src/emitters/sync-contract.mjs`, `sync-elixir.mjs`, `sync-typescript.mjs`                  |
| Codegen environment         | `CODEGEN_SYNC_PROTOCOL_VERSION`, accepted values are only `1` and `3`                                              |
| Generated TypeScript v1     | `sdks/typescript/client/src/generated/sync.ts`                                                                     |
| Generated TypeScript v3     | `sdks/typescript/client/src/generated/sync-v3.ts`                                                                  |
| Codegen orchestration       | `scripts/codegen/generate-sdk.sh`, `scripts/codegen/check-sdk-generated.sh`                                        |
| Codegen tests               | `tools/contract-codegen/test/sync-codegen.test.mjs`                                                                |
| v3 fixtures                 | `contract/schema/fixtures/sync-v3/golden-frames.json`, `contract/schema/fixtures/sync-v3/invalid-frames.json`      |

There is no `sync-v2.json`, `generated_v2.ex`, `sync-v2.ts`, `ProtocolV2`, `SocketV2`, or `/v2/sync`.

### HTTP API route versions

The Go API mounts all public customer routes under `/v1` in `apps/api/internal/httpapi/router.go`.

The public route implementations are in:

```text
apps/api/internal/httpapi/api_keys.go
apps/api/internal/httpapi/audit_logs.go
apps/api/internal/httpapi/auth.go
apps/api/internal/httpapi/chat_attachments.go
apps/api/internal/httpapi/integrations.go
apps/api/internal/httpapi/journeys.go
apps/api/internal/httpapi/me.go
apps/api/internal/httpapi/memberships.go
apps/api/internal/httpapi/participant_access.go
apps/api/internal/httpapi/recording_pipeline.go
apps/api/internal/httpapi/recordings.go
apps/api/internal/httpapi/rooms.go
apps/api/internal/httpapi/session_lifecycle.go
apps/api/internal/httpapi/sfu_signaling.go
apps/api/internal/httpapi/tenants.go
apps/api/internal/httpapi/transcription_artifacts.go
apps/api/internal/httpapi/transcripts.go
apps/api/internal/httpapi/users.go
apps/api/internal/httpapi/webhook_endpoints.go
apps/api/internal/httpapi/whiteboard_files.go
```

Generated and client-side HTTP surfaces:

```text
contract/generated/openapi.json
sdks/typescript/client/src/generated/http-api.ts
sdks/typescript/client/src/generated/openapi-types.d.ts
sdks/typescript/client/src/media/transport.ts
sdks/typescript/client/src/whiteboard/file-http-transport.ts
```

The Sync token endpoint is itself public API v1:

```text
apps/api/internal/httpapi/session_lifecycle.go
/v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/sync-token
```

Private worker and provider routes use a separate `/internal/v1` namespace:

```text
apps/api/internal/httpapi/provider_operations.go
apps/api/internal/httpapi/recorder_worker.go
apps/api/internal/httpapi/transcription_cleanup.go
apps/api/internal/httpapi/transcription_finalize.go
apps/api/internal/httpapi/transcription_worker.go
apps/sync/lib/chalk_sync/provider_bridge/client.ex
```

These API versions are independent of the Sync WebSocket protocol version.

### Whiteboard v1

Whiteboard is a separate protocol, not legacy top-level Sync v1.

Contracts and generated bindings:

```text
contract/schema/whiteboard-v1.json
apps/sync/lib/chalk_sync/contract/generated_whiteboard_v1.ex
sdks/typescript/client/src/generated/whiteboard-v1.ts
```

Server implementation:

```text
apps/sync/lib/chalk_sync/transport/socket_whiteboard_v1.ex
apps/sync/lib/chalk_sync/whiteboard_v1/fanout.ex
apps/sync/lib/chalk_sync/whiteboard_v1/multipart.ex
apps/sync/lib/chalk_sync/whiteboard_v1/outbound_queue.ex
apps/sync/lib/chalk_sync/whiteboard_v1/postgres_repository.ex
apps/sync/lib/chalk_sync/whiteboard_v1/protocol.ex
apps/sync/lib/chalk_sync/whiteboard_v1/reducer.ex
apps/sync/lib/chalk_sync/whiteboard_v1/repository.ex
apps/sync/lib/chalk_sync/whiteboard_v1/session.ex
apps/sync/lib/chalk_sync/whiteboard_v1/sql.ex
```

Client implementation:

```text
sdks/typescript/client/src/whiteboard/index.ts
sdks/typescript/client/src/whiteboard/v1-client.ts
sdks/typescript/client/src/whiteboard/v1-codec.ts
sdks/typescript/client/src/whiteboard/v1-create.ts
sdks/typescript/client/src/whiteboard/v1-multipart.ts
sdks/typescript/client/src/whiteboard/v1-persistence.ts
sdks/typescript/client/src/whiteboard/file-http-transport.ts
sdks/typescript/client/src/whiteboard/types.ts
sdks/typescript/client/src/session/production.ts
sdks/typescript/react-native/src/session/create-chalk-session.ts
```

The route is `/v1/whiteboard`, and the production session code derives it independently from the Sync URL.

### Webhook v1

Contract and fixtures:

```text
contract/webhooks/v1/README.md
contract/webhooks/v1/event.schema.json
contract/webhooks/v1/fixtures.json
contract/webhooks/v1/journey-events.json
contract/webhooks/v1/signature-vectors.json
```

Go implementation:

```text
apps/api/internal/webhooks/types.go
apps/api/internal/webhooks/events.go
apps/api/internal/webhooks/signing.go
apps/api/internal/webhooks/service.go
apps/api/internal/webhooks/dispatcher.go
apps/api/internal/httpapi/webhooks.go
apps/api/internal/httpapi/webhook_endpoints.go
```

TypeScript implementation:

```text
sdks/typescript/client/src/webhooks/generated/event-v1.ts
sdks/typescript/client/src/webhooks/generated/fixtures-v1.ts
sdks/typescript/client/src/webhooks/types.ts
sdks/typescript/client/src/webhooks/verify.ts
sdks/typescript/client/src/webhooks/validate.ts
sdks/typescript/client/src/webhooks/processor.ts
sdks/typescript/client/src/webhooks/test.ts
```

The webhook signature header uses the independent scheme marker `v1,...`, implemented in:

```text
apps/api/internal/webhooks/signing.go
sdks/typescript/client/src/webhooks/verify.ts
```

### Room-actions extension versions inside Sync v3

This is the most important versioning distinction.

The active Sync v3 protocol negotiates:

```text
room_actions_v2
```

and falls back to:

```text
room_actions_v1
```

Server:

```text
apps/sync/lib/chalk_sync/room_actions.ex
apps/sync/lib/chalk_sync/transport/socket_v3.ex
apps/sync/lib/chalk_sync/contract/generated_v3.ex
```

Client:

```text
sdks/typescript/client/src/sync/v3-client.ts
sdks/typescript/client/src/sync/v3-room-actions.ts
sdks/typescript/client/src/generated/sync-v3.ts
sdks/typescript/client/src/sync/v3-room-actions.test.ts
```

The fallback is reachable. The client initially requests `room_actions_v2`, then retries with `room_actions_v1`, then can fall back to an unextended strict server.

`room_actions_v1` is not top-level Sync protocol v1.

### Observability and correlation fields

The Sync protocol carries no versioned HTTP header.

The shared observability implementation recognizes:

```text
x-chalk-journey-id
traceparent
tracestate
```

in `apps/sync/lib/chalk_sync/observability.ex`.

These are copied into protocol frame fields as `journey_id`, `traceparent`, and `tracestate`. Neither protocol v1 nor v3 uses a version-bearing correlation header.

`apps/sync/README.md` calls this “Observability v1 compatibility,” but that is an observability compatibility label, not the top-level Sync wire version.

### Tokens and claims

The API-issued Sync JWT contains identity, role, generation, lifecycle, issuer, audience, and time claims. It does not contain a Sync protocol version claim.

Relevant files:

```text
apps/api/internal/synctokens/service.go
apps/api/internal/synctokens/verifier.go
apps/api/internal/httpapi/session_lifecycle.go
apps/sync/lib/chalk_sync/auth/jwt_token_verifier.ex
apps/sync/lib/chalk_sync/auth/dev_token_verifier.ex
apps/sync/lib/chalk_sync/auth/claims.ex
```

The Elixir verifiers still accept two authorization envelope shapes:

- legacy capability-only claims
- current role-envelope claims

The capability-only branch is legacy v1 compatibility, even though the JWT itself has no explicit protocol-version field.

### Environment variables

No runtime `CHALK_SYNC_PROTOCOL_VERSION` variable exists.

Relevant environment markers are:

```text
CODEGEN_SYNC_PROTOCOL_VERSION
CHALK_SYNC_URL
CHALK_API_VERSION
CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION
CLOUDFLARE_ADAPTER_CONTRACT_VERSION
DEEPINFRA_MODEL_VERSION_PIN
```

Details:

- `CODEGEN_SYNC_PROTOCOL_VERSION` selects generated Sync v1 or v3 output.
- `CHALK_SYNC_URL` carries the route indirectly as a URL value, currently `/v3/sync`.
- `CHALK_API_VERSION` is a release identifier, not the API route version.
- `CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION` identifies a cryptographic key-ring version.
- `CLOUDFLARE_ADAPTER_CONTRACT_VERSION` identifies an external transcription adapter contract.
- `DEEPINFRA_MODEL_VERSION_PIN` identifies a model/provider version.

### Infrastructure

Current Sync URL consumers:

```text
infrastructure/meeting-broker/wrangler.toml
infrastructure/meeting-broker/README.md
infrastructure/meeting-broker/test/wrangler-e2e.mjs
infrastructure/meeting-broker/test/worker.test.ts
apps/web/README.md
apps/web/scripts/local-chalk-backend.mjs
apps/web/src/lib/chalk-access.test.ts
apps/web/src/routes/room.test.tsx
apps/mobile/src/lib/chalk.test.ts
sdks/typescript/react-native/src/session/create-client-session.test.ts
sdks/typescript/react-native/src/session/create-chalk-session.test.ts
docs/sdk-web-quickstart.md
infrastructure/observability/scripts/e2e.sh
```

Managed deployment compatibility markers:

```text
infrastructure/managed-meeting/scripts/generate-release-manifest
infrastructure/managed-meeting/scripts/validate-runtime
infrastructure/managed-meeting/contracts/release-manifest.schema.json
```

These currently emit and require:

```json
"protocol_compatibility": { "sync": 3 }
```

Release topology markers:

```text
apps/sync/lib/chalk_sync/release_topology/schedule.ex
apps/sync/docs/release-topology-failure-schedule-v1.schema.json
apps/sync/test/fixtures/release_topology/local_schedule_v1.json
apps/sync/test/chalk_sync/release_topology/orchestrator_test.exs
apps/sync/test/chalk_sync/release_topology/schedule_test.exs
```

The checked-in `local_schedule_v1.json` contains `"protocol_version": 2`, while current release tests use `3`. The validator accepts any positive protocol version. This is stale or inconsistent evidence, not a v2 implementation.

No Sync route or protocol marker was found in the OpenTofu modules. The versioned OpenTofu and recorder files are provider/tool/artifact pins:

```text
infrastructure/opentofu/modules/aws-transcription-dispatcher/main.tf
infrastructure/opentofu/modules/aws-transcription-dispatcher/variables.tf
infrastructure/opentofu/modules/aws-transcription-dispatcher/outputs.tf
infrastructure/opentofu/modules/aws-transcription-dispatcher/versions.tf
infrastructure/opentofu/modules/cloudflare-r2-transcription-lifecycle/versions.tf
infrastructure/recorder/versions.tf
infrastructure/recorder/main.tf
infrastructure/recorder/variables.tf
```

## 2. Sync v1/v2 implementation and reachability

### Top-level Sync v1

Yes, it exists in `apps/sync`.

Runtime modules:

```text
apps/sync/lib/chalk_sync/contract/generated.ex
apps/sync/lib/chalk_sync/protocol.ex
apps/sync/lib/chalk_sync/transport/socket.ex
apps/sync/lib/chalk_sync/rooms/room.ex
apps/sync/lib/chalk_sync/rooms/room_server.ex
```

Route:

```text
apps/sync/lib/chalk_sync/transport/router.ex
/v1/sync
```

Reachability:

- Development config enables it through `apps/sync/config/config.exs` and `apps/sync/config/dev.exs`.
- The browser lab connects to it in `apps/sync/priv/lab/app.js`.
- Tests connect to it through the default path in `apps/sync/test/support/test_ws_client.ex`.
- The legacy `mix sync.breaker` tests exercise it.
- Production explicitly sets `enable_v1: false` in `apps/sync/config/runtime.exs`.
- `apps/sync/scripts/sync-node-local.exs` also disables it.
- `infrastructure/observability/scripts/e2e.sh` explicitly sets `enable_v1` to true for its test process, even though that script’s normal URL is `/v3/sync`.

The TypeScript SDK has no old v1 connection class, but its generated v1 wire implementation remains public through:

```text
sdks/typescript/client/src/generated/sync.ts
sdks/typescript/client/src/effect.ts
```

The normal `sdks/typescript/client/src/sync/index.ts` exports only the v3 client surface.

### Top-level Sync v2

No implementation exists.

Evidence:

- No `sync-v2` schema or generated module exists.
- `tools/contract-codegen/src/emitters/sync-contract.mjs` accepts only `1` and `3`.
- `apps/sync/test/chalk_sync/protocol_test.exs` tests protocol `2` as rejected input.
- `CHANGELOG.md` describes SyncEngine v2 as unpublished historical work.
- `docs/contract-codegen.md` incorrectly describes “production protocol version 2 frames”; the actual source and generated production contract are v3.
- `apps/sync/test/fixtures/release_topology/local_schedule_v1.json` contains a stale `protocol_version: 2`, but that is a release-topology fixture, not a protocol implementation.

### Files to delete for top-level Sync v1 removal

The minimum legacy runtime and contract deletion set is:

```text
contract/schema/sync-v1.json
apps/sync/lib/chalk_sync/contract/generated.ex
apps/sync/lib/chalk_sync/protocol.ex
apps/sync/lib/chalk_sync/transport/socket.ex
apps/sync/lib/chalk_sync/rooms/room.ex
apps/sync/lib/chalk_sync/rooms/room_server.ex
apps/sync/lib/chalk_sync/dev_tools.ex
apps/sync/lib/chalk_sync/dev_tools/trace_hub.ex
apps/sync/lib/chalk_sync/dev_tools/trace_socket.ex
apps/sync/priv/lab/app.js
apps/sync/priv/lab/index.html
apps/sync/priv/lab/styles.css
apps/sync/priv/lab/view.js
apps/sync/lib/mix/tasks/sync.breaker.ex
sdks/typescript/client/src/generated/sync.ts
```

Legacy-only tests and support:

```text
apps/sync/test/chalk_sync/protocol_test.exs
apps/sync/test/chalk_sync/transport/socket_test.exs
apps/sync/test/chalk_sync/rooms/room_test.exs
apps/sync/test/chalk_sync/rooms/room_server_test.exs
apps/sync/test/chalk_sync/stateholder/memory_test.exs
apps/sync/test/chalk_sync/scripted_stateholder_test.exs
apps/sync/test/chalk_sync/dev_tools/trace_hub_test.exs
apps/sync/test/chalk_sync/transport/router_operations_test.exs
apps/sync/test/support/scripted_stateholder.ex
```

The old breaker test tree is also legacy top-level Sync v1 code:

```text
apps/sync/test/chalk_sync/sync_breaker/
apps/sync/test/support/sync_breaker/
```

Specifically, that tree contains the old campaign, checker, model, random-wire, scenario, shrinker, report, trace-writer, and wire-actor modules, plus their tests.

These files should not be confused with the active v3 breaker:

```text
apps/sync/lib/mix/tasks/sync.breaker.v3.ex
apps/sync/test/chalk_sync/sync_breaker_v3/
apps/sync/test/support/sync_breaker_v3/
```

### Files that require editing or splitting, not wholesale deletion

These contain both legacy compatibility and current behavior:

```text
apps/sync/lib/chalk_sync/application.ex
apps/sync/lib/chalk_sync/observability.ex
apps/sync/lib/chalk_sync/stateholder.ex
apps/sync/lib/chalk_sync/stateholder/memory.ex
apps/sync/lib/chalk_sync/sessions/reducer.ex
apps/sync/lib/chalk_sync/auth/claims.ex
apps/sync/lib/chalk_sync/auth/dev_token_verifier.ex
apps/sync/lib/chalk_sync/auth/jwt_token_verifier.ex
apps/sync/lib/chalk_sync/transport/router.ex
apps/sync/test/chalk_sync/observability_test.exs
apps/sync/test/chalk_sync/test_ws_client_test.exs
apps/sync/test/support/test_ws_client.ex
apps/sync/config/config.exs
apps/sync/config/dev.exs
apps/sync/config/test.exs
apps/sync/test/chalk_sync_test.exs
```

Required cleanup includes removing:

- old Rooms registry and supervisor startup
- old `RoomServer` health references
- v1 `Stateholder.load/commit/events_since` callbacks
- capability-only authorization branches
- v1 operation-shaped hand command compatibility
- `enable_v1`
- `/dev/lab`, `/dev/traces`, and old room restart tooling
- the default test WebSocket path `/v1/sync`

The independent whiteboard v1 implementation must remain.

### Current `room_actions_v1` legacy

If “all legacy v1/v2 code” includes extension compatibility, remove the `room_actions_v1` fallback from:

```text
apps/sync/lib/chalk_sync/room_actions.ex
apps/sync/lib/chalk_sync/transport/socket_v3.ex
apps/sync/lib/chalk_sync/contract/generated_v3.ex
sdks/typescript/client/src/generated/sync-v3.ts
sdks/typescript/client/src/sync/v3-client.ts
sdks/typescript/client/src/sync/v3-room-actions.test.ts
contract/schema/fixtures/sync-v3/golden-frames.json
contract/schema/fixtures/sync-v3/invalid-frames.json
```

Do not delete the current room-actions implementation wholesale. `room_actions_v2` currently provides attachments and read receipts.

## 3. Blast radius

### Renaming top-level Sync v3 to v1

#### Server and contract

Required changes:

```text
contract/schema/sync-v3.json
contract/schema/fixtures/sync-v3/
apps/sync/lib/chalk_sync/contract/generated_v3.ex
apps/sync/lib/chalk_sync/protocol_v3.ex
apps/sync/lib/chalk_sync/transport/socket_v3.ex
apps/sync/lib/chalk_sync/transport/router.ex
apps/sync/lib/chalk_sync/sessions/command_admission.ex
apps/sync/lib/chalk_sync/sessions/coordinator.ex
apps/sync/lib/chalk_sync/sessions/reducer.ex
apps/sync/lib/chalk_sync/stateholder/identity.ex
apps/sync/lib/chalk_sync/lib/mix/tasks/sync.breaker.v3.ex
```

The likely collision-free sequence is:

1. Delete the old v1 implementation.
2. Rename the current v3 contract and generated bindings to the v1/current names.
3. Rename `/v3/sync` to `/v1/sync`.
4. Rename or remove `ProtocolV3`, `SocketV3`, `GeneratedV3`, and `SyncBreakerV3`.
5. Update all frame literals from `3` to `1`.
6. Update release artifacts and compatibility manifests.

Current v3-specific runtime markers also occur in:

```text
apps/sync/lib/chalk_sync/sessions/reducer.ex
apps/sync/lib/chalk_sync/stateholder/identity.ex
apps/sync/lib/chalk_sync/transport/socket_v3.ex
apps/sync/lib/mix/tasks/sync.release_artifact.ex
apps/sync/lib/chalk_sync/release_topology/schedule.ex
apps/sync/test/support/sync_breaker_v3/campaign.ex
apps/sync/test/support/sync_breaker_v3/oracle.ex
infrastructure/managed-meeting/scripts/generate-release-manifest
infrastructure/managed-meeting/scripts/validate-runtime
infrastructure/managed-meeting/contracts/release-manifest.schema.json
```

#### Client SDK

The v3 client surface is distributed through:

```text
sdks/typescript/client/src/sync/index.ts
sdks/typescript/client/src/sync/v3-client.ts
sdks/typescript/client/src/sync/v3-codec.ts
sdks/typescript/client/src/sync/v3-create.ts
sdks/typescript/client/src/sync/v3-persistence.ts
sdks/typescript/client/src/sync/v3-platform-persistence.ts
sdks/typescript/client/src/sync/v3-reducer.ts
sdks/typescript/client/src/sync/v3-room-actions.ts
sdks/typescript/client/src/sync/v3-types.ts
sdks/typescript/client/src/generated/sync-v3.ts
```

All corresponding `*.test.ts` files require updates.

Cross-package type consumers include:

```text
sdks/typescript/client/src/session/chalk-session.ts
sdks/typescript/client/src/session/dependencies.ts
sdks/typescript/client/src/session/production.ts
sdks/typescript/client/src/session/snapshot.ts
sdks/typescript/client/src/session/types.ts
sdks/typescript/client/src/media/client.ts
sdks/typescript/client/src/media/tracks.ts
sdks/typescript/client/src/media/transport.ts
sdks/typescript/client/src/media/types.ts
sdks/typescript/client/src/room-actions/types.ts
sdks/typescript/client/src/room-actions/wire.ts
sdks/typescript/react-native/src/session/create-chalk-session.ts
tools/sdk-web-consumer-e2e/consumer/protocol.ts
tools/sdk-web-consumer-e2e/consumer/sync-client.ts
```

The URL assertion in `sdks/typescript/client/src/sync/v3-client.ts` currently requires exactly `/v3/sync` and must become `/v1/sync`.

Persistence and digest identifiers also contain v3:

```text
sdks/typescript/client/src/sync/v3-platform-persistence.ts
apps/sync/lib/chalk_sync/sessions/reducer.ex
apps/api/internal/sessionlifecycle/initial_control.go
```

Changing the digest prefix or state schema is a separate compatibility decision. It is not required merely because the transport protocol is renumbered.

#### Apps and tests

Update URLs and V3 naming in:

```text
apps/web/README.md
apps/web/scripts/local-chalk-backend.mjs
apps/web/src/lib/chalk-access.test.ts
apps/web/src/routes/room.test.tsx
apps/mobile/src/lib/chalk.test.ts
sdks/typescript/react-native/src/session/create-client-session.test.ts
sdks/typescript/react-native/src/session/create-chalk-session.test.ts
docs/sdk-web-quickstart.md
```

Sync tests and reliability harnesses:

```text
apps/sync/test/chalk_sync/protocol_v3_test.exs
apps/sync/test/chalk_sync/transport/socket_v3_test.exs
apps/sync/test/chalk_sync/transport/postgres_socket_v3_role_transition_test.exs
apps/sync/test/chalk_sync/transport/postgres_socket_v3_webhook_test.exs
apps/sync/test/support/reliability/wire.ex
apps/sync/test/support/browser/real_browser_fixture.exs
apps/sync/scripts/reliability_harness.mjs
```

The current harness invokes `sync.breaker.v3` and names artifacts `sync-breaker-v3.json`; those names must be updated if the current protocol is rebaselined as v1.

#### Infrastructure

Change the configured URL values in:

```text
infrastructure/meeting-broker/wrangler.toml
infrastructure/meeting-broker/README.md
infrastructure/meeting-broker/test/wrangler-e2e.mjs
infrastructure/meeting-broker/test/worker.test.ts
infrastructure/observability/scripts/e2e.sh
```

The environment variable name `CHALK_SYNC_URL` can remain unchanged.

Managed release validation must change:

```text
infrastructure/managed-meeting/scripts/generate-release-manifest
infrastructure/managed-meeting/scripts/validate-runtime
infrastructure/managed-meeting/contracts/release-manifest.schema.json
```

No change is needed to:

```text
infrastructure/uptime-worker/src/index.ts
infrastructure/managed-meeting/cloudflare/ingress.production.json
```

They monitor unversioned health paths or route the entire Sync hostname.

#### API

The Go API’s public `/v1` routes do not need to change for a Sync v3-to-v1 rename.

The following remain `/v1`:

- public REST API
- Sync token issuance endpoint
- private provider/worker API
- whiteboard file API

The API Sync JWT has no protocol version claim, so token signing and verification do not require a protocol-version change. Only documentation or generated client naming that explicitly describes the Sync URL must change.

### Dropping the URL version segment

If only the endpoint segment is removed:

```text
wss://sync.chalkmeet.com/v3/sync
```

becomes:

```text
wss://sync.chalkmeet.com/sync
```

The same server, client, infrastructure, test, and documentation files change, but the contract route becomes `/sync`.

The wire frame would still need a protocol marker unless a separate negotiation design is introduced:

```json
{ "type": "hello", "protocol": 1 }
```

Dropping the URL segment therefore does not eliminate protocol versioning. It only moves version selection from the URL to the WebSocket frame.

The local consumer fixture already uses `/sync`:

```text
tools/sdk-web-consumer-e2e/consumer/server.mjs
tools/sdk-web-consumer-e2e/consumer/app.tsx
tools/sdk-web-consumer-e2e/consumer/sync-client.ts
```

That fixture is a custom mock server and is not evidence that the production Sync server accepts `/sync`.

## 4. Other version markers that could confuse renumbering

These are real version markers but are not all top-level Sync protocol versions.

### Internal state and identity versions

Keep these conceptually separate unless deliberately changing persisted state semantics:

```text
apps/sync/lib/chalk_sync/sessions/reducer.ex
  @state_schema_version 3
  @digest_prefix "chalk-sync-state-v3"

apps/api/internal/sessionlifecycle/initial_control.go
  controlStateSchemaV3 = 3
  controlStateDigestPrefix = "chalk-sync-state-v3"

apps/api/internal/sessionlifecycle/validation.go
  sessionCreateFingerprintVersion = "session-create/v3"

apps/sync/test/support/sync_breaker_v3/oracle.ex
  schema version 3 and chalk-sync-state-v3 digest prefix

apps/sync/lib/chalk_sync/stateholder/postgres.ex
  @schema_version 3
```

These identify durable state and digest semantics, not necessarily the transport route. Renaming them would require coordinated API/Sync digest changes and persisted-state handling.

### Contract proof artifacts

The frontend proof fixture is still a simplified Sync v1 contract:

```text
contract/schema/proof/chalk.tsp
contract/schema/proof/chalk.json
contract/generated/frontend-proof.ir.json
tools/contract-codegen/src/proof.mjs
tools/contract-codegen/src/contract-ir.mjs
tools/contract-codegen/test/contract-ir.test.mjs
```

The proof hard-codes `protocolVersion: "1"` and old hand-command semantics. It is not the production v3 contract, but it will confuse a v3-to-v1 rebaseline unless it is replaced with a current proof or explicitly retired.

### Product and documentation markers

```text
product.yaml
checklist.md
README.md
architecture.html
docs/redesign/north-star.md
docs/contract-codegen.md
apps/sync/AGENTS.md
apps/sync/README.md
apps/sync/docs/sync-breaker-v3.md
CHANGELOG.md
```

Notable inconsistencies:

- `docs/contract-codegen.md` says production Sync protocol v2.
- `CHANGELOG.md` describes v2 as unpublished and v3 as the replacement.
- `docs/redesign/north-star.md` calls product launch “v1” while describing the settled Sync design as v3.
- `apps/sync/README.md` documents both local v1 compatibility and production v3.
- `architecture.html` embeds generated v3 architecture copy and `/v3/sync` paths.

The `scratchpad/` files contain historical v1/v2/v3 design and session-log references. They are archival evidence, not runtime surfaces, and should not be treated as authoritative protocol documentation.

### Telemetry and embedded whiteboard versions

```text
sdks/typescript/client/src/telemetry/types.ts
  TELEMETRY_EVENT_VERSION = 1

packages/whiteboard/src/embedded/protocol.ts
  CHALK_EMBEDDED_WHITEBOARD_BRIDGE_VERSION = 1
  CHALK_EMBEDDED_WHITEBOARD_EXCALIDRAW_VERSION = "0.18.1"

packages/whiteboard/src/embedded/controller.ts
packages/whiteboard/src/embedded/manifest.ts
packages/whiteboard/src/embedded/renderer-bridge.ts
```

These are independent from Sync transport numbering.

### Managed deployment and Cloudflare markers

```text
infrastructure/managed-meeting/contracts/release-manifest.schema.json
  release-manifest-v1, schema_version 1

infrastructure/managed-meeting/scripts/test-config
  schema_version 1

infrastructure/managed-meeting/cloudflare/ingress.production.json
  schema_version 1

infrastructure/meeting-broker/wrangler.toml
  Durable Object migration tag "v1"

infrastructure/uptime-worker/src/index.ts
  /api/v1/ops/ingest/monitor-results
```

These should not be renamed as part of Sync protocol rebaselining.

### External standards and dependency versions

Examples that are not Chalk protocol versions:

```text
contract/generated/openapi.json
  OpenAPI 3.1.0

infrastructure/opentofu/modules/*/versions.tf
  OpenTofu/provider versions

infrastructure/opentofu/modules/aws-transcription-dispatcher/variables.tf
  Cloudflare model version v3-turbo

apps/api/scripts/dev-postgres.sh
apps/api/scripts/dev-redis.sh
  expected PostgreSQL/Redis versions

apps/mobile/ios/Chalk.xcodeproj/project.pbxproj
scripts/sync-ios-screenshare-target.rb
  mobile marketing/build versions
```

These must not be bulk-renamed.

## 5. Recommendation

Choose top-level Sync v3 → v1, retain the explicit `/v1/sync` route, and remove the old top-level v1 implementation first.

Reasons:

- The product has no users, so the breaking change is cheap.
- The current v3 is the only production Sync implementation.
- Keeping v3 preserves a misleading historical gap and leaves dead v1 code and stale v2 documentation.
- An explicit versioned route preserves future coexistence and deployment routing.
- Dropping the URL segment would still require frame-level protocol versioning and would make future routing and compatibility less explicit.
- The existing API `/v1`, whiteboard-v1, webhook-v1, and internal `/internal/v1` surfaces are independent and should remain unchanged.

Recommended cleanup boundary:

- Delete top-level Sync v1 runtime, generated bindings, dev lab, old RoomServer stack, old breaker, and v1 SDK generated export.
- Remove `room_actions_v1` fallback if the goal is to remove all legacy compatibility.
- Rebaseline the current Sync contract, route, frame marker, generated modules, SDK names, deployment manifest, tests, and docs to v1.
- Keep `state_schema_version: 3` and `chalk-sync-state-v3` unless there is a separate decision to reset the durable state/digest contract.
- Replace or retire the stale contract proof that currently models the old Sync v1.
- Do not rename unrelated API, whiteboard, webhook, telemetry, deployment-schema, provider, or toolchain versions.
