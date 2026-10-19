-- name: ListSpaceLiveEpisodes :many
select s.id as space_id, e.id as episode_id,
       coalesce(c.folded_state -> 'participants', '[]'::jsonb)::jsonb as participants
from spaces s
left join episodes e on e.tenant_id = s.tenant_id and e.space_id = s.id and e.status in ('active', 'ending')
left join sync_episode_control c on c.tenant_id = e.tenant_id and c.space_id = e.space_id and c.episode_id = e.id
where s.tenant_id = sqlc.arg(tenant_id) and s.id = any(sqlc.arg(space_ids)::uuid[])
order by s.id;
