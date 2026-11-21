-- name: LockTelemetrySourceTable :exec
-- Row exclusive is the lock every write takes anyway. Taking it first orders the admission against
-- a tenant purge, which holds share row exclusive on every table: the purge either waits for this
-- transaction, then deletes what it wrote, or has committed before the participant check below.
lock table telemetry_sources in row exclusive mode;

-- name: LockTelemetrySource :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and source_id = $2
for update;

-- name: TelemetryParticipantLive :many
-- The participant row implies a live tenant (participants.tenant_id references tenants). The key
-- share lock keeps the row from being deleted until the admission commits.
select id from participants
where tenant_id = $1 and episode_id = $2 and id = $3
for key share;

-- name: LockTelemetryParticipant :many
-- The no key update lock serializes the source creations of one participant, so two concurrent
-- first batches cannot both pass the source budget.
select id from participants
where tenant_id = $1 and episode_id = $2 and id = $3
for no key update;

-- name: CountTelemetryParticipantSources :one
select count(*) from telemetry_sources where tenant_id = $1 and participant_id = $2;

-- name: InsertTelemetrySource :execrows
insert into telemetry_sources (tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
on conflict (tenant_id, source_id) do nothing;

-- name: UpdateTelemetrySource :exec
update telemetry_sources
set ranges = $3, reported_next_seq = $4, end_state = $5, end_next_seq = $6, last_received_at = $7
where tenant_id = $1 and source_id = $2;

-- name: GetTelemetrySource :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and source_id = $2;

-- name: ListTelemetryEpisodeRows :many
select tenant_id, source_id, participant_id, episode_id, ranges, reported_next_seq, end_state, end_next_seq, first_received_at, last_received_at
from telemetry_sources
where tenant_id = $1 and episode_id = $2
order by source_id;
