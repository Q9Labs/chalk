-- name: InsertTelemetryOutbox :exec
insert into telemetry_outbox (tenant_id, payload) values ($1, $2);

-- name: LockReadyTelemetryOutbox :many
select id, payload
from telemetry_outbox
where available_at <= now()
order by available_at, id
limit 16
for update skip locked;

-- name: DeleteShippedTelemetryOutbox :exec
delete from telemetry_outbox where id = any(sqlc.arg(ids)::bigint[]);

-- name: DelayTelemetryOutbox :exec
update telemetry_outbox
set available_at = now() + interval '1 minute'
where id = any(sqlc.arg(ids)::bigint[]);
