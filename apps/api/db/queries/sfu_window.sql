-- name: ListRoutableSFUWindowNodes :many
select id, control_address, phase
from sfu_window_nodes
where application_id = $1 and phase in ('serving', 'draining', 'deleting') and control_address is not null
order by created_at, id;

-- name: ListSFUWindowNodes :many
select *
from sfu_window_nodes
where application_id = $1 and deleted_at is null
order by created_at, id;

-- name: ReserveSFUWindowNode :execrows
insert into sfu_window_nodes (id, application_id)
select sqlc.arg(id), sqlc.arg(application_id)
where (select count(*) from sfu_window_nodes
       where application_id = sqlc.arg(application_id) and deleted_at is null) < sqlc.arg(max_nodes)::bigint;

-- name: SetSFUWindowNodePhase :execrows
update sfu_window_nodes
set provider_id = sqlc.narg(provider_id),
    control_address = sqlc.narg(control_address),
    phase = sqlc.arg(next_phase),
    empty_since = sqlc.narg(empty_since),
    empty_incarnation = sqlc.narg(empty_incarnation),
    deleted_at = case when sqlc.arg(next_phase) = 'deleted' then clock_timestamp() end
where id = sqlc.arg(id) and phase = sqlc.arg(from_phase);

-- name: IsSFUWindowNodeUnbound :one
select not exists (
    select 1 from episodes
    where status in ('active', 'ending')
      and config_snapshot -> 'media_plane_binding' ->> 'provider' = 'chalk_sfu'
      and config_snapshot -> 'media_plane_binding' ->> 'node' = sqlc.arg(node_id)::text
) as unbound;

-- name: ReadSFUWindowNodeSeconds :one
select coalesce(sum(extract(epoch from
    least(coalesce(deleted_at, sqlc.arg(observed_at)::timestamptz), sqlc.arg(observed_at)::timestamptz)
    - greatest(created_at, sqlc.arg(since)::timestamptz)
)), 0)::bigint as node_seconds
from sfu_window_nodes
where application_id = sqlc.arg(application_id)
  and created_at <= sqlc.arg(observed_at)::timestamptz
  and (deleted_at is null or deleted_at > sqlc.arg(since)::timestamptz);

-- name: ListSFULiveDemand :many
select episode.tenant_id, episode.space_id, episode.started_at,
    (select count(*) from participants participant
     where participant.tenant_id = episode.tenant_id and participant.space_id = episode.space_id
       and participant.episode_id = episode.id
       and participant.status in ('joining', 'active', 'leaving'))::integer as participants
from episodes episode
where episode.status in ('active', 'ending')
  and episode.config_snapshot -> 'media_plane_binding' ->> 'provider' = 'chalk_sfu'
  and episode.config_snapshot -> 'media_plane_binding' ->> 'adapter_fingerprint' = sqlc.arg(fingerprint)::text;

-- name: ForgetSFUWindowIntent :execrows
delete from sfu_window_nodes
where id = $1 and phase = 'starting' and provider_id is null;
