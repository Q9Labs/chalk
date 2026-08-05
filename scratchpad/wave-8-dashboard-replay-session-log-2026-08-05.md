# Wave 8 dashboard replay — 2026-08-05

## Scope and provenance

- Target: `/Users/macmini/code/chalk/.worktrees/wave-8-reconciliation`.
- Target checkpoint: `fd7e8f9abf07430fc0517443577fdad796e65563`.
- Source dashboard head: `0c6768c01d92829f2c5ec26c6b698586131d6f31`.
- Replayed exactly `0c6768c^..0c6768c`, restricted to the five allowlisted
  manifests. The source worktree and its `dashboard-completion-integration`
  worktree were not modified.
- The existing target modification
  `scratchpad/wave-8-reconciliation-session-log-2026-08-05.md` belongs to the
  parent reconciliation lane and was left untouched.

Manifest hashes verified before applying the patch:

| Manifest               | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| DB allowlist           | `12c6eb6e08c2217d537720a6bc8b6b28b311ee54c2e7476aaa5164e1b74ceb62` |
| API allowlist          | `06fcbb2f5465113e7dfe445624fcb95ee14a2f7b6d8611695b7927d9b0191355` |
| web allowlist          | `5fcecf858c873dca1a7956a94416e49e7d48414c1ed17b62930bdb3c8bf4c2dc` |
| contracts allowlist    | `311799561b5611af03bdcac7d623c016a276611cf8d0db61766f4fff23d9d92c` |
| generated-discard list | `e2b66d1a7d94c7169131495458700b4ff2ae9c2fcecfdcd823c49408a56f901e` |
| root/shared allowlist  | `2d16c6315b32a8ef2a2bbe962ba9350996b8c582673654ce171ed84f6e98b3f3` |
| stale/deny list        | `33467c7886f3262cba1edef6891a7cb049097814b3ef7fd4a19ae584c2dbc20`  |

## Replayed paths

The replay changed these 92 source paths (plus the pre-existing parent session
log noted above):

### Database

- `apps/api/db/migrations/20260804130000_add_space_archive_state.sql`
- `apps/api/db/migrations/20260804143000_api_key_idempotency.sql`
- `apps/api/db/queries/api_keys.sql`
- `apps/api/db/queries/spaces.sql`
- `apps/api/db/queries/sync_lifecycle.sql`
- `apps/api/db/schema.sql`

### API

- `apps/api/README.md`
- `apps/api/cmd/main.go`
- `apps/api/cmd/perf/main.go`
- `apps/api/internal/adapters/google/oidc.go`
- `apps/api/internal/adapters/google/oidc_test.go`
- `apps/api/internal/adapters/postgres/api_keys.go`
- `apps/api/internal/adapters/postgres/episode_lifecycle_create.go`
- `apps/api/internal/adapters/postgres/space_lifecycle_integration_test.go`
- `apps/api/internal/adapters/postgres/space_webhooks.go`
- `apps/api/internal/adapters/postgres/space_webhooks_test.go`
- `apps/api/internal/adapters/postgres/spaces.go`
- `apps/api/internal/apikeys/repository_test.go`
- `apps/api/internal/apikeys/service.go`
- `apps/api/internal/apikeys/service_test.go`
- `apps/api/internal/apikeys/types.go`
- `apps/api/internal/authentication/principal.go`
- `apps/api/internal/authentication/service.go`
- `apps/api/internal/authentication/service_test.go`
- `apps/api/internal/config/config.go`
- `apps/api/internal/config/config_test.go`
- `apps/api/internal/httpapi/api_keys.go`
- `apps/api/internal/httpapi/api_keys_test.go`
- `apps/api/internal/httpapi/contracts.go`
- `apps/api/internal/httpapi/errors.go`
- `apps/api/internal/httpapi/me.go`
- `apps/api/internal/httpapi/middleware.go`
- `apps/api/internal/httpapi/rate_limit.go`
- `apps/api/internal/httpapi/recent_auth.go`
- `apps/api/internal/httpapi/recent_auth_test.go`
- `apps/api/internal/httpapi/route_contracts_test.go`
- `apps/api/internal/httpapi/router.go`
- `apps/api/internal/httpapi/router_composition.go`
- `apps/api/internal/httpapi/router_identity.go`
- `apps/api/internal/httpapi/router_test.go`
- `apps/api/internal/httpapi/spaces.go`
- `apps/api/internal/httpapi/webhook_transport.go`
- `apps/api/internal/observability/launch.go`
- `apps/api/internal/observability/launch_test.go`
- `apps/api/internal/ratelimit/policies.go`
- `apps/api/internal/recentauth/service.go`
- `apps/api/internal/recentauth/service_test.go`
- `apps/api/internal/spaces/service.go`
- `apps/api/internal/spaces/service_test.go`
- `apps/api/internal/traceharness/scenario_catalog.go`
- `apps/api/internal/traceharness/scenario_test.go`
- `apps/api/internal/webhooks/events.go`
- `apps/api/internal/webhooks/types.go`
- `apps/api/internal/webhooks/webhooks_test.go`

### Web dashboard

- `apps/web/scripts/dashboard-account-fixture-api.ts`
- `apps/web/src/components/dashboard/APIKeysPage.test.tsx`
- `apps/web/src/components/dashboard/APIKeysPage.tsx`
- `apps/web/src/components/dashboard/DashboardShell.tsx`
- `apps/web/src/components/dashboard/EditSpaceDialog.test.tsx`
- `apps/web/src/components/dashboard/EditSpaceDialog.tsx`
- `apps/web/src/components/dashboard/EpisodeDetail.test.tsx`
- `apps/web/src/components/dashboard/EpisodeDetail.tsx`
- `apps/web/src/components/dashboard/EpisodeDialogs.test.tsx`
- `apps/web/src/components/dashboard/EpisodeDialogs.tsx`
- `apps/web/src/components/dashboard/EpisodeStates.test.tsx`
- `apps/web/src/components/dashboard/EpisodeStates.tsx`
- `apps/web/src/components/dashboard/EpisodesPage.test.tsx`
- `apps/web/src/components/dashboard/EpisodesPage.tsx`
- `apps/web/src/components/dashboard/NewSpaceDialog.test.tsx`
- `apps/web/src/components/dashboard/NewSpaceDialog.tsx`
- `apps/web/src/components/dashboard/ProductHome.test.tsx`
- `apps/web/src/components/dashboard/ProductHome.tsx`
- `apps/web/src/components/dashboard/SpaceDialogPrimitives.test.tsx`
- `apps/web/src/components/dashboard/SpaceDialogPrimitives.tsx`
- `apps/web/src/components/dashboard/SpaceLifecycleDialog.test.tsx`
- `apps/web/src/components/dashboard/SpaceLifecycleDialog.tsx`
- `apps/web/src/components/dashboard/SpacesPage.test.tsx`
- `apps/web/src/components/dashboard/SpacesPage.tsx`
- `apps/web/src/components/dashboard/__tests__/dialog-fixtures.ts`
- `apps/web/src/components/dashboard/episode-utils.test.ts`
- `apps/web/src/components/dashboard/episode-utils.ts`
- `apps/web/src/lib/dashboard-api.test.ts`
- `apps/web/src/lib/dashboard-api.ts`
- `apps/web/src/routes/_app.developer.tsx`
- `apps/web/src/routes/_app.episodes.tsx`
- `apps/web/src/routes/_app.spaces.tsx`
- `apps/web/src/server/account-boundary.test.ts`
- `apps/web/src/server/account-boundary.ts`
- `apps/web/src/styles/dashboard.css`

### Contracts and shared tooling

- `contract/webhooks/v1/event.schema.json`
- `contract/webhooks/v1/fixtures.json`
- `sdks/typescript/client/scripts/generate-webhook-contract.mjs`

The generated-discard and stale/deny manifests were not changed. Generated
SQLC and generated webhook TypeScript outputs remain at the target checkpoint,
as required for this lane.

## Behavior and vocabulary

The replay includes the dashboard/API behavior for recent-auth step-up,
idempotent/reveal-once/rotate/revoke API-key mutations, idempotent Space
creation, Space archive/restore and lifecycle webhooks, Episodes history/detail
and start/end flows, API-key management, account-boundary/CSRF protection, the
Google reauth bridge, dashboard shell/routes/styles, journey and trace
instrumentation, and the canonical webhook contract fixtures.

The source patch's obsolete role spelling in the API-key HTTP test was adapted
from `memberships.RoleAdmin` to canonical `memberships.RoleCollaborator`,
including the test name. The shared webhook generator conflict was resolved to
retain `SpaceWebhookEvent` and the existing Participant/Recording/Transcript/
Endpoint exports; obsolete Room/Session exports were not restored.

Active product-code scans found no banned dashboard aliases (including
VideoConference, ConferenceView, PreJoinScreen, managed-meeting,
meeting-broker, MeetingSession, ChalkSession, ParticipantAccess, `/room`,
RoomWebhook, or SessionWebhook). Remaining `Session`/`host` matches are
internal authentication/test/networking terms; historical mentions are confined
to scratchpad records.

## Verification

- API focused tests passed:
  `go test ./internal/recentauth ./internal/apikeys ./internal/spaces
./internal/authentication ./internal/observability ./internal/webhooks
./internal/adapters/google ./internal/config ./internal/ratelimit`.
- Web typecheck passed: `pnpm run check-types` in `apps/web`.
- Focused web suite passed sequentially with one worker/no file parallelism:
  14 files, 82 tests, 27.04s (`pnpm exec vitest run --config
./vitest.config.ts --no-file-parallelism --maxWorkers=1` with the changed
  dashboard/API/server test files); the individual EpisodeDetail run also
  passed (4 tests).
- Web production build passed: `pnpm run build` in `apps/web`; its ignored
  `apps/web/dist` output was removed and verified absent.
- Webhook contract check passed:
  `Webhook v1 contract valid: 15 Event fixtures, 2 signatures, 8 journey
Events.`
- Go formatting, Oxfmt checks for changed TS/TSX/MJS/JSON/CSS, and
  `git diff --check` passed.
- No process started by this lane remains.

## Deferred root-owned checks

- Broader API HTTP/adapters tests cannot compile until the checkpoint's
  generated SQLC package is regenerated with the new query symbols. This lane
  intentionally leaves generated SQLC untouched; root owns that regeneration
  seam.
- `node sdks/typescript/client/scripts/generate-webhook-contract.mjs --check`
  reports the expected stale generated receiver contract because generated
  outputs are excluded/root-owned.
- `pnpm run language:ratchet` reports the expected baseline tightening in
  `apps/api/session` (-8) and `apps/web/session` (-6); the root lane owns the
  generated/discard baseline update.

No stage or commit was performed. The target is quiescent and ready for the
parent reconciliation lane to inspect and integrate.
