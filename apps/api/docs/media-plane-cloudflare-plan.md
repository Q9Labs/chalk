# Cloudflare Media Plane Implementation Brief

This brief is the source of truth for implementing the Go API media-plane
foundation plus Cloudflare RealtimeKit and Cloudflare SFU adapters.

The implementation should be delegated to a **gpt-5.5 high worker**. The parent
agent should wait patiently for that worker to finish, polling without taking
over the implementation unless the worker completes, reports a blocker, or asks
for a specific decision. Do not duplicate the worker's task while it is running.

## Required Reading

Before editing, the worker must read and follow:

- `apps/api/docs/code-standards.md`
- `apps/api/docs/route-workflow.md`
- `docs/redesign/north-star.md`

`route-workflow.md` is required even if this foundation does not add public
routes, because it captures API slice discipline, verification expectations, and
the final Hasan review-map shape.

## Goal

Add the API-side media-plane foundation in `apps/api` and implement the
Cloudflare adapters that the Go API should own:

- RTK adapter for meeting, participant, and join-token bootstrap.
- SFU adapter for provider configuration, API-owned bootstrap metadata, and any
  direct-SFU operation that truly belongs in the API rather than the sync server.

The Elixir sync engine owns live room state and live SFU signaling. Go API owns
durable/bootstrap concerns.

## Non-Goals

- Do not implement live SFU track signaling in the Go API.
- Do not add durable rooms/sessions schema in this foundation pass.
- Do not make Cloudflare IDs first-class core columns or public API concepts.
- Do not finalize product vocabulary for participant presets.
- Do not leave temporary Cloudflare smoke-test resources behind.

## Boundary

The Go API owns:

- Resolving/creating provider-backed media sessions when a durable Chalk session
  needs provider bootstrap.
- Creating provider join material for an admitted participant.
- Returning opaque provider refs and client payloads to the caller.
- Removing a participant when provider-side removal belongs to the API.
- Ending/kicking a provider-backed session when provider-side cleanup belongs to
  the API.
- Fetching or reporting provider usage signals when available.
- Recording enough provider metadata for later durable session persistence.

The Elixir sync engine owns:

- Live room presence.
- Live capability enforcement while connected.
- Publish/subscribe track operations.
- Offer/answer renegotiation.
- Track close.
- Reconnect and low-latency media-control state.

Therefore the Go API media-plane contract must not expose `PublishTracks`,
`SubscribeTracks`, `Renegotiate`, `CloseTracks`, or `CreatePeerConnection`.

## Package Layout

Add:

- `apps/api/internal/mediaplane`
- `apps/api/internal/adapters/cloudflare/rtk`
- `apps/api/internal/adapters/cloudflare/sfu`

The core package must be provider-neutral. Cloudflare SDK/API request and
response shapes stay inside Cloudflare adapter packages.

## API-Side Contract

Create a provider-neutral `mediaplane.Plane` interface shaped around bootstrap
and durable lifecycle.

```go
type Plane interface {
    EnsureSession(ctx context.Context, input EnsureSessionInput) (Session, error)
    CreateJoin(ctx context.Context, input CreateJoinInput) (Join, error)
    RemoveParticipant(ctx context.Context, input RemoveParticipantInput) error
    EndSession(ctx context.Context, input EndSessionInput) error
    SessionUsage(ctx context.Context, input SessionUsageInput) (Usage, error)
}
```

Suggested core concepts:

- `Provider`: `cloudflare_rtk`, `cloudflare_sfu`.
- `Session`: provider, opaque provider session ref, provider metadata.
- `Participant`: opaque provider participant ref, provider metadata.
- `Join`: provider participant ref, client payload, expiration.
- `Usage`: participant minutes, egress bytes, ingress bytes, provider metadata.

`Join.ClientPayload` may be an opaque JSON-like map because SDK/runtime join
material is provider-specific. The core validates Chalk concepts. The adapter
maps those concepts to provider API shapes.

## Cloudflare RTK Adapter

The RTK adapter maps the API-side media-plane contract to RealtimeKit's
meeting/participant/token model.

Responsibilities:

- Create or ensure a RealtimeKit meeting for `EnsureSession`.
- Add a RealtimeKit participant for `CreateJoin`.
- Return the RTK participant token in `Join.ClientPayload`.
- Return Cloudflare meeting and participant IDs only as opaque provider refs.
- Map Cloudflare API errors into `mediaplane` errors.
- Keep RTK request/response structs adapter-private.

Cloudflare API concepts to map:

- Create RTK app: `POST /accounts/{account_id}/realtime/kit/apps`
- Create RTK meeting:
  `POST /accounts/{account_id}/realtime/kit/{app_id}/meetings`
- Add RTK participant:
  `POST /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/participants`
- Kick all active session participants:
  `POST /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/active-session/kick-all`

RTK recording/webhook behavior should stay out of this first port unless it is
needed for the immediate media bootstrap. Recording can become its own provider
port later.

## Cloudflare SFU Adapter

The SFU adapter exists because direct SFU is part of the product direction, but
the Go API should only implement the SFU responsibilities that belong outside
the Elixir sync server.

Responsibilities:

- Validate/configure Cloudflare Realtime app credentials.
- Return provider metadata required by the sync engine.
- Implement any API-owned bootstrap operation discovered during implementation.
- Keep live track operations out of `mediaplane.Plane`.

Cloudflare SFU concepts owned by the Elixir sync engine:

- `POST /apps/{app_id}/sessions/new`
- `POST /sessions/{session_id}/tracks/new`
- `PUT /sessions/{session_id}/renegotiate`
- `PUT /sessions/{session_id}/tracks/close`

If the Go API needs any SFU HTTP calls for smoke verification, keep them
adapter-private and limited to bootstrap verification.

## Config

Add Cloudflare Realtime config under `apps/api/internal/config`.

Candidate env vars:

- `CHALK_CLOUDFLARE_ACCOUNT_ID`
- `CHALK_CLOUDFLARE_API_TOKEN`
- `CHALK_CLOUDFLARE_REALTIME_APP_ID`
- `CHALK_CLOUDFLARE_REALTIME_APP_SECRET`
- `CHALK_CLOUDFLARE_RTK_APP_ID`
- `CHALK_CLOUDFLARE_RTK_TOKEN_ORG_ID`
- `CHALK_CLOUDFLARE_RTK_PRESET_FACILITATOR`
- `CHALK_CLOUDFLARE_RTK_PRESET_CONTRIBUTOR`
- `CHALK_CLOUDFLARE_REALTIME_TIMEOUT_MS`

`CHALK_CLOUDFLARE_RTK_TOKEN_ORG_ID` is the exact `orgId` claim from a
RealtimeKit participant token and is intentionally separate from the app ID.
Telemetry intake only sends matching JWTs to RealtimeKit for verification.
The verifier follows the bootstrap contract in the pinned official
`@cloudflare/realtimekit` client: `https://api.dyte.io/v2/internals/participant-details`
with the participant bearer. That provider call validates the signature and
expiry before the append-only intake accepts the credential. Keep the pinned
client bootstrap path and the Go verifier in sync when upgrading RealtimeKit.

Keep separate RTK and SFU/realtime app config fields even if smoke tests reuse
the same Cloudflare app value.

## Temporary Participant Presets

Use temporary config slugs such as `facilitator` and `contributor` for RTK smoke
tests and adapter mapping. These are implementation placeholders only.

TODO: revisit participant preset names, capability grouping, and their mapping
into the Elixir sync engine when sync-side capabilities are implemented. Final
names should describe what a participant may do without implying account type,
guest status, or identity source.

## Cloudflare Resource Creation

Use the existing Wrangler-authenticated `CLOUDFLARE_API_TOKEN` when it has the
required scopes. Current local Wrangler `4.85.0` does not expose `realtime`,
`rtk`, or `sfu` commands, so Cloudflare Realtime resources may need to be
created/deleted through the Cloudflare REST API.

If a scoped temporary token is needed and the Wrangler-authenticated token can
create it, create the scoped token through Cloudflare's API, use it for the
smoke test, and revoke it before finishing.

Do not print API tokens, app secrets, participant tokens, or raw provider
responses that may contain secrets.

## Testing

Unit tests:

- `internal/mediaplane`: validation, error behavior, provider-neutral service
  behavior.
- `adapters/cloudflare/rtk`: request mapping, response mapping, missing config,
  provider error mapping.
- `adapters/cloudflare/sfu`: config/bootstrap mapping and provider error
  mapping.
- `internal/config`: Cloudflare Realtime defaults, env loading, invalid timeout
  handling.

Provider smoke tests:

- Create temporary Cloudflare Realtime resources.
- Run RTK adapter against the real Cloudflare API:
  - create app if needed
  - create meeting
  - add participant
  - verify returned participant ID and auth token without printing token value
  - kick/end/delete resources as supported
- Run SFU adapter against the real Cloudflare API:
  - create app if needed
  - validate credentials or verify any API-owned bootstrap operation
  - verify provider response without printing secrets
- Delete all temporary Cloudflare resources.
- Revoke temporary tokens created for the smoke test.

Final local gates:

- `go test ./internal/mediaplane ./internal/adapters/cloudflare/rtk ./internal/adapters/cloudflare/sfu ./internal/config`
- `go mod tidy -diff`
- `apps/api/scripts/gate.sh`

## Execution Protocol

1. Spawn one **gpt-5.5 high worker** for the implementation.
2. Give the worker this brief, the relevant repo instructions, and explicit
   instruction to read and follow `apps/api/docs/code-standards.md`,
   `apps/api/docs/route-workflow.md`, and `docs/redesign/north-star.md`.
3. The worker should implement the code, run provider smoke tests, clean up
   Cloudflare resources, run the gates, stage only intended files, and commit.
4. The parent agent should poll patiently. Use long waits. Do not interrupt or
   start implementing the same files unless the worker finishes, fails, or asks
   for help.
5. After the worker commits, run `codex review --commit HEAD`.
6. Fix actionable review findings. Prefer asking the same worker to address
   review findings if they are within its implementation scope.
7. Run final gates again after review fixes.
8. Provide a short Hasan review map following
   `apps/api/docs/hasan-review.md`.

## Commit Hygiene

The worktree may be dirty. Stage only intended paths with patch staging. Do not
use `git add .`. Do not revert unrelated work.

Expected implementation paths include:

- `apps/api/internal/mediaplane/**`
- `apps/api/internal/adapters/cloudflare/rtk/**`
- `apps/api/internal/adapters/cloudflare/sfu/**`
- `apps/api/internal/config/config.go`
- `apps/api/internal/config/config_test.go`
- `apps/api/docs/media-plane-cloudflare-plan.md`
- `apps/api/README.md`
- `CHANGELOG.md`
- `apps/api/go.mod`
- `apps/api/go.sum`

Commit with a conventional commit message after tests and provider cleanup pass.

## Cleanup Checklist

- Temporary RTK apps, meetings, participants, or webhooks deleted when supported.
- Temporary SFU/realtime apps or sessions deleted when supported.
- Temporary Cloudflare API tokens revoked.
- Temporary smoke runner files removed.
- No raw logs, screenshots, provider payloads, tokens, app secrets, or private
  operational details committed.

## Completion Criteria

- `mediaplane` core package exists and is provider-neutral.
- Cloudflare RTK adapter passes unit tests and real provider smoke.
- Cloudflare SFU adapter passes unit tests and real provider smoke for the
  API-owned portion.
- Focused tests pass.
- Full Go API gate passes.
- Temporary Cloudflare resources are deleted.
- Conventional commit exists.
- `codex review --commit HEAD` has been run and actionable findings addressed.
- Hasan review map is provided using `apps/api/docs/hasan-review.md` guidance.
