-- name: CreateAuditLog :one
insert into audit_logs (
    id,
    tenant_id,
    actor_user_id,
    actor_type,
    action,
    details,
    outcome,
    error_code,
    error_message,
    before,
    after
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.narg(actor_user_id),
    sqlc.arg(actor_type),
    sqlc.arg(action),
    sqlc.narg(details),
    sqlc.arg(outcome),
    sqlc.narg(error_code),
    sqlc.narg(error_message),
    sqlc.narg(before),
    sqlc.narg(after)
)
returning
    id,
    tenant_id,
    actor_user_id,
    actor_type,
    action,
    details,
    outcome,
    error_code,
    error_message,
    before,
    after,
    updated_at,
    created_at;

-- name: GetTenantAuditLog :one
select
    id,
    tenant_id,
    actor_user_id,
    actor_type,
    action,
    details,
    outcome,
    error_code,
    error_message,
    before,
    after,
    updated_at,
    created_at
from audit_logs
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: ListTenantAuditLogs :many
select
    id,
    tenant_id,
    actor_user_id,
    actor_type,
    action,
    details,
    outcome,
    error_code,
    error_message,
    before,
    after,
    updated_at,
    created_at
from audit_logs
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;
