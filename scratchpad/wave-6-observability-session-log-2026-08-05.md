# Wave 6 observability session log — 2026-08-05

## Sync correlation contract/runtime slice

- Added the strict `sync-v1` correlation definition for optional `journey_id`, `traceparent`, and bounded `tracestate` fields. Correlation is accepted on client `hello` and server-to-client frames; unrelated client frames remain exact-key strict.
- Regenerated the TypeScript and Elixir sync contract outputs. Elixir protocol normalization now returns a string-keyed `correlation` map, empty when the hello has no correlation fields.
- Updated the browser sync hello builder to emit direct correlation fields from `JourneyTelemetryContext`, preserving the existing `rootJourneyId` as client-only context.
- Added golden, invalid, protocol, codegen, and client coverage, including independent zero trace/span rejection and partial correlation envelopes.
- Verification: sync codegen Vitest 10/10; generated Elixir fixture test 1/1; sync protocol ExUnit 4/4; TypeScript sync client/codec Vitest 57/57; client TypeScript check-types passed; contract generated drift check passed.

## 2026-08-05 01:13 PKT — Unified Wave 6 implementation report

### API and provider boundary

- The Cloudflare SFU verification span and operation now use `mediaplane.cloudflare.sfu.verify_connection` and `verify_connection`; the old `...verify_session` and `verify_session` names are retired. Provider failures normalize to Chalk's `connection_not_found` and `connection_not_connected` classifications, and absent connections use `ErrConnectionNotFound` while Episode operations retain `ErrEpisodeNotFound`.
- The telemetry intake wiring is now `EpisodeCredentialVerifier`/`EpisodeCredentials`. It still accepts a verified Episode-scoped media credential or an API session credential; “session” here describes authentication, not a Chalk product entity. The journey aggregate changed from `room.create.completed` to `space.create.completed`.
- Execution-trace scenario cutovers are `route:session-sync-token` → `route:episode-admit-member`, `route:room-create-member` → `route:space-create-member`, `route:session-create-member` → `route:episode-create-member`, and `route:session-end-member` → `route:episode-end`; the new trace scenarios also cover `route:episode-remove-participant` and `route:episode-deadline`.
- The adapter intentionally keeps Cloudflare's vendor contract: `/sessions/...` paths, `sessionId` and `sessionDescription` JSON fields, and vendor `SESSION_*` error codes remain unchanged. The Chalk-side operation and classification names are the only boundary translation.

### SDK and React Native telemetry

- Connection diagnostics changed `join_span` to `space_join_span`, `join-span-N` to `space-join-span-N`, and the React Native diagnostic code prefix from `join.*` to `space.join.*`.
- Journey telemetry changed `meeting.join` to `space.join`, `/v1/rooms` observations to `/v1/spaces`, and the diagnostic category `session` to `episode`. Attribute normalization continues to bound keys and values, reserve `metric_value`, and remove raw IDs, credentials, tokens, and request bodies from exported telemetry.

### Sync durable event and correlation

- The emitted durable command event changed from `sync.room.event.committed` to `sync.episode.event.committed`. It is linked only after the command receipt and state event are durably committed, emitted once for the original delivery, and omitted for duplicate receipts; its `event_name` is bounded to the canonical Episode event allowlist with unknown values mapped to `other`.
- The `journey_id`, `traceparent`, and bounded `tracestate` correlation fields remain the wire contract for hello/server frames. `sync.runtime.health` and the durable state digest `chalk-sync-state-v1` are unchanged.

### Observability E2E and Compose isolation

- The webhook proof now exercises `space.created`, `space.updated`, `episode.started`, `episode.ended`, `participant.joined`, and `participant.left` (the former room/session event labels are gone). Its Prometheus assertions use `chalk_webhook_events_committed_total{event_name="space.created",api_version="1"}`, `chalk_webhook_delivery_attempts_total{event_name="space.created",outcome="retryable_failure|succeeded"}`, and `chalk_webhook_redelivery_results_total{outcome="accepted"}`. The metric families did not change; hosted filters must use the canonical `event_name` labels.
- `observability:e2e` now reaches the journey proof through the real `local.sh e2e`/`e2e.sh` entrypoint. The proof waits for recovery completion and snapshots, verifies the durable event's command origin, Participant, revision, digest, and base revision, and sends `delivery_ack` only after the matching event is verified. Admission failures expose bounded safe identifiers and never include a sync token, credential, or raw admission payload. The pre-Sync SQL check proves the revision-zero folded state and role policy before the server starts.
- Each run uses a unique `chalk-observability-e2e-${suffix}` Compose project, containers and volumes derived from that project, dynamically allocated host ports, and a timestamped `chalk-api-${timestamp}` artifact. Cleanup kills and verifies task PIDs, removes only that project, and verifies its containers and volumes are gone, leaving shared Compose resources untouched.

### Uptime probes

- The web monitor identifier and path changed from `web.room`/`/room` to `web.space`/`/space`. `api.health`, `api.readiness`, `sync.health`, and `sync.readiness` are unchanged; the hosted bases remain `https://chalkmeet.com`, `https://api.chalkmeet.com`, and `https://sync.chalkmeet.com`.

### Hosted cutover inventory

Before a deploy, update the hosted side in this order:

1. Update Tempo/provider span searches and any provider-side rules from `mediaplane.cloudflare.sfu.verify_session` (and operation `verify_session`) to `mediaplane.cloudflare.sfu.verify_connection` (and `verify_connection`), and map old `session_not_found`/`session_not_connected` filters to the connection classifications.
2. Update the Grafana/Tempo synthetic query from `sync.room.event.committed` to `sync.episode.event.committed`. Keep the existing `chalk-observability-v1` dashboard UID, `journey_id` variable, Loki selector `{service_name="chalk-api"} | journey_id="<id>"`, and `webhook.delivery.attempt` trace lookup: none of those identifiers changed in this diff.
3. Update webhook dashboard and alert label filters from `room.created`, `room.updated`, `session.started`, and `session.ended` to `space.created`, `space.updated`, `episode.started`, and `episode.ended`; the `chalk_webhook_*` metric families and the accepted redelivery outcome remain the same. No in-repo dashboard panel or alert UID was renamed.
4. Deploy the uptime worker and update status consumers that key on `web.room` to consume `web.space` at `/space`; the API and Sync health/readiness probe keys do not need a cutover.
5. Update any hosted execution-trace views that select the retired `route:session-*` or `route:room-*` scenario names to the Episode/Space names listed above. No secret, binding, provider resource, production stack, or durable digest name changed, and no production mutation was performed.

### Review and disposition

Terra's first review found five concrete gaps: the journey proof was not wired into the entrypoint, the observer fixture used a non-enum role, admission errors could reveal credential presence, `delivery_ack` could precede matching event verification, and cleanup did not prove task-only Compose/process teardown. All five were remediated. Terra's second and final review was clean with no outstanding findings.

### Focused verification

- Passed `bash -n` for the observability shell scripts, `node --check` for all changed JavaScript, targeted `pnpm exec oxfmt --check`, `docker compose ... config --quiet` with unique project/port/resource values, and `git diff --check` for the observability changes.
- Full hosted E2E and the repository gate were not run in this lane because they require the external services/network; the focused checks above cover the changed local harness and resource-isolation paths.

### Sync contract final-review remediation

- Added invalid hello coverage for a non-zero trace ID with a zero parent/span ID, plus an invalid client `ping` carrying top-level correlation fields. The generated TypeScript and Elixir fixture assertions reject both cases.
- Rechecked TypeScript/Elixir tracestate handling for trailing LF and CRLF values; the existing generated validators reject them, so no emitter or generated-output change was needed.
- Follow-up verification passed: sync codegen Vitest 10/10, TypeScript sync client/codec Vitest 57/57, sync protocol ExUnit 4/4, generated drift check (ContractIR sha256 `ddd8ad2e129c3e14576e66d867b9568f3a1643007463fa47b857c3a08064b44e`), targeted oxfmt, and `git diff --check`.

### SDK tracestate compatibility remediation — 2026-08-05 02:18:56 PKT

- Chose safe omission over a wire-contract expansion: `syncTelemetryCorrelation` now drops tracestate values outside the current v1 wire subset while preserving `journey_id` and `traceparent`, preventing a valid upstream W3C context from closing the hello.
- Added focused helper and V1 hello coverage for W3C-valid multi-tenant `acme@tenant=value` and OWS-after-comma `vendor=value, other=thing` forms; both remain journey/traceparent-correlated and omit only tracestate.
- Verification passed: focused TypeScript Vitest 61/61, client `check-types`, generated contract drift check, targeted oxfmt, and `git diff --check`.

### M4 generated Elixir warning remediation — 2026-08-05 02:40:35 PKT

- Removed the two unreachable generated correlation fallbacks from `sync-elixir.mjs` (`valid_correlation_fields?/1` and `correlation_exact_keys?/2`) and regenerated `apps/sync/lib/chalk_sync/contract/generated.ex`; no protocol behavior changed.
- Verification passed: `scripts/codegen/check-sdk-generated.sh`, `apps/sync/scripts/gate.sh basic` (including `mix compile --warnings-as-errors`), sync codegen Vitest 11/11, targeted oxfmt, and `git diff --check`.

## 2026-08-05 01:27 PKT — Sync final-review remediation (Terra second/final per-lane review)

- Propagated the first-observed validated connection correlation through every Sync server frame path. Socket output now decorates Coordinator recovery/live frames, command and operation acknowledgements, retries/errors, pong, directed/live-target responses, and queued collaboration frames with `Observability.frame_fields/1`; absent incoming W3C context remains absent while the local journey root stays bounded.
- Preserved the complete validated W3C carrier across command worker execution. `ObservedContext` retains the original `traceparent` flags and bounded `tracestate`; `CommandIntake` passes both through the durable-context reconstruction, while the legacy trace/span-only path remains compatible for older persisted work.
- Added real Socket coverage for recovery snapshots, committed command ack/event, pong, protocol error, and unsampled `traceparent` plus `tracestate`; added no-context assertions and supervised-worker coverage for full W3C fields.
- Focused verification: 40 Sync ExUnit tests across protocol, observability, command, command intake, and Socket suites passed. Formatting, strict Credo, and scoped diff validation were run after the remediation.

## 2026-08-05 01:59 PKT — Sync bounded-frame reserve remediation

- Added `limits.correlationReservedBytes = 1160` to the sync-v1 source contract. The reserve is the maximum standalone JSON object for valid `journey_id`, `traceparent`, and a 512-byte canonical W3C tracestate; the non-empty-object merge delta is 1159 bytes. Tracestate values now use the W3C printable-byte grammar, excluding control characters that could JSON-escape beyond the declared byte bound.
- Generated Elixir and TypeScript top-level bounded-frame checks subtract the reserve only before correlation is complete, then enforce the original hard limit after the full carrier is present. Nested event/message/reaction payload bounds remain unchanged. Chat page, projection snapshot/event, replay page, welcome snapshot, and live event producers use the same producer budget; fixed-size reaction/chat/read-receipt/result frames remain safely below their existing collaboration bound, while direct reaction/chat-message/event validators also apply the reserve.
- Added exact escaped-correlation and near-limit chat-page regressions in ProtocolV1 and generated TypeScript contract tests. Codegen drift, contract lint/typecheck, 25 codegen tests, 41 focused Sync ExUnit tests, format, strict Credo, and scoped diff checks all passed.

## 2026-08-05 02:30 PKT — Deferred external-operation W3C carrier persistence remediation

- Extended Sync `ExternalOperation` records and both Postgres and memory stateholders to persist/reload the validated producing `traceparent` and `tracestate` alongside the legacy trace/span IDs. SQL queries, row decoding, and provider-bridge context reconstruction now pass the complete carrier; the old trace/span-only fallback remains compatible with existing API-created rows.
- Added nullable W3C carrier columns and bounded consistency checks to the API schema snapshot plus a reversible Goose migration. Regenerated API sqlc output so `SyncExternalOperation` reads the new columns without changing the existing API insert contract.
- Added memory and Postgres persistence/reload coverage plus provider-bridge retry coverage proving unsampled `traceparent` flags and `tracestate` survive the deferred boundary.
- Verification: 50 focused Sync tests passed (20 Postgres tests skipped without `CHALK_SYNC_TEST_DATABASE_URL`), targeted format and strict Credo passed, sqlc generation and `go test ./internal/adapters/postgres/sqlc` passed, and `git diff --check` passed. Broader Postgres adapter tests require an unavailable local database (complaint #3641).

## 2026-08-05 02:46 PKT — Luna exact-tree test remediation

- Removed invalid assertions that treated `Postgres.begin_operation/2`'s `OperationDecision` as the persisted `ExternalOperation`. The focused persistence test now verifies the carrier through the intended `claim_operations/1` and `read_operation/2` reload seams; production persistence code was unchanged.
- Verification: `mix test test/chalk_sync/stateholder/postgres_external_operation_test.exs` passed with 20 tests skipped because no Postgres test URL was configured; targeted format check passed and no production changes were needed.
