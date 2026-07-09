# Composio Integrations Spec

This spec defines the next Go API slice for external integrations. It builds on
the existing `audit_logs` and `integration_connections` database foundation and
keeps Chalk's domain vocabulary provider-neutral while using Composio as the
first integration provider.

Implementation workers must follow the local API standards before writing code:

- `apps/api/docs/code-standards.md`
- `apps/api/docs/route-workflow.md`
- `apps/api/docs/database-workflow.md` when touching migrations, sqlc queries,
  repository adapters, or generated DB code

## Product Intent

Chalk should let users connect the tools they already use, then let meeting
workflows read, write, and react to those tools with explicit user consent. A
meeting can create action items in Linear, send a recap to Slack, draft a Gmail
follow-up, attach a Drive document, or create a Salesforce note without Chalk
owning OAuth token storage for every provider.

The first implementation should prove the whole integration lifecycle:

- Show a catalog of supported services.
- Start a granular connection flow for one service.
- Store and list local connection records.
- Execute a small provider action through Composio.
- Record auditable outcomes.
- Leave trigger/webhook support shaped but not overbuilt until a consuming
  workflow exists.

## Canonical Language

- `IntegrationProvider`: the auth/tool execution provider Chalk talks to. The
  first value is `composio`.
- `IntegrationService`: the user-facing external service being connected, such
  as `gmail`, `google_calendar`, `slack`, or `linear`.
- `IntegrationConnection`: Chalk's local record of one user's authorized
  connection to one service through one provider.
- `external_account_ref`: the provider's connected-account ID, such as a
  Composio `ca_*` nanoid.
- `external_auth_config_ref`: the provider's auth-config ID when Chalk pins a
  specific Composio auth config for scopes, branding, or quota isolation.
- `toolkit`: Composio's word for an app/service surface. In Chalk code, map it
  at the adapter edge and keep the domain word `service`.
- `tool`: Composio's executable action slug. In Chalk domain code, prefer
  `Action` unless the field must carry an exact Composio slug.

Do not call Slack, Gmail, or Linear providers in Chalk code. They are services.
Composio is the provider.

## Composio Semantics To Model

Composio's current public REST API is authenticated with a project API key in
the `x-api-key` header. The v3.1 base URL is documented as
`https://backend.composio.dev/api/v3.1`; older session/tool-router docs may
still show v3 paths, so implementation should pin one version per endpoint
family and cover the request paths in adapter tests.

Important resources:

- Auth configs define how a toolkit authenticates across users, including OAuth2,
  API key, bearer token, basic auth, scopes, and whether credentials are
  Composio-managed or custom.
- Connected accounts are per-user authorized toolkit connections. Composio stores
  and refreshes credentials and links accounts to the `user_id` Chalk supplies.
- Sessions scope a user, enabled toolkits, auth configs, connected accounts,
  tool allowlists, workbench behavior, and multi-account behavior.
- Link sessions return a hosted URL where the user completes auth for a toolkit.
- Tool execution runs a tool slug in a session and may resolve the connected
  account automatically or require explicit account selection.
- Proxy execution lets Chalk call a toolkit API endpoint through Composio's auth
  layer when a predefined tool is not enough. Treat proxy execution as an
  internal escape hatch, not a public Chalk API. Composio v3.1 requires a scoped
  project key for this endpoint.
- Triggers deliver provider events to a single signed webhook endpoint. Trigger
  instances are per connected account.
- Tool and toolkit discovery endpoints expose toolkit slugs, tool schemas, tags,
  versions, and required scopes. Use them to verify the static catalog and to
  detect drift, not to let clients execute arbitrary tools.

References:

- https://docs.composio.dev/reference/authenticating-to-composio
- https://docs.composio.dev/reference/api-reference/auth-configs
- https://docs.composio.dev/reference/api-reference/connected-accounts
- https://docs.composio.dev/reference/api-reference/tool-router
- https://docs.composio.dev/reference/api-reference/tools
- https://docs.composio.dev/docs/triggers

## Service Catalog

The API should treat the catalog as data owned by the integrations domain, not as
ad hoc strings in handlers. Each service entry should include the Chalk service
ID, display family, display name, Composio toolkit slug, Composio auth config ref
when pinned, allowed tool slugs, destructive-risk tags, read/write capability
tags, and toolkit version.

Google must be granular. The UI can group these under "Google", but each entry
starts its own auth path and requests only the scopes required for that service.
Do not create one "Google suite" connection that asks for everything.

Initial Google services:

| Service ID         | Composio Toolkit | Purpose                                                                                                          |
| ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `gmail`            | `gmail`          | Draft/send follow-ups, read relevant threads when authorized.                                                    |
| `google_calendar`  | `googlecalendar` | Read/write meetings, agendas, reminders, scheduling context.                                                     |
| `google_drive`     | `googledrive`    | Attach, retrieve, and share meeting files.                                                                       |
| `google_docs`      | `googledocs`     | Create and update notes, recaps, specs, and docs.                                                                |
| `google_sheets`    | `googlesheets`   | Update trackers, lightweight CRM sheets, attendance/action logs.                                                 |
| `google_slides`    | `googleslides`   | Create/update decks from meeting artifacts; expect custom OAuth if managed auth is unavailable.                  |
| `google_forms`     | `googleforms`    | Generate surveys, feedback forms, onboarding questionnaires; expect custom OAuth if managed auth is unavailable. |
| `google_tasks`     | `googletasks`    | Create personal tasks from meeting action items.                                                                 |
| `google_contacts`  | verify           | Resolve contact context only when a workflow needs it.                                                           |
| `google_meet`      | `googlemeet`     | Meeting metadata parity; expect custom OAuth if managed auth is unavailable.                                     |
| `google_analytics` | verify           | Marketing/customer meeting context for growth teams.                                                             |
| `google_ads`       | verify           | Marketing workflow follow-ups and campaign context.                                                              |
| `youtube`          | verify           | Content teams, recordings, publication workflows.                                                                |

Do not default to Composio's broad Google aggregate toolkit if one is available.
It fights the consent model because it spans many products and large tool
surfaces. Prefer separate Chalk services even when two services temporarily map
to the same underlying toolkit.

Tier 1 non-Google services:

| Service ID | Composio Toolkit | Purpose                                                          |
| ---------- | ---------------- | ---------------------------------------------------------------- |
| `slack`    | `slack`          | Notifications, digests, channel recaps, async meeting follow-up. |
| `linear`   | `linear`         | Engineering/product action items and issue updates.              |
| `github`   | `github`         | Issues, PR context, release/deployment follow-through.           |
| `notion`   | `notion`         | Notes, knowledge base pages, product docs.                       |

Tier 2 services:

| Service ID           | Composio Toolkit      | Purpose                                                                                               |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `jira`               | `jira`                | Enterprise issue tracking alternative to Linear.                                                      |
| `microsoft_outlook`  | `outlook`             | Enterprise email parity with Gmail.                                                                   |
| `microsoft_calendar` | `outlook`             | Enterprise calendar parity with Google Calendar; model separately even if backed by the same toolkit. |
| `microsoft_teams`    | `microsoft_teams`     | Enterprise chat/meeting workspace parity with Slack.                                                  |
| `onedrive`           | `one_drive`           | Microsoft file storage parity with Google Drive.                                                      |
| `sharepoint`         | `one_drive` initially | Enterprise document/workspace storage until a standalone SharePoint toolkit is verified.              |
| `microsoft_excel`    | `excel`               | Workbook workflows when OneDrive file tools are too broad.                                            |
| `hubspot`            | `hubspot`             | Sales/customer meeting notes and follow-up.                                                           |
| `salesforce`         | `salesforce`          | Enterprise CRM notes, tasks, opportunities, account context; expect custom auth.                      |
| `intercom`           | `intercom`            | Support/customer conversations and escalation workflows; expect custom auth.                          |
| `zendesk`            | `zendesk`             | Support tickets and customer issue follow-up; expect custom auth.                                     |
| `sentry`             | `sentry`              | Incident/debug context, issue creation, release notes.                                                |
| `figma`              | `figma`               | Design review context and handoff artifacts.                                                          |
| `asana`              | verify                | Task/project management for teams outside Linear/Jira.                                                |
| `pagerduty`          | verify                | Incident response follow-up and on-call context.                                                      |
| `datadog`            | verify                | Observability context for incidents and reliability reviews.                                          |
| `posthog`            | verify                | Product analytics context.                                                                            |
| `stripe`             | verify                | Customer/billing context for customer-facing meetings.                                                |

Implementation should verify exact Composio toolkit slugs during adapter work.
If a desired Google or Microsoft product is not exposed as a separate Composio
toolkit, keep the Chalk service ID stable and map it to the closest supported
toolkit/auth-config combination inside the Composio adapter.

Large toolkits such as GitHub, Outlook, Zendesk, HubSpot, and Salesforce need
explicit allowlists. Composio tags such as read-only and destructive hints are
useful guardrails, but Chalk must still maintain its own allowed-action policy.

## Go API Architecture

Create a domain package at `apps/api/internal/integrations`.

The package owns:

- Provider-neutral domain types.
- Validation and service catalog.
- Local repository interface for `integration_connections`.
- Provider port for auth links, account reconciliation, execution, and optional
  trigger management.
- Service methods that coordinate repository, provider, and audit logging.

Suggested core names:

```go
type IntegrationProvider string
type IntegrationService string

const ProviderComposio IntegrationProvider = "composio"

type Provider interface {
    CreateConnectLink(ctx context.Context, input CreateConnectLinkInput) (ConnectLink, error)
    GetConnection(ctx context.Context, input GetProviderConnectionInput) (ProviderConnection, error)
    RefreshConnection(ctx context.Context, input RefreshConnectionInput) (ProviderConnection, error)
    DisableConnection(ctx context.Context, input DisableConnectionInput) error
    ExecuteAction(ctx context.Context, input ExecuteActionInput) (ActionResult, error)
    ProxyRequest(ctx context.Context, input ProxyRequestInput) (ProxyResult, error)
}
```

Name the first adapter package `apps/api/internal/adapters/composio`. Its
concrete type should be `Adapter`, with constructors `NewAdapter` and
`NewAdapterWithClient`, matching the local port/adapter convention.

Do not add a TypeScript or Python sidecar for Composio. The current official SDK
surface is TypeScript/Python-oriented, but the REST API is complete enough for
the Go API boundary and keeps deployment simple.

The Composio adapter should model these REST surfaces first:

- Toolkit discovery: `GET /toolkits`, `GET /toolkits/{slug}`, multi-toolkit
  lookup, and toolkit changelog when available.
- Tool registry: `GET /tools` filtered by toolkit, version, tags, and explicit
  tool slugs.
- Scope planning: `POST /tools/scopes/required`.
- Auth configs: create/list/get/update/delete/disable when Chalk owns custom
  auth configs.
- Connected accounts: create link session, list, get, refresh, revoke, delete.
- Sessions: create/resume session and session-scoped execution for workflows
  that benefit from Composio's account resolution and workbench behavior.
- Direct execution: allowed only for server-side actions with a known tool slug.
- Proxy execution: internal-only escape hatch with a separately scoped API key.

Use managed auth for local development, internal tests, and low-risk demos. For
customer-visible production OAuth, prefer custom auth configs for Google,
Microsoft, Slack, GitHub, HubSpot, and other services where branding, exact
scopes, dedicated provider quota, or trigger latency matter. Before enabling a
service publicly, verify whether Composio managed auth is available for the
service's toolkit; some useful toolkits require custom auth.

## Config

Add one provider-specific config type:

```go
type ComposioConfig struct {
    APIKey string
    BaseURL string
    RequestTimeout time.Duration
    WebhookSecret string
}
```

Environment variables:

- `CHALK_COMPOSIO_API_KEY`
- `CHALK_COMPOSIO_BASE_URL`, default `https://backend.composio.dev/api/v3.1`
- `CHALK_COMPOSIO_TIMEOUT_MS`, default consistent with other outbound adapters
- `CHALK_COMPOSIO_WEBHOOK_SECRET`

Outside local development, the API key must be required before wiring routes
that can call Composio. Webhook secret should be required before accepting
Composio webhook traffic.

Do not make `/readyz` depend on Composio by default. A Composio outage should
degrade integration features without making the whole API look unready unless we
deliberately choose provider health as a deployment gate.

## Data Model Mapping

Use the existing tables first.

`integration_connections` maps as:

- `provider`: `composio`
- `service`: Chalk service ID, such as `gmail`
- `external_account_ref`: Composio connected account nanoid
- `external_auth_config_ref`: Composio auth config nanoid when present
- `status`: Chalk status, initially `pending`, `active`, `disabled`, `revoked`,
  `expired`, `failed`
- `account_label`, `account_email`: safe user-facing labels from Composio or the
  service profile
- `scopes`: scopes or capability strings approved for this connection
- `metadata`: provider details that do not deserve first-class columns yet
- `last_used_at`: updated after successful execution

Connections are personal within a tenant in the first implementation. A member
connects their own Gmail, Slack, or Linear account for workflows that act as
that user. Tenant admins may list that a connection exists for governance, but
responses should avoid exposing account labels or emails for another user's
personal connection unless a product permission explicitly allows it.

State transitions:

```text
pending -> active
pending -> failed
active -> expired
active -> revoked
active -> disabled
expired -> active
failed -> pending
disabled -> pending
```

The unique key `(tenant_id, provider, service, external_account_ref)` prevents
duplicating one upstream connected account. Connection start should be
idempotent for the same pending/active provider account when Composio returns
the same `external_account_ref`. If a user starts a second account for the same
service, preserve both rows when Composio returns a different connected account.

Use `audit_logs` for integration lifecycle and execution events:

- `integration.connection.started`
- `integration.connection.connected`
- `integration.connection.failed`
- `integration.connection.disabled`
- `integration.action.executed`
- `integration.webhook.received`
- `integration.webhook.rejected`

Audit details may include provider, service, connection ID, provider request ID,
status transition, and safe error codes. They must not include OAuth tokens,
raw provider payloads, email/document bodies, or full auth URLs. A failed audit
write should fail lifecycle mutations that are meant to be auditable; for
best-effort action telemetry, the service may return the user-facing provider
result and log the audit failure if the mutation already happened externally.

When a DB state change and audit entry must be atomic, add a repository
transaction boundary instead of issuing unrelated sqlc calls from the service.
External Composio calls happen outside the transaction; use idempotent local
updates and provider refs to recover from retries.

Do not add a webhook-events table until the first production trigger workflow
needs durable provider-event dedupe beyond audit logging.

## HTTP Contract

Routes live under authenticated `/v1` tenant scope and must call tenant
authorization before reading or mutating tenant connections.

Add integration scopes before mounting routes:

- `integrations:read` for service catalog and connection reads.
- `integrations:write` for starting, refreshing, and executing through
  connections.
- `integrations:delete` for disabling, deleting, or revoking connections.

Tenant authorization is still required after scope checks. A caller with an
integration scope cannot touch a tenant unless the tenant policy authorizes the
principal for that tenant.

Initial routes:

- `GET /v1/tenants/{tenant_id}/integrations/services`
  - Lists enabled catalog entries, grouped by family in the response.
- `POST /v1/tenants/{tenant_id}/integrations/connections`
  - Starts a connection for `{ "provider": "composio", "service": "slack" }`.
  - Optional fields: `callback_url`, `account_alias`.
  - Returns the local connection record and a provider connect URL.
- `GET /v1/tenants/{tenant_id}/integrations/connections`
  - Lists tenant/user connections with optional `provider`, `service`, and
    `status` filters plus cursor pagination. Non-admin users should see their
    own personal connections by default.
- `GET /v1/tenants/{tenant_id}/integrations/connections/{connection_id}`
  - Reads one connection.
- `POST /v1/tenants/{tenant_id}/integrations/connections/{connection_id}/refresh`
  - Reconciles local state from the provider.
- `POST /v1/tenants/{tenant_id}/integrations/connections/{connection_id}/actions`
  - Executes one allowlisted Chalk action ID against an active connection.
  - Request uses either `arguments` or `text`, never both.
  - The service maps the Chalk action ID to the current Composio tool slug after
    validating the service catalog and connection state.
- `DELETE /v1/tenants/{tenant_id}/integrations/connections/{connection_id}`
  - Disables or revokes a connection through provider and local state.

Webhook route:

- `POST /v1/webhooks/composio`
  - Public transport, provider-authenticated by signature.
  - Does not require Chalk user auth.
  - Must verify signature before parsing expensive payloads or touching storage.

Execution routes must stay allowlist-first. Prefer product-level commands like
"send recap to Slack" over exposing arbitrary Composio tool execution to clients.

Stable error codes:

- `invalid_integration_provider`
- `invalid_integration_service`
- `invalid_integration_action`
- `integration_provider_unavailable`
- `integration_provider_unauthorized`
- `integration_provider_rate_limited`
- `integration_connection_not_found`
- `integration_connection_not_active`
- `integration_action_not_allowed`
- `integration_webhook_signature_invalid`

## Workflows

Connection start:

1. HTTP parses tenant ID and requested service.
2. HTTP authorizes the principal for the tenant.
3. `integrations.Service` validates provider/service and loads catalog config.
4. Service asks `integrations.Provider` for a connect link.
5. Repository creates a `pending` connection with Composio refs.
6. Audit log records `integration.connection.started`.
7. HTTP returns the connection and hosted connect URL.

Connection reconciliation:

1. Callback/webhook or explicit refresh identifies the connection.
2. Adapter fetches the Composio connected account.
3. Service maps provider status to Chalk status.
4. Repository updates status, labels, scopes, expiry, revocation timestamps.
5. Audit log records success or failure.

Action execution:

1. Product workflow requests a provider-neutral action.
2. Service loads an active connection by tenant, user, provider, and service.
3. Adapter creates/resumes a Composio session as needed.
4. Adapter executes a tool slug or proxy request.
5. Repository marks connection used after success.
6. Audit log records action, outcome, and provider request/log ID.

Trigger delivery:

1. Composio posts a signed event to the webhook route.
2. HTTP verifies the signature and bounds the request body.
3. Service maps provider event to a provider-neutral event.
4. Unsupported event types are acknowledged after audit logging, not retried
   forever.
5. Supported events dispatch to the product workflow that owns them.

## Security And Privacy

- Never store provider OAuth access tokens or refresh tokens in Chalk.
- Use stable Chalk user UUIDs as Composio `user_id`; never use mutable emails.
- Request Google scopes per service and per workflow, not as a suite-wide bundle.
- Keep arbitrary tool execution server-side. Clients should request Chalk
  workflows, not raw Composio tool slugs.
- Bound webhook bodies and connection-start request bodies.
- Do not log access tokens, auth URLs beyond safe IDs, provider payload bodies
  that may contain customer data, or full email/document contents.
- Treat provider account IDs as sensitive operational identifiers in public logs.
- Add idempotency to connection start if the UI can double-submit.
- Map Composio `401`, `403`, `408`, `413`, `429`, `500`, and `502` into stable
  domain errors before HTTP mapping.

## Observability And Trace Harness

Operation logs should name the Chalk operation and redact provider payloads. For
example, log `integrations.connection.start`, `integrations.connection.refresh`,
`integrations.action.execute`, and `adapter.composio.request` with provider,
service, status, duration, HTTP status, and provider request/log ID when safe.

Add Execution Trace Harness scenarios once the first route is wired:

- connect happy path
- forbidden tenant
- provider failure during connect
- refresh/reconcile active connection
- disable/revoke connection

Trace events should show the local chain:

```text
HTTP route -> integrations.Service -> integrations.Repository -> postgres/sqlc
HTTP route -> integrations.Service -> integrations.Provider -> composio.Adapter
```

Secrets, auth URLs, provider tokens, and raw provider response bodies must be
redacted from trace events.

## Testing And Verification

The implementation is not complete until the automated suite, local API gate,
trace harness, and live Composio smoke checks all have an explicit result. A
worker may mark a slice done only when its own tests pass and it names the exact
remaining cross-slice checks it cannot run. The main integration pass owns the
full gate and live provider verification.

Unit and adapter tests:

- Catalog validation rejects duplicate service IDs and missing toolkit mappings.
- Catalog validation rejects missing allowed-action policy for large toolkits.
- Catalog validation proves every public Google service is separately addressable
  and does not route through a broad Google aggregate toolkit by default.
- Service tests cover connection start, invalid service, duplicate/idempotent
  start, second-account start, refresh, disable, provider failure, audit success,
  and audit failure behavior.
- Adapter tests using `httptest.Server` for:
  - `x-api-key` header
  - exact base URL/path construction
  - connect link request/response mapping
  - connected account status mapping
  - toolkit lookup response mapping
  - required-scope response mapping
  - tool execution success
  - proxy execution requires the internal-only config path
  - 401/403/429/5xx error mapping
  - malformed provider responses
- Postgres repository tests for create/list/update/mark-used behavior.
- Postgres repository tests for personal-within-tenant listing and admin-safe
  visibility behavior once the permission model exists.
- HTTP tests for:
  - anonymous requests return `401`
  - authenticated but unauthorized tenant access returns `403`
  - missing integration scope returns `403`
  - request body limits
  - stable error codes
  - list pagination response shape
- Webhook tests for valid signature, invalid signature, oversized body, and
  unsupported event acknowledgement once the route exists.

Live Composio smoke checks:

- Run only when `CHALK_COMPOSIO_LIVE_TESTS=1` and `CHALK_COMPOSIO_API_KEY` is
  present in the environment.
- Load the key from the operator-approved secret manager at runtime. Do not
  commit secret references, secret values, masked key fragments, provider request
  IDs, or raw provider payloads.
- Use read-only Composio endpoints by default:
  - authenticate with `GET /toolkits?limit=1`
  - resolve every catalog toolkit slug that is not marked `verify`
  - verify whether managed auth is available for each public service
  - fetch tool metadata for every allowed tool slug
  - call required-scopes planning for each service allowlist
- Any mutating live check, such as auth-config creation or connected-account link
  creation, must run only against a disposable test project and must clean up its
  provider resources.
- The implementation is blocked from being called production-ready if the live
  smoke returns `401`, `403`, or unresolved required toolkit slugs.

Per-service live verification:

- Every worker that implements a service, tool, action, or trigger must add live
  verification for that exact provider surface in the same slice.
- Each implemented `IntegrationService` needs a live test that resolves its
  Composio toolkit slug, confirms the toolkit is enabled and not deprecated, and
  records whether managed auth is available.
- Each implemented action needs a live test that fetches the exact Composio tool
  slug, validates its input schema can represent Chalk's request, checks its
  required scopes, and confirms the action is included in Chalk's allowlist.
- Each implemented trigger needs a live test that fetches the trigger definition,
  validates its event schema against Chalk's internal event shape, and proves
  the webhook verification code rejects unsigned payloads locally.
- Read-only actions should be exercised live end-to-end whenever a disposable
  connected account exists. Mutating actions must run only against disposable
  test resources and must clean up after themselves.
- If a live execution cannot run because it needs a human OAuth grant, the worker
  must still verify toolkit/tool/scope metadata live and mark the OAuth execution
  check as blocked with the exact missing test account requirement.
- The final handoff must include a service/action verification matrix with:
  `service`, `toolkit_slug`, `tool_slug` or trigger slug, live metadata result,
  live execution result, scopes checked, cleanup result, and any blocker.
- Do not accept "adapter live smoke passed" as proof for a newly implemented
  service. The service, every exposed action, and every exposed trigger need
  their own live verification row.

Run before handoff:

```bash
apps/api/scripts/db-generate.sh run
go test ./internal/integrations ./internal/adapters/composio ./internal/adapters/postgres ./internal/httpapi
go test ./...
CHALK_COMPOSIO_LIVE_TESTS=1 go test ./internal/adapters/composio -run Live
apps/api/scripts/gate.sh
apps/api/scripts/perf-local.sh
codex review --commit <sha>
```

If `perf-local.sh` is still blocked by the existing unauthenticated tenant seed
issue, call that out explicitly and do not hide it behind the integrations work.
If live Composio verification is blocked by an invalid or missing API key, call
that out as a provider-verification blocker and do not enable Composio routes as
production-ready behavior.

## Delegation Strategy

Use one `gpt-5.5` high lead worker for the implementation. The lead worker owns
the end-to-end API slice, reads `code-standards.md`, `route-workflow.md`, and
`database-workflow.md`, builds the shared backbone, launches service-bundle
workers, integrates their patches, runs the final verification loop, and commits.

The lead worker owns these shared files and decisions:

- `internal/integrations/*` domain types, service, catalog registry,
  validation, errors, provider/repository ports, and tests.
- `internal/adapters/composio/*` shared REST client, request signing,
  provider-error mapping, redaction, and shared live-test harness.
- `internal/adapters/postgres/*` integration repository mapping over sqlc.
- `internal/httpapi/*` integration routes, request/response DTOs, authn/authz,
  scope checks, and route tests.
- `internal/config/*`, `cmd/main.go`, changelog, trace harness, generated sqlc,
  final gate, final live verification matrix, review, and commit.

After the backbone exists, the lead worker should launch service-bundle workers.
Those workers should not invent architecture or change shared route/service
patterns. Their job is to add multiple services and actions into the established
catalog, action allowlists, tests, and live verification matrix.

Recommended service-bundle workers:

- Google workspace bundle: `gmail`, `google_calendar`, `google_drive`,
  `google_docs`, `google_sheets`, `google_slides`, `google_forms`,
  `google_tasks`, `google_meet`, and any verified remaining Google services.
- Work management bundle: `slack`, `linear`, `github`, `notion`, `jira`,
  `asana`.
- Microsoft bundle: `microsoft_outlook`, `microsoft_calendar`,
  `microsoft_teams`, `onedrive`, `sharepoint`, `microsoft_excel`.
- Customer/revenue bundle: `hubspot`, `salesforce`, `intercom`, `zendesk`,
  `stripe`.
- Ops/design/analytics bundle: `sentry`, `figma`, `pagerduty`, `datadog`,
  `posthog`.

Each service-bundle worker must:

- Read and follow `code-standards.md`.
- Use the Composio API key from the operator-provided `op` item at runtime for
  live tests; do not print, commit, or log the key.
- Verify each service toolkit live against Composio.
- Verify every action/tool/trigger it exposes live against Composio metadata and
  required-scope endpoints.
- Add or update automated tests for its services and actions.
- Fill in its rows in the service/action verification matrix.
- Return a concise handoff naming changed files, services added, live checks run,
  blockers, and cleanup performed.

The lead worker must review worker patches before merging them. If service
workers conflict, the lead worker resolves the conflict in favor of the shared
domain/route/adapter patterns and reruns affected tests. The lead worker, not a
service-bundle worker, is responsible for generated code, final `gate.sh`,
`perf-local.sh`, `codex review`, and the final commit.

## Open Decisions

- Exact Composio toolkit slugs for every Google/Microsoft service need a live
  verification pass during adapter implementation.
- Decide whether connection start should create a new Composio session every
  time or reuse a short-lived session per Chalk user/service.
- Decide whether disabled local connections should also revoke at the upstream
  service or only disable the Composio connected account.
- Decide which first product action proves execution: Slack recap, Linear issue,
  Gmail draft, or Calendar event update. Slack recap is the lowest-friction demo.
