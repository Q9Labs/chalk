# SFU Recording and Transcription implementation handoff

Status: Control-plane foundation implemented; runtime orchestration blocked on an explicit contract
Deadline owner: root thread stops before 02:00 PKT on 2026-08-24
Starting commit: `c10c8452` on `master`
Target: local repository only; no deployment or production mutation

## Read first

1. Read `AGENTS.md`, `GLOSSARY.md`, `~/.codex/global-code-standards.md`, and the closest app `AGENTS.md` before changing code.
2. Read the ratified plan at `scratchpad/cloudflare-sfu-recording-transcription-spec-2026-08-23.md`.
3. Preserve the large unrelated dirty worktree. Do not stash, reset, restore deleted tests, or revert files owned by other threads.
4. Check `scratchpad/message-board.md` before taking a lane. Production remains forbidden without explicit approval in the active thread.

## Product decisions

- Media plane: direct Cloudflare SFU now, provider-neutral contract for future mediasoup. RealtimeKit Recording and Transcription are excluded.
- Recording: one deterministic `composite_720p_v1` 1280x720 MP4; temporary isolated audio is not a customer Artifact.
- Recording policy: `disabled | manual | automatic`.
- Transcription policy: `disabled | on_demand | automatic`, post-Episode only.
- Provisional source window: 24-hour v1 ceiling.

## Implemented and verified so far

- `apps/api/internal/artifactpolicy/` resolves Tenant and Space policy, validates bounds, freezes snapshot/profile versions, and creates the seconds-based Episode Artifact policy document.
- `apps/api/internal/captureplane/` defines the provider-neutral six-operation capture port, Chalk identity and fence metadata, canonical track validation, bounded typed failures, and a reusable adapter conformance harness. Its SDP validation accepts normal WebRTC CRLF termination.
- `apps/api/internal/episodes/service.go` and `validation.go` accept and validate the optional versioned Artifact policy while remaining compatible with old Episode snapshots.
- Public create/update Recording endpoints and public reservation/pipeline endpoints are no longer mounted or included in contract preview.
- OpenAPI and generated TypeScript contracts no longer expose `createRecording`, `updateRecording`, Recording reservation, or pipeline inspection operations.
- Recording signed-download requests are capped at five minutes.
- The recorder-worker control routes are composed only on the private mTLS listener, require a SPIFFE worker verifier, and remain absent from the public router. API startup fails when Recording is enabled without the private listener configuration. `/readyz` also requires healthy capture and render pools while Recording is enabled.
- Sync Recording start acceptance now persists `starting`; the provider acknowledgment only completes the reservation. A separate internal `recording_capture_ready` operation checks the originating start operation plus a monotonic capture epoch before moving to `recording`. Automatic starts use persisted system authority without creating a Participant.
- Sync Recording stop acceptance now persists `stopping`; the provider acknowledgment only completes the stop reservation. A separate internal `recording_capture_stopped` operation checks the originating stop operation and established capture epoch before moving to `stopped`.
- The API materializes Sync's supplied Recording ID through the public row, capacity reservation, pipeline, and capture job. The migration adds final storage facts and both Sync completion operations, and SQLC output is regenerated.
- Render commit now locks and authorizes the matching public Recording, reservation, Tenant, Space, Episode, pipeline, job attempt, generation, lease, and owner before any mutation. The Artifact, render-job success, public Recording completion, and pipeline commit happen in one statement. Exact ambiguous retries return the existing Artifact; different facts return a conflict.
- The SFU executor recognizes Recording start and stop effects through a provider-neutral `RecordingController`. Production does not inject a controller yet, so it returns a bounded retryable `recording_controller_unavailable` response instead of claiming a false success.

Verified command:

```bash
cd apps/api
go test ./internal/artifactpolicy ./internal/episodes ./internal/captureplane/...
go vet ./internal/captureplane/...
go test ./internal/httpapi -run 'Test(PublicRecordingReservationRouteIsNotMounted|PublicRecordingMaterializationRoutesAreNotMounted|RecordingRouteContractsHaveNoPublicMaterializationPath|PublicContractHasNoRecordingPipelineOperations|NewRecorderWorkerRouter|PrivateWorkerRouter|PublicRouterDoesNotExposeRecorderWorkerRoutes|Ready|RecorderHealth|CreateRecordingDownloadURLRejectsLifetimeAboveFiveMinutes)' -count=1
go test ./internal/adapters/postgres -run 'Test(CommitArtifact|RecordingRepository)' -count=1

cd ../sync
mix test test/chalk_sync/recording_foundation_test.exs

cd ../..
pnpm run check:sdk-generated
```

Latest root results:

- Go domain, capture conformance, Recording, provider bridge, and command packages passed.
- Focused HTTP and Postgres unit suites passed after obsolete public-route assertions were updated.
- Sync Recording foundation passed with 5 tests and 0 failures. The worker's broader focused Sync set passed with 37 tests and 0 failures, plus warnings-as-errors compilation and formatting.
- Generated SDK drift check passed.
- Scoped `git diff --check` passed.

## Main unresolved seam

Do not inject a no-op Recording controller. `provideroperations.OperationInput` currently has Tenant ID, Episode ID, and Recording ID, but `recordingpipeline.Service.Materialize` also requires Space ID and bounded reservation facts. The next change must define one authority for those inputs: either extend the durable provider operation with an immutable server-derived reservation envelope, or add an API repository that resolves them from the Episode snapshot under the same transaction. The choice must preserve the supplied Recording ID and operation ID as the idempotency key.

Stop has a second required edge: the controller may acknowledge only a durable stop reservation. The capture worker must close and persist the final bundle, then the API must submit `recording_capture_stopped` to Sync. Never return controller success while doing no stop work.

The existing private recorder routes still use the legacy mutable request bodies. They must move to the immutable `recorder_job.v1` envelope with its digest before a capture worker is trusted.

The local Postgres integration fixture is stale or unmigrated: `TestRecordingPipelinePostgresCASAndReplay` fails before its assertions because the configured database has no `recording_capacity` relation. No database mutation was attempted during this session.

## Immediate continuation order

1. Persist Tenant and Space Artifact policy fields, enforce the resolution matrix on mutation, and freeze the resolved `artifact_policy` into every new Episode snapshot. The pure resolver and snapshot validation already exist.
2. Ratify and implement the Recording orchestrator input described above. Compose it into `NewSFUExecutor`, prove idempotent start reservation, and keep stop at `stopping` until the capture-completion callback.
3. Replace legacy recorder-worker bodies with immutable `recorder_job.v1`, then add the plan/SDP queue, capture readiness/stopped callbacks, key broker, and scoped object authority.
4. Implement the Cloudflare `CapturePlane` adapter and Pion runtime only after the contract tests and a named non-production Cloudflare spike target are available.
5. Implement persisted Transcription source expiry/leases and the canonical asynchronous Transcript endpoint. Remove the legacy synchronous mixed-MP4 `/transcriptions` runtime path rather than falling back to it.
6. Add the SDK live Recording projection/commands and React/React Native surfaces after the backend lifecycle is stable.

## Verification still required

- `apps/api/scripts/gate.sh` after aggregate/router integration.
- `apps/sync/scripts/gate.sh` after Sync integration.
- Root `pnpm run gate` on `agents-macmini` only after the concurrent performance profile releases the remote tester.
- Execution Trace Harness scenario, observability proof, dogfood, staging capture proof, changelog, scoped staging, and commit are all still outstanding.

No commit, push, deployment, cloud resource mutation, or production action was performed.
