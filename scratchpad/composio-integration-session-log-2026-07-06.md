# Composio Integration Session Log - 2026-07-06

## 2026-07-06 23:45 PKT

- Read required repo/API docs and Composio integration spec before editing.
- Confirmed `apps/api/AGENTS.md` is absent in this worktree.
- Built `internal/integrations` domain package with provider-neutral types,
  catalog validation, service methods, repository/provider ports, and focused
  tests.
- Built `internal/adapters/composio` REST adapter for v3.1 auth-config lookup,
  connect links, connected account reconciliation, disable, toolkit/tool
  metadata, required scopes, unit tests, and a live metadata smoke test.
- Built `internal/adapters/postgres` integration repository mapping over the
  existing sqlc integration and audit queries. No schema/query changes so far.
- Added HTTP routes under
  `/v1/tenants/{tenant_id}/integrations`, route tests, integration scopes,
  config parsing, and main wiring.
- Focused tests passed:
  `go test ./internal/integrations ./internal/adapters/composio ./internal/adapters/postgres ./internal/httpapi ./internal/authentication ./internal/config ./cmd`.
- Read-only live Composio metadata call currently returns `401` with the
  approved runtime credential path; no secret values, request IDs, or payloads
  were recorded.

## 2026-07-06 23:53 PKT

- `go test ./...` passed.
- Live Composio test command failed at read-only Slack toolkit metadata with
  `integration provider unauthorized`; this blocks the service/action/scope
  verification matrix until the runtime credential is authorized for the
  Composio project.
- `apps/api/scripts/gate.sh` passed after a Staticcheck simplification in the
  Composio adapter.
- `apps/api/scripts/perf-local.sh` is blocked by the existing unauthenticated
  tenant seed path: `seed tenants: HTTP 401`.

## 2026-07-06 17:07 PKT

- `codex review --commit c6317f02` found two issues: nil scopes encoded as SQL
  `NULL`, and direct connection lookup routes did not enforce personal
  connection ownership for user-session callers.
- Fixed Postgres integration create/update mapping to send an empty scopes
  array when the domain input has nil scopes.
- Fixed detail/refresh/disable paths to pass the authenticated user ID into the
  integration service and hide connections owned by a different user.
- Added regressions for Postgres empty scopes, domain owner enforcement, and
  HTTP actor forwarding.
- Fresh checks passed: focused package tests, `go test ./...`, `git diff
  --check`, and `apps/api/scripts/gate.sh`.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 17:16 PKT

- `codex review --commit 374168b9` found three more issues: the integration
  connection start request advertised idempotency without durable support, soft
  disable set `revoked_at`, and multi-slug toolkit lookup fetched only the first
  global Composio page.
- Removed the integration `idempotency_key` request/domain field for this slice
  because the Composio connect-link schema does not support an idempotency key
  and durable local replay would require a separate design.
- Fixed soft-disable to keep `revoked_at` nil unless `revoke=true`.
- Fixed Composio toolkit metadata lookup to search each requested slug exactly.
- Added regressions for multi-slug toolkit lookup and soft-disable timestamps.
- Fresh checks passed: focused package tests, `go test ./...`, `git diff
  --check`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 17:26 PKT

- `codex review --commit aa828e35` found that Composio connect-link creation
  can return `200 OK` for successful link sessions while the adapter only
  accepted `201 Created`.
- Fixed the connect-link call to accept both `200 OK` and `201 Created`, with
  the unit fixture now covering the `200 OK` success path.
- Live metadata then exposed a provider response-shape mismatch for the
  `deprecated` field; fixed toolkit/tool deprecation mapping to handle
  bool/null/object shapes without recording provider payloads.
- Fresh checks passed: `go test ./internal/adapters/composio`, `go test ./...`,
  `git diff --check`, and `apps/api/scripts/gate.sh`.
- Live Composio metadata/scopes remains blocked because the current provider
  account reports the Slack toolkit as deprecated. No OAuth execution was
  attempted and no provider resources were created.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 18:29 PKT

- `codex review --commit 48c90677` found that refresh discarded Composio's
  provider `redirect_url`, which clients need for expired OAuth
  re-authentication flows.
- Fixed Composio refresh to decode the redirect URL, return it from the
  provider/domain service, and include it as `connect_url` in the refresh HTTP
  response.
- Added adapter, domain service, and HTTP route regressions for preserving the
  refresh connect URL.
- Fresh checks passed: `go test ./internal/adapters/composio ./internal/integrations ./internal/httpapi`,
  `go test ./...`, `git diff --check`, and `apps/api/scripts/gate.sh`.
- Live Composio metadata/scopes still reaches the provider but blocks because
  the current account reports Slack as deprecated. No OAuth execution was
  attempted and no provider resources were created.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 18:38 PKT

- `codex review --commit ed9f28d7` found two lifecycle issues: members could
  start personal integration connections but not disable them, and local cleanup
  stopped if the provider account had already been removed.
- Changed the disable route to use the integration write/member permission,
  with service ownership checks still enforcing the authenticated user.
- Reconciled provider `ErrConnectionNotFound` during disable as local
  disable/revoke cleanup, and added focused HTTP/domain regressions.
- Fresh focused checks passed: `go test ./internal/integrations
  ./internal/httpapi` and `git diff --check`.
- After removing the now-unused admin/delete permission helper, `go test ./...`
  and `apps/api/scripts/gate.sh` passed.

## 2026-07-06 18:44 PKT

- `codex review --commit a7de122d` found that the disable route should still
  require `integrations:delete` for API-key principals while allowing tenant
  members to disable their own connections.
- Adjusted the delete permission to use delete scope plus member role and
  updated the HTTP regression expectation.
- Fresh checks passed: `go test ./internal/httpapi ./internal/integrations`,
  `go test ./...`, `git diff --check`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 18:52 PKT

- `codex review --commit 96f183f9` found that client-supplied integration
  callback URLs were forwarded to Composio without validation.
- Added HTTP-edge callback URL validation against exact configured allowed
  origins, rejecting wildcard origins and arbitrary domains for OAuth callbacks.
- Fresh checks passed: `go test ./internal/httpapi`, `go test ./...`, `git diff
  --check`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 19:02 PKT

- `codex review --commit 89df4a42` found two HTTP-layer issues: browser CORS
  preflights did not advertise DELETE, and tenant admins were still forced
  through owner-scoped connection reads/refreshes/disables.
- Added DELETE to the CORS allow-methods header and made integration routes use
  tenant-scoped access for admins while preserving owner-scoped behavior for
  non-admin user principals.
- Fresh checks passed: `go test ./internal/httpapi`, `git diff --check`,
  `go test ./...`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 19:10 PKT

- `codex review --commit 695cd927` found that tenant-scoped admin/API-key
  audit writes serialized a zero actor UUID instead of SQL NULL.
- Changed the Postgres integration audit adapter to emit a nullable actor UUID
  and added a repository regression for tenant-scoped audit actions.
- Fresh focused checks passed: `go test ./internal/adapters/postgres
  ./internal/integrations ./internal/httpapi`, `git diff --check`, `go test
  ./...`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 19:24 PKT

- `codex review --commit 04ba0b54` found that tenant-scoped admin/API-key
  responses exposed another user's account label/email and that connection
  start did not reuse existing pending/active provider account refs.
- Added principal-aware redaction for tenant-scoped connection responses and
  duplicate external account ref reuse in the integration service, with
  Postgres unique-violation mapping as a race fallback.
- Fresh focused checks passed: `go test ./internal/adapters/postgres
  ./internal/integrations ./internal/httpapi`, `git diff --check`, `go test
  ./...`, and `apps/api/scripts/gate.sh`.

## 2026-07-06 20:06 PKT

- `codex review --commit 58fd645d` found that Composio connect links did not
  opt into multiple accounts, which conflicted with the local model allowing
  multiple accounts per service.
- Added `allow_multiple: true` to the Composio link request and a regression
  asserting the JSON body.
- Live Composio metadata then showed the Slack action slug had drifted; replaced
  the old `SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL` slug with current
  `SLACK_SEND_MESSAGE`.
- Fixed Composio deprecation parsing so the legacy metadata object currently
  returned in toolkit responses does not mark enabled toolkits as deprecated.
- Fresh checks passed: `go test ./internal/adapters/composio
  ./internal/integrations`, live Composio metadata with the rotated runtime key,
  `go test ./...`, `git diff --check`, and `apps/api/scripts/gate.sh`.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 20:16 PKT

- Expanded the Composio live metadata test from a Slack-only probe to a full
  catalog walk. The test now verifies every configured service toolkit and every
  allowlisted action/scopes lookup against the live Composio API.
- The broader live check found Google Sheets action drift; replaced
  `GOOGLESHEETS_UPDATE_SPREADSHEET_VALUES` with current live slug
  `GOOGLESHEETS_VALUES_UPDATE`.
- Fresh checks passed: live full-catalog Composio metadata with the runtime
  1Password key, `go test ./internal/adapters/composio ./internal/integrations`,
  `go test ./...`, `git diff --check`, and `apps/api/scripts/gate.sh`.
- Updated the spec route contract to remove the stale `idempotency_key` field
  from the connection-start request. Idempotency remains a named follow-up once
  it has durable storage support.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 20:24 PKT

- `codex review --commit 887b183f` found two P2 issues: admin refresh/disable
  audits lost the acting admin user ID, and reconnecting a disabled/failed/etc.
  provider account could return conflict instead of restarting the local row.
- Split integration owner-scope filtering from audit actor attribution at the
  HTTP/service boundary, so tenant-wide admin mutations remain tenant-scoped but
  auditable to the user who performed them.
- Changed connection start to restart an existing non-active connection with the
  same provider account ref by moving it back to `pending` and recording
  `integration.connection.started`.
- Fresh checks passed: `go test ./internal/integrations ./internal/httpapi`,
  `go test ./...`, full-catalog live Composio metadata with the runtime
  1Password key, `git diff --check`, and `apps/api/scripts/gate.sh`.
- `apps/api/scripts/perf-local.sh` still blocks at the known tenant seed issue:
  `seed tenants: HTTP 401`.

## 2026-07-06 22:20 PKT

- Delegated the local perf seed auth failure to a `gpt-5.5` high worker.
- Root cause: protected tenant routes now require authentication, while
  `cmd/perf` still sent unauthenticated seed/load requests. After adding auth,
  the normal authenticated write limiter was also too low for the local harness.
- Added a local-only `CHALK_API_LOCAL_SYSTEM_TOKEN` config path. `cmd/perf`
  generates a random token for the server it launches, sends it as a bearer
  token on harness requests, and the router accepts it as an internal system
  principal only in local environments.
- Tightened the worker patch so system-principal requests bypass rate limiting
  directly instead of disabling the limiter for all local-server requests.
- Fresh checks passed: `go test ./internal/config ./internal/httpapi ./cmd
  ./cmd/perf`, `apps/api/scripts/gate.sh`, and `apps/api/scripts/perf-local.sh`.
