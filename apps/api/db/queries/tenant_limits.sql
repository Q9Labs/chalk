-- name: LockTenantMediaLimits :one
select id from tenants where id = $1 for no key update;

-- name: CountTenantLiveEpisodes :one
select count(*) from episodes where tenant_id = $1 and status in ('active', 'ending');

-- name: GetTenantRecordingUsage :one
select
    count(*) filter (where r.state = 'reserved')::bigint as active_count,
    coalesce(sum(greatest(0, extract(epoch from (
        least(sqlc.arg(observed_at)::timestamptz, r.ends_at,
            coalesce(p.capture_completed_at, case when r.state <> 'reserved' then r.updated_at end, sqlc.arg(observed_at)::timestamptz))
        - coalesce(p.capture_ready_at, r.starts_at, r.created_at)
    )))) filter (
        where coalesce(p.capture_ready_at, r.starts_at, r.created_at) >= sqlc.arg(day_start)::timestamptz
          and coalesce(p.capture_ready_at, r.starts_at, r.created_at) < sqlc.arg(day_start)::timestamptz + interval '24 hours'
    ), 0)::double precision as recording_seconds
from recording_reservations r
join recording_pipelines p on p.recording_id = r.recording_id and p.tenant_id = r.tenant_id
where r.tenant_id = sqlc.arg(tenant_id);
