-- name: LockTenantHandoverTenant :one
SELECT id, created_by_service_id FROM tenants WHERE id = sqlc.arg(tenant_id) FOR UPDATE;

-- name: CreateTenantHandover :one
INSERT INTO tenant_handovers (
    id, tenant_id, recipient_email, status, request_key, request_fingerprint,
    from_service_id, to_service_id, initiated_by_kind, initiated_by_service_id,
    initiated_by_operator, expires_at
) VALUES (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(recipient_email), 'pending', sqlc.arg(request_key), sqlc.arg(request_fingerprint),
    sqlc.arg(from_service_id), sqlc.arg(to_service_id), sqlc.arg(initiated_by_kind), sqlc.narg(initiated_by_service_id),
    sqlc.narg(initiated_by_operator), sqlc.arg(expires_at)
)
ON CONFLICT (tenant_id, request_key) DO NOTHING
RETURNING *;

-- name: GetTenantHandoverByRequestKey :one
SELECT * FROM tenant_handovers
WHERE tenant_id = sqlc.arg(tenant_id) AND request_key = sqlc.arg(request_key);

-- name: GetTenantHandover :one
SELECT * FROM tenant_handovers
WHERE tenant_id = sqlc.arg(tenant_id) AND id = sqlc.arg(id);

-- name: GetTenantHandoverByID :one
SELECT * FROM tenant_handovers
WHERE id = sqlc.arg(id);

-- name: LockTenantHandover :one
SELECT * FROM tenant_handovers
WHERE id = sqlc.arg(id)
FOR UPDATE;

-- name: CancelTenantHandover :one
UPDATE tenant_handovers
SET status = 'canceled', canceled_by_kind = sqlc.arg(canceled_by_kind),
    canceled_by_service_id = sqlc.narg(canceled_by_service_id), canceled_by_operator = sqlc.narg(canceled_by_operator),
    canceled_at = sqlc.arg(canceled_at), updated_at = sqlc.arg(canceled_at)
WHERE id = sqlc.arg(id) AND status = 'pending' AND expires_at > sqlc.arg(canceled_at)
RETURNING *;

-- name: LockTenantHandoverUserEmail :exec
SELECT pg_advisory_xact_lock(hashtext(lower(sqlc.arg(email))));

-- name: GetTenantHandoverUserID :one
SELECT id FROM users WHERE lower(email) = lower(sqlc.arg(email)) ORDER BY created_at, id LIMIT 1;

-- name: CreateTenantHandoverUser :one
INSERT INTO users (id, name, email) VALUES (sqlc.arg(id), sqlc.arg(name), sqlc.arg(email))
ON CONFLICT (email) DO UPDATE SET name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE users.name END, updated_at = now()
RETURNING id;

-- name: UpsertTenantHandoverOwnerMembership :one
INSERT INTO memberships (id, tenant_id, user_id, role) VALUES (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(user_id), 'owner')
ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner', updated_at = now()
RETURNING id;

-- name: TransferTenantHandoverOwnership :one
UPDATE tenants
SET created_by_service_id = sqlc.arg(to_service_id), updated_at = sqlc.arg(transferred_at)
WHERE id = sqlc.arg(tenant_id) AND created_by_service_id = sqlc.arg(from_service_id)
RETURNING id;

-- name: RevokeTenantHandoverAPIKeys :execrows
UPDATE api_keys
SET revoked_at = sqlc.arg(revoked_at), updated_at = sqlc.arg(revoked_at)
WHERE tenant_id = sqlc.arg(tenant_id) AND revoked_at IS NULL;

-- name: DisableTenantHandoverWebhookEndpoints :execrows
UPDATE webhook_endpoints
SET enabled = false, revision = revision + 1, updated_at = sqlc.arg(disabled_at)
WHERE tenant_id = sqlc.arg(tenant_id) AND enabled AND deleted_at IS NULL;

-- name: CancelTenantHandoverWebhookDeliveries :execrows
UPDATE webhook_deliveries
SET state = 'canceled', next_attempt_at = null, terminal_at = sqlc.arg(canceled_at), updated_at = sqlc.arg(canceled_at),
    lease_token = null, lease_owner = null, lease_expires_at = null
WHERE tenant_id = sqlc.arg(tenant_id) AND state IN ('pending', 'retry_wait', 'delivering');

-- name: AcceptTenantHandover :one
UPDATE tenant_handovers
SET status = 'accepted', accepted_by_user_id = sqlc.arg(accepted_by_user_id), accepted_at = sqlc.arg(accepted_at), updated_at = sqlc.arg(accepted_at)
WHERE id = sqlc.arg(id) AND status = 'pending' AND expires_at > sqlc.arg(accepted_at)
RETURNING *;

-- name: GetLatestAcceptedTenantHandoverForEmail :one
SELECT h.* FROM tenant_handovers h
JOIN users u ON u.id = h.accepted_by_user_id
JOIN memberships m ON m.tenant_id = h.tenant_id AND m.user_id = h.accepted_by_user_id
JOIN tenants t ON t.id = h.tenant_id AND t.created_by_service_id = h.to_service_id
WHERE h.status = 'accepted' AND lower(u.email) = lower(sqlc.arg(email))
ORDER BY h.accepted_at DESC, h.id DESC
LIMIT 1;
