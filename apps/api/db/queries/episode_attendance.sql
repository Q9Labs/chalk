-- name: GetEpisodeAttendance :many
select e.id as episode_id, p.id as participant_id, p.name as display_name,
    (case when i.id is not null then i.kind
          when p.account_id is not null then 'user'
          else 'guest' end)::text as identity_kind,
    i.external_id, coalesce(p.first_joined_at, p.joined_at)::timestamptz as first_joined_at,
    (case when e.status = 'ended' and p.status != 'left' then e.ended_at
          when e.status = 'ended' then coalesce(p.left_at, e.ended_at)
          when p.status = 'left' then p.left_at
          else null end)::timestamptz as last_left_at,
    coalesce((case when e.status = 'ended' and (p.status != 'left' or p.left_at is null or p.last_left_reason = 'episode_ended' or (p.last_left_reason is null and p.left_at = e.ended_at)) then 'episode_ended'
          when p.status = 'left' then 'left'
          else null end), '')::text as left_reason
from episodes e
left join participants p on p.tenant_id = e.tenant_id and p.space_id = e.space_id
    and p.episode_id = e.id and coalesce(p.first_joined_at, p.joined_at) is not null
left join identities i on i.tenant_id = p.tenant_id and i.id = p.identity_id
where e.tenant_id = sqlc.arg(tenant_id) and e.space_id = sqlc.arg(space_id)
    and e.id = sqlc.arg(episode_id)
order by coalesce(p.first_joined_at, p.joined_at), p.id;
