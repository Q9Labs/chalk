-- name: EnsureTelemetrySource :exec
insert into telemetry_sources (tenant_id, source_id, participant_id, episode_id, first_received_at, last_received_at)
values ($1, $2, $3, $4, $5, $5)
on conflict (tenant_id, source_id, participant_id) do nothing;

-- name: LockTelemetrySources :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and participant_id = $2 and source_id = any(@source_ids::uuid[])
order by source_id
for update;

-- name: UpdateTelemetrySource :exec
update telemetry_sources
set ranges = $4, reported_next_seq = $5, end_state = $6, end_next_seq = $7, last_received_at = $8
where tenant_id = $1 and source_id = $2 and participant_id = $3;

-- name: ListTelemetrySourceRows :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and source_id = $2
order by participant_id;

-- name: ListTelemetryEpisodeRows :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and episode_id = $2
order by source_id, participant_id;
