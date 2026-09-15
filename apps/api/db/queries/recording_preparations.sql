-- name: PrepareRecordingSpace :one
with written as (
    insert into recording_preparations (tenant_id, space_id, starts_at, state, revision, request_revision, request_kind, updated_at, created_at)
    select sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(starts_at), 'scheduled', 1, 0, 'prepare', sqlc.arg(observed_at), sqlc.arg(observed_at)
    from spaces
    where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(space_id)
      and archived_at is null and recording_policy <> 'disabled'
      and (sqlc.arg(expected_revision)::bigint = 0 or exists (
          select 1 from recording_preparations where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
      ))
    on conflict (tenant_id, space_id) do update
    set starts_at = excluded.starts_at, state = 'scheduled', revision = recording_preparations.revision + 1,
        request_revision = sqlc.arg(expected_revision), request_kind = 'prepare', consumed_recording_id = null,
        updated_at = excluded.updated_at
    where recording_preparations.revision = sqlc.arg(expected_revision)
    returning *
)
select * from written
union all
select * from recording_preparations
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and request_kind = 'prepare' and request_revision = sqlc.arg(expected_revision)
  and starts_at = sqlc.arg(starts_at) and not exists (select 1 from written);

-- name: CancelRecordingPreparation :one
with canceled as (
    update recording_preparations preparation
    set state = 'canceled', revision = preparation.revision + 1, request_revision = sqlc.arg(expected_revision),
        request_kind = 'cancel', updated_at = sqlc.arg(observed_at)
    where preparation.tenant_id = sqlc.arg(tenant_id) and preparation.space_id = sqlc.arg(space_id)
      and preparation.revision = sqlc.arg(expected_revision) and preparation.state = 'scheduled'
    returning preparation.*
)
select * from canceled
union all
select preparation.* from recording_preparations preparation
where preparation.tenant_id = sqlc.arg(tenant_id) and preparation.space_id = sqlc.arg(space_id)
  and not exists (select 1 from canceled)
  and ((preparation.request_kind = 'cancel' and preparation.request_revision = sqlc.arg(expected_revision))
      or (preparation.state in ('consumed', 'expired', 'canceled') and preparation.revision = sqlc.arg(expected_revision)));

-- name: GetRecordingPreparation :one
with eligible as (
    select preparation.tenant_id, preparation.space_id,
        row_number() over (order by preparation.starts_at, preparation.tenant_id, preparation.space_id) as position
    from recording_preparations preparation
    join spaces on spaces.tenant_id = preparation.tenant_id and spaces.id = preparation.space_id
    where preparation.state = 'scheduled'
      and preparation.starts_at <= sqlc.arg(observed_at)::timestamptz + interval '5 minutes'
      and preparation.starts_at > sqlc.arg(observed_at)::timestamptz - interval '5 minutes'
      and spaces.archived_at is null and spaces.recording_policy <> 'disabled'
), capacity as (
    select greatest(0, 10 - reserved_episodes)::integer as available, reserved_episodes as occupied
    from recording_capacity where id = 1
), ready as (
    select coalesce(max(ready_capacity), 0)::integer as available from recording_pool_health
    where role = 'capture' and admission_open
      and observed_at <= sqlc.arg(observed_at)::timestamptz + interval '1 second'
      and observed_at >= sqlc.arg(observed_at)::timestamptz - interval '30 seconds'
)
select preparation.*,
    coalesce(eligible.position <= capacity.available, false)::boolean as capacity_available,
    coalesce(eligible.position <= least(capacity.available, greatest(0, ready.available - capacity.occupied)), false)::boolean as ready
from recording_preparations preparation
left join eligible on eligible.tenant_id = preparation.tenant_id and eligible.space_id = preparation.space_id
cross join capacity cross join ready
where preparation.tenant_id = sqlc.arg(tenant_id) and preparation.space_id = sqlc.arg(space_id);
