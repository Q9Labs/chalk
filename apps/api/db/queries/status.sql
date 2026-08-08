-- name: InsertStatusMonitorResult :one
insert into status_monitor_results (
    result_key,
    run_id,
    monitor_key,
    status,
    checked_at,
    event_at,
    latency_ms,
    http_status,
    error_code,
    error_message,
    response_excerpt,
    reported_source,
    reported_emitter_id,
    metadata,
    details,
    received_at
) values (
    sqlc.arg(result_key),
    sqlc.arg(run_id),
    sqlc.arg(monitor_key),
    sqlc.arg(status),
    sqlc.arg(checked_at),
    sqlc.arg(event_at),
    sqlc.arg(latency_ms),
    sqlc.narg(http_status),
    sqlc.narg(error_code),
    sqlc.narg(error_message),
    sqlc.narg(response_excerpt),
    sqlc.arg(reported_source),
    sqlc.arg(reported_emitter_id),
    sqlc.arg(metadata),
    sqlc.arg(details),
    sqlc.arg(received_at)
)
on conflict (result_key) do nothing
returning result_key, run_id, monitor_key, status, checked_at, event_at, latency_ms,
    http_status, error_code, error_message, response_excerpt, reported_source,
    reported_emitter_id, metadata, details, received_at;

-- name: UpsertStatusMonitorCurrent :one
insert into status_monitor_current (
    monitor_key,
    result_key,
    run_id,
    status,
    checked_at,
    last_changed_at,
    received_at
) values (
    sqlc.arg(monitor_key),
    sqlc.arg(result_key),
    sqlc.arg(run_id),
    sqlc.arg(status),
    sqlc.arg(checked_at),
    sqlc.arg(checked_at),
    sqlc.arg(received_at)
)
on conflict (monitor_key) do update set
    result_key = excluded.result_key,
    run_id = excluded.run_id,
    status = excluded.status,
    checked_at = excluded.checked_at,
    last_changed_at = case
        when status_monitor_current.status is distinct from excluded.status then excluded.checked_at
        else status_monitor_current.last_changed_at
    end,
    received_at = excluded.received_at
where excluded.checked_at > status_monitor_current.checked_at
   or (excluded.checked_at = status_monitor_current.checked_at and excluded.received_at > status_monitor_current.received_at)
returning monitor_key, result_key, run_id, status, checked_at, last_changed_at, received_at;

-- name: ListStatusMonitorCurrent :many
select monitor_key, result_key, run_id, status, checked_at, last_changed_at, received_at
from status_monitor_current
order by monitor_key asc;
