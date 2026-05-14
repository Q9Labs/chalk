-- Ops incident platform queries

-- name: CreateOpsIncident :one
INSERT INTO ops_incidents (
    incident_code,
    title,
    summary,
    severity,
    status,
    visibility,
    source_kind,
    source_key,
    component_ids,
    dedupe_key,
    idempotency_key,
    public_message,
    public_title,
    metadata,
    first_seen_at,
    last_seen_at,
    published_at,
    resolved_at,
    created_by
) VALUES (
    sqlc.arg(incident_code),
    sqlc.arg(title),
    sqlc.narg(summary),
    sqlc.arg(severity),
    sqlc.arg(status),
    sqlc.arg(visibility),
    sqlc.arg(source_kind),
    sqlc.narg(source_key),
    sqlc.arg(component_ids),
    sqlc.narg(dedupe_key),
    sqlc.narg(idempotency_key),
    sqlc.narg(public_message),
    sqlc.narg(public_title),
    sqlc.arg(metadata),
    sqlc.arg(first_seen_at),
    sqlc.arg(last_seen_at),
    sqlc.narg(published_at),
    sqlc.narg(resolved_at),
    sqlc.arg(created_by)
)
RETURNING *;

-- name: GetOpsIncidentByCode :one
SELECT * FROM ops_incidents
WHERE incident_code = $1
LIMIT 1;

-- name: GetActiveOpsIncidentBySource :one
SELECT * FROM ops_incidents
WHERE source_kind = $1
  AND source_key = $2
  AND status <> 'resolved'
ORDER BY created_at DESC
LIMIT 1;

-- name: ListOpsIncidents :many
SELECT * FROM ops_incidents
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListActiveOpsIncidents :many
SELECT * FROM ops_incidents
WHERE status <> 'resolved'
ORDER BY created_at DESC;

-- name: UpdateOpsIncidentState :one
UPDATE ops_incidents
SET
    status = sqlc.arg(status),
    summary = COALESCE(sqlc.narg(summary), summary),
    visibility = COALESCE(sqlc.narg(visibility), visibility),
    public_message = COALESCE(sqlc.narg(public_message), public_message),
    public_title = COALESCE(sqlc.narg(public_title), public_title),
    last_seen_at = COALESCE(sqlc.narg(last_seen_at), last_seen_at),
    resolved_at = COALESCE(sqlc.narg(resolved_at), resolved_at),
    published_at = COALESCE(sqlc.narg(published_at), published_at),
    metadata = COALESCE(sqlc.narg(metadata), metadata),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: TouchOpsIncidentObservation :one
UPDATE ops_incidents
SET
    last_seen_at = sqlc.arg(last_seen_at),
    updated_at = NOW()
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: AppendOpsIncidentEvent :one
INSERT INTO ops_incident_events (
    incident_id,
    event_type,
    visibility,
    actor_kind,
    actor_id,
    message,
    metadata,
    idempotency_key,
    event_at
) VALUES (
    sqlc.arg(incident_id),
    sqlc.arg(event_type),
    sqlc.arg(visibility),
    sqlc.arg(actor_kind),
    sqlc.arg(actor_id),
    sqlc.arg(message),
    sqlc.arg(metadata),
    sqlc.narg(idempotency_key),
    sqlc.arg(event_at)
)
RETURNING *;

-- name: ListOpsIncidentEvents :many
SELECT * FROM ops_incident_events
WHERE incident_id = $1
ORDER BY event_at ASC, created_at ASC;

-- name: CreateOpsMonitorResult :one
INSERT INTO ops_monitor_results (
    monitor_key,
    monitor_kind,
    status,
    http_status,
    latency_ms,
    checked_at,
    run_id,
    result_key,
    error_code,
    error_message,
    details,
    reported_source,
    reported_emitter_id
) VALUES (
    sqlc.arg(monitor_key),
    sqlc.arg(monitor_kind),
    sqlc.arg(status),
    sqlc.narg(http_status),
    sqlc.narg(latency_ms),
    sqlc.arg(checked_at),
    sqlc.narg(run_id),
    sqlc.arg(result_key),
    sqlc.narg(error_code),
    sqlc.narg(error_message),
    sqlc.arg(details),
    sqlc.narg(reported_source),
    sqlc.narg(reported_emitter_id)
)
ON CONFLICT (result_key) DO UPDATE
SET
    monitor_key = EXCLUDED.monitor_key,
    monitor_kind = EXCLUDED.monitor_kind,
    status = EXCLUDED.status,
    http_status = EXCLUDED.http_status,
    latency_ms = EXCLUDED.latency_ms,
    checked_at = EXCLUDED.checked_at,
    run_id = EXCLUDED.run_id,
    error_code = EXCLUDED.error_code,
    error_message = EXCLUDED.error_message,
    details = EXCLUDED.details,
    reported_source = EXCLUDED.reported_source,
    reported_emitter_id = EXCLUDED.reported_emitter_id
RETURNING *;

-- name: GetLatestOpsMonitorResult :one
SELECT * FROM ops_monitor_results
WHERE monitor_key = $1
ORDER BY checked_at DESC, ingested_at DESC
LIMIT 1;

-- name: ListLatestOpsMonitorResults :many
SELECT DISTINCT ON (monitor_key) *
FROM ops_monitor_results
ORDER BY monitor_key, checked_at DESC, ingested_at DESC;

-- name: GetLatestOpsMonitorIngestAt :one
SELECT ingested_at
FROM ops_monitor_results
ORDER BY ingested_at DESC
LIMIT 1;

-- name: CreateOpsHeartbeatEvent :one
INSERT INTO ops_heartbeat_events (
    heartbeat_key,
    status,
    event_at,
    event_key,
    error_message,
    details,
    reported_source,
    reported_emitter_id
) VALUES (
    sqlc.arg(heartbeat_key),
    sqlc.arg(status),
    sqlc.arg(event_at),
    sqlc.arg(event_key),
    sqlc.narg(error_message),
    sqlc.arg(details),
    sqlc.narg(reported_source),
    sqlc.narg(reported_emitter_id)
)
ON CONFLICT (event_key) DO UPDATE
SET
    heartbeat_key = EXCLUDED.heartbeat_key,
    status = EXCLUDED.status,
    event_at = EXCLUDED.event_at,
    error_message = EXCLUDED.error_message,
    details = EXCLUDED.details,
    reported_source = EXCLUDED.reported_source,
    reported_emitter_id = EXCLUDED.reported_emitter_id
RETURNING *;

-- name: GetLatestOpsHeartbeatEvent :one
SELECT * FROM ops_heartbeat_events
WHERE heartbeat_key = $1
ORDER BY event_at DESC, ingested_at DESC
LIMIT 1;

-- name: ListLatestOpsHeartbeatEvents :many
SELECT DISTINCT ON (heartbeat_key) *
FROM ops_heartbeat_events
ORDER BY heartbeat_key, event_at DESC, ingested_at DESC;

-- name: CreateOpsNotificationDelivery :one
INSERT INTO ops_notification_deliveries (
    incident_id,
    channel,
    recipient,
    dedupe_key,
    template,
    status,
    provider,
    payload,
    next_retry_at
) VALUES (
    sqlc.narg(incident_id),
    sqlc.arg(channel),
    sqlc.arg(recipient),
    sqlc.arg(dedupe_key),
    sqlc.arg(template),
    sqlc.arg(status),
    sqlc.arg(provider),
    sqlc.arg(payload),
    sqlc.arg(next_retry_at)
)
ON CONFLICT (channel, recipient, dedupe_key) DO UPDATE
SET
    payload = EXCLUDED.payload,
    next_retry_at = LEAST(ops_notification_deliveries.next_retry_at, EXCLUDED.next_retry_at)
RETURNING *;

-- name: ListPendingOpsNotificationDeliveries :many
SELECT * FROM ops_notification_deliveries
WHERE status IN ('pending', 'retrying')
  AND next_retry_at <= NOW()
ORDER BY next_retry_at ASC, created_at ASC
LIMIT $1;

-- name: MarkOpsNotificationSent :exec
UPDATE ops_notification_deliveries
SET
    status = 'sent',
    provider_message_id = $2,
    attempts = attempts + 1,
    last_error = NULL,
    sent_at = NOW(),
    updated_at = NOW()
WHERE id = $1;

-- name: MarkOpsNotificationRetry :exec
UPDATE ops_notification_deliveries
SET
    status = 'retrying',
    attempts = attempts + 1,
    last_error = $2,
    next_retry_at = $3,
    updated_at = NOW()
WHERE id = $1;

-- name: MarkOpsNotificationFailed :exec
UPDATE ops_notification_deliveries
SET
    status = 'failed',
    attempts = attempts + 1,
    last_error = $2,
    updated_at = NOW()
WHERE id = $1;

-- name: CreateOpsMaintenanceWindow :one
INSERT INTO ops_maintenance_windows (
    title,
    summary,
    component_ids,
    visibility,
    status,
    starts_at,
    ends_at,
    created_by,
    public_message,
    metadata
) VALUES (
    sqlc.arg(title),
    sqlc.narg(summary),
    sqlc.arg(component_ids),
    sqlc.arg(visibility),
    sqlc.arg(status),
    sqlc.arg(starts_at),
    sqlc.arg(ends_at),
    sqlc.arg(created_by),
    sqlc.narg(public_message),
    sqlc.arg(metadata)
)
RETURNING *;

-- name: ListOpsMaintenanceWindows :many
SELECT * FROM ops_maintenance_windows
ORDER BY starts_at DESC;

-- name: ListActivePublicOpsMaintenanceWindows :many
SELECT * FROM ops_maintenance_windows
WHERE visibility = 'public'
  AND status = 'scheduled'
  AND ends_at >= NOW()
ORDER BY starts_at ASC;

-- name: CancelOpsMaintenanceWindow :one
UPDATE ops_maintenance_windows
SET
    status = 'cancelled',
    cancelled_at = NOW(),
    updated_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ListPublicOpsIncidents :many
SELECT * FROM ops_incidents
WHERE visibility = 'public'
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListActivePublicOpsIncidents :many
SELECT * FROM ops_incidents
WHERE visibility = 'public'
  AND status <> 'resolved'
ORDER BY created_at DESC;

-- name: ListRecentResolvedPublicOpsIncidents :many
SELECT * FROM ops_incidents
WHERE visibility = 'public'
  AND status = 'resolved'
ORDER BY resolved_at DESC NULLS LAST, created_at DESC
LIMIT $1;

-- name: ListPublicOpsIncidentEvents :many
SELECT * FROM ops_incident_events
WHERE incident_id = $1
  AND visibility = 'public'
ORDER BY event_at ASC, created_at ASC;

-- name: DeleteOldOpsMonitorResults :exec
DELETE FROM ops_monitor_results
WHERE checked_at < $1;

-- name: DeleteOldOpsHeartbeatEvents :exec
DELETE FROM ops_heartbeat_events
WHERE event_at < $1;
