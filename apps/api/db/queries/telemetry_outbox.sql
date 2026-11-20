-- name: LockTelemetryOutbox :exec
lock table telemetry_outbox in row exclusive mode;

-- name: InsertTelemetryOutbox :exec
insert into telemetry_outbox (tenant_id, payload) values ($1, $2);

-- name: LockReadyTelemetryOutbox :many
with head as (
    select id, retry from telemetry_outbox
    where available_at <= now()
    order by available_at, id
    limit 1 for update skip locked
)
select queue.id, queue.payload
from telemetry_outbox as queue cross join head
where queue.available_at <= now()
  and (queue.id = head.id or (not head.retry and not queue.retry))
order by queue.available_at, queue.id
limit 16
for update of queue skip locked;

-- name: DeleteShippedTelemetryOutbox :exec
delete from telemetry_outbox where id = any(sqlc.arg(ids)::bigint[]);

-- name: DelayTelemetryOutbox :exec
update telemetry_outbox
set available_at = now() + interval '1 minute', retry = true
where id = any(sqlc.arg(ids)::bigint[]);
