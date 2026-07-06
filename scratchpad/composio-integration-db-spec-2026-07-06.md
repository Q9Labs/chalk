# Composio Integration DB Spec

Date: 2026-07-06

## Purpose

Chalk wants Composio-backed integrations first, while keeping the database model
honest about what Chalk owns. Composio is the first integration provider. Slack,
GitHub, Linear, Notion, Google Calendar, Gmail, and similar apps are external
services.

The first database pass should make account connections and auditability real
without turning Chalk tables into Composio SDK mirrors.

## Current Schema Reality

The live migration source currently creates these application tables:

- `tenants`
- `users`
- `memberships`
- `auth_identities`
- `login_sessions`
- `api_keys`
- `tenant_signing_keys`
- `rooms`
- `room_sessions`
- `participants`
- `recordings`
- `transcriptions`

`apps/api/db/schema.sql` contains a draft `audit_logs` table, but no migration
creates it yet, and there are no sqlc queries for it. Because `sqlc.yaml` reads
`db/migrations`, not `db/schema.sql`, `audit_logs` is not currently operational.

Implementation must promote audit logs with a real migration before integration
actions depend on them.

## Canonical Terms

Use these terms in Go code, SQL adapters, API responses, and tests.

| Term                                      | Meaning                                                                                  | Examples                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `IntegrationProvider`                     | The infrastructure provider Chalk uses to connect and execute against external services. | `composio`, later `direct`, `arcade`, `nango`                     |
| `IntegrationService` or `ExternalService` | The external app/service the customer connects.                                          | `slack`, `github`, `linear`, `notion`, `google_calendar`, `gmail` |
| `Connection`                              | A user-owned connected account for one service through one provider.                     | Slack connected through Composio                                  |
| `ExternalAccountRef`                      | Provider-owned account identifier stored by Chalk.                                       | Composio `ca_...`                                                 |
| `ExternalAuthConfigRef`                   | Provider-owned auth config identifier.                                                   | Composio `ac_...`                                                 |

SQL column names can stay concise inside integration tables:

- `provider` maps to Go `IntegrationProvider`.
- `service` maps to Go `IntegrationService` or `ExternalService`.

Inside the `internal/integrations` package, avoid stutter where practical:

- Use `Service`, `Repository`, and `Config` for core package types.
- Use `Connection` for the domain entity; `integrations.Connection` reads well.
- Keep Hasan's requested concept names for cross-boundary value types:
  `IntegrationProvider` and `IntegrationService` or `ExternalService`.

Product/UI language should say "Slack integration" or "Connect Slack", not
"service".

## Source Of Truth

Chalk owns:

- tenant and user ownership
- whether a connection is visible/enabled in Chalk
- which services are supported
- which actions are allowlisted
- human approval state
- audit logs
- redacted action inputs and outputs

Composio owns:

- OAuth link UX for managed auth
- external account tokens
- token refresh
- Composio connected account IDs
- Composio auth config IDs
- provider request IDs and execution logs

Chalk must not store raw third-party access tokens, refresh tokens, API keys, or
unredacted provider payloads in public tables.

## Non-Goals For The First DB Pass

- Do not create one table per external service.
- Do not create Composio-named columns such as `composio_connected_account_id`.
- Do not add a full provider/service registry table until the product needs
  dynamic service catalog management.
- Do not add tenant-managed OAuth app configuration until we ship custom OAuth.
- Do not create a separate `integration_action_audits` table; reuse the generic
  `audit_logs` table once it is migrated.

## Tables

### `audit_logs`

Use one generic audit log table for integration actions and future audit-worthy
API behavior. The existing `schema.sql` draft is close, but integration actions
need first-class resource and external request fields for querying.

```sql
create table audit_logs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    actor_user_id uuid references users(id),
    actor_type text not null,
    action text not null,
    resource_type text,
    resource_id uuid,
    details jsonb,
    outcome text not null,
    error_code text,
    error_message text,
    before jsonb,
    after jsonb,
    external_request_id text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index audit_logs_tenant_created_at_id_idx
    on audit_logs(tenant_id, created_at desc, id desc);

create index audit_logs_tenant_action_created_at_id_idx
    on audit_logs(tenant_id, action, created_at desc, id desc);

create index audit_logs_tenant_resource_created_at_id_idx
    on audit_logs(tenant_id, resource_type, resource_id, created_at desc, id desc)
    where resource_type is not null and resource_id is not null;
```

Expected values:

- `actor_type`: `user`, `api_key`, `system`
- `outcome`: `success`, `failure`, `pending`
- `action`: namespaced action string such as
  `integration.connection.created`, `integration.connection.revoked`,
  `integration.slack.message_posted`, `integration.linear.issue_created`

Integration action details should include redacted provider context:

```json
{
  "provider": "composio",
  "service": "slack",
  "connection_id": "chalk-connection-uuid",
  "external_account_ref": "ca_redacted_suffix",
  "external_action": "SLACK_SEND_MESSAGE",
  "external_object_ref": "slack-message-ts",
  "approval": {
    "required": true,
    "status": "approved"
  }
}
```

### `integration_connections`

This is the durable state table for connected external accounts.

```sql
create table integration_connections (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    user_id uuid not null references users(id),
    provider text not null,
    service text not null,
    external_account_ref text not null,
    external_auth_config_ref text,
    status text not null,
    account_label text,
    account_email text,
    scopes text[] not null default '{}',
    metadata jsonb,
    connected_at timestamptz,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, provider, service, external_account_ref)
);

create index integration_connections_tenant_user_service_idx
    on integration_connections(tenant_id, user_id, service);

create index integration_connections_tenant_provider_service_idx
    on integration_connections(tenant_id, provider, service);

create index integration_connections_tenant_status_idx
    on integration_connections(tenant_id, status);
```

Expected values:

- `provider`: `composio`
- `service`: `slack`, `github`, `linear`, `notion`, `google_calendar`, `gmail`
- `status`: `pending`, `active`, `expired`, `revoked`, `disabled`, `failed`

`metadata` is for public-safe provider/service facts only. Good examples:

```json
{
  "workspace_id": "T123",
  "workspace_name": "Acme",
  "provider_status": "ACTIVE"
}
```

Bad examples:

- OAuth tokens
- refresh tokens
- full provider API responses
- customer-sensitive logs
- raw Composio webhook payloads

### `integration_webhook_events`

Add this only when the first implementation consumes Composio webhooks. It is
for idempotency and processing state, not analytics.

```sql
create table integration_webhook_events (
    id uuid primary key,
    provider text not null,
    external_event_ref text not null,
    event_type text not null,
    tenant_id uuid references tenants(id),
    connection_id uuid references integration_connections(id),
    payload jsonb,
    processed_at timestamptz,
    failed_at timestamptz,
    error_message text,
    created_at timestamptz not null default now(),
    unique (provider, external_event_ref)
);

create index integration_webhook_events_created_at_id_idx
    on integration_webhook_events(created_at desc, id desc);

create index integration_webhook_events_connection_created_at_id_idx
    on integration_webhook_events(connection_id, created_at desc, id desc)
    where connection_id is not null;
```

If Composio event IDs are not stable for a specific webhook type, derive
`external_event_ref` from a deterministic hash of safe event identity fields.

## Composio Bias Boundary

Allowed Composio-specific values:

- `provider = 'composio'`
- `external_account_ref = 'ca_...'`
- `external_auth_config_ref = 'ac_...'`
- Composio request IDs in `audit_logs.external_request_id`
- redacted Composio action slug in `audit_logs.details.external_action`

Avoid:

- `composio_*` table names
- `composio_*` column names
- table layouts based on Composio SDK object nesting
- storing Composio-only status values without mapping to Chalk statuses

The adapter should translate Composio concepts into Chalk domain terms at the
boundary.

Durable schema may store opaque provider references because Chalk needs to
reconcile and execute against the provider later. Those columns must stay
generic (`external_account_ref`, `external_auth_config_ref`) and must not encode
provider-specific structure in names, constraints, or application-level meaning.

## API Code Standards Alignment

Follow `apps/api/docs/code-standards.md` and
`apps/api/docs/route-workflow.md` when implementing this spec.

Expected chain:

```text
HTTP route -> service interface -> integrations.Service -> integrations.Repository -> Postgres adapter -> sqlc query
```

Boundary rules:

- HTTP handlers parse request-shaped data, bound request bodies, authenticate the
  caller, and authorize tenant access before service work.
- `internal/integrations` stays free of `pgtype`, SQL driver types, Composio SDK
  types, Composio response structs, and raw HTTP response shapes.
- `internal/adapters/postgres` owns pgx/sqlc translation and should depend on a
  tiny local query interface for focused tests.
- `internal/adapters/composio` owns Composio request/response mapping,
  credentials/config translation, outbound URL construction, provider error
  translation, and redaction.
- The Composio adapter should export an `Adapter` with constructor shape
  `NewAdapter` or `NewAdapterWithClient`; internal HTTP helpers can still be
  called clients.
- Escape or strictly validate any caller-influenced value before it reaches a
  Composio endpoint, provider endpoint, header, or path.
- Do not add unused enum values, generic helper packages, or broad provider
  abstractions until a real caller needs them.

Route workflow rules for the later API slice:

- Start from the user/system action before naming handlers: connect a service,
  list connections, disconnect a service, execute an allowlisted action, receive
  a provider webhook.
- Finalize request, response, stable error codes, authn/authz, rate limits,
  idempotency, data constraints, and audit behavior before writing handlers.
- Mount integration routes under `/v1` protected groups unless the route is a
  deliberate public webhook callback. Public webhooks must verify signatures and
  should not trust body-provided tenant or user IDs.
- Wire service/repository/adapter composition in `cmd/main.go` in the same
  implementation change that exposes routes.
- Add HTTP tests for anonymous `401`, authenticated-but-unauthorized `403`,
  request parsing, response shape, and error mapping.
- If a contract area is intentionally deferred, name it in the implementation
  handoff so it is not mistaken for an accidental omission.

## Primary Workflows

### Connect External Service

1. User requests a connect link for a service, e.g. Slack.
2. Chalk validates tenant membership and service support.
3. Chalk asks Composio for a connect link.
4. User completes OAuth through Composio.
5. Chalk creates or updates `integration_connections`.
6. Chalk writes `audit_logs` with action `integration.connection.created`.

### Reconcile Connection Status

1. Chalk receives webhook or polls provider.
2. Adapter maps provider status to Chalk status.
3. Chalk updates `integration_connections.status`.
4. Chalk writes audit log only for meaningful state changes.

### Execute External Action

1. User requests action, such as posting a meeting summary to Slack.
2. Chalk checks tenant/user ownership and action allowlist.
3. Chalk requires approval for writes.
4. Chalk executes via Composio using the connection's external account ref.
5. Chalk updates `last_used_at`.
6. Chalk writes `audit_logs` with redacted input/output details.

## Failure Behavior

- If Composio is down during connect-link creation, do not create an active
  connection. Return a retriable provider failure.
- If OAuth completes but Chalk does not receive a callback, reconciliation
  should be able to discover the connected account later.
- If execution fails, write an audit log with `outcome = 'failure'`,
  `external_request_id` when available, and a redacted error.
- If a connection expires, keep the row and set `status = 'expired'`; do not
  delete history.
- If the user disconnects, set `revoked_at` and `status = 'revoked'`; avoid hard
  deletes unless required by a future privacy deletion workflow.

## Implementation Phases

### Phase 1: DB Foundation

- Add migration for `audit_logs`.
- Add migration for `integration_connections`.
- Add `db/queries/audit_logs.sql`.
- Add `db/queries/integrations.sql`.
- Run sqlc generation.
- Update `schema.sql` snapshot to match migrations.

### Phase 2: Composio Adapter Boundary

- Add `internal/integrations` domain package.
- Add `internal/adapters/composio` adapter package.
- Export a Composio `Adapter`; keep raw HTTP client details internal to the
  adapter.
- Map Composio connected accounts into `integrations.Connection`.
- Keep Composio request/response structs adapter-local.

### Phase 3: API Routes

- Decide the first public route contracts before implementation. Likely first
  routes:
  - `GET /v1/tenants/{tenant_id}/integrations/connections`
  - `POST /v1/tenants/{tenant_id}/integrations/{service}/connect-link`
  - `POST /v1/tenants/{tenant_id}/integrations/connections/{connection_id}/disconnect`
- Keep list routes tenant-filtered and paginated.
- Keep write routes idempotent where practical; for example, repeated connect
  link creation should not create duplicate active connection rows.
- Return nullable fields as JSON `null`, not empty strings.
- Defer broad dynamic tool execution routes until action allowlists and approval
  UX exist.

### Phase 4: Webhooks

- Add `integration_webhook_events` only when wiring webhook delivery.
- Verify webhook signatures before inserting payloads.
- Store redacted payloads.

## Testing And Verification

Database:

- `apps/api/scripts/db-migrate.sh up`
- `apps/api/scripts/db-migrate.sh down`
- `apps/api/scripts/db-migrate.sh up`
- `apps/api/scripts/db-generate.sh run`

Go:

- Add focused repository tests for create/update/list connection.
- Add focused repository tests for audit log creation/listing.
- Run package tests for touched adapter/domain packages.
- Run `apps/api/scripts/gate.sh` once DB code is wired.

Security:

- Tests must assert no raw token-like fields are persisted.
- Tests must assert tenant scoping on connection reads.
- Tests must assert audit logs can be queried by tenant and action/resource.

## Anti-Slop Rules

- Do not hide provider-specific data in untyped blobs when it needs querying.
- Do not promote every Composio field into Chalk columns.
- Do not add defensive states that the service cannot produce.
- Do not store raw OAuth/provider payloads just because they are useful while
  debugging.
- Do not let external service names leak as product authorization decisions;
  Chalk policy must own action allowlists.
- Do not use repo-wide formatting or unrelated schema cleanup in the same pass.
