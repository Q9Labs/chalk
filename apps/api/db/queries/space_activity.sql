-- name: ListSpaceActivity :many
select s.id as space_id, (s.archived_at is not null)::bool as archived, live.id as live_episode_id,
       coalesce(jsonb_array_length(c.folded_state -> 'participants'), 0)::int as live_participant_count,
       coalesce((select jsonb_agg(roster.value order by roster.position)
                 from jsonb_array_elements(c.folded_state -> 'participants') with ordinality as roster(value, position)
                 where roster.position <= 5), '[]'::jsonb)::jsonb as live_participants,
       latest.id as latest_episode_id, coalesce(latest.status, '')::text as status, latest.started_at, latest.ended_at,
       coalesce(recent.participants, '[]'::jsonb)::jsonb as recent_participants
from spaces s
left join episodes live on live.tenant_id = s.tenant_id and live.space_id = s.id and live.status in ('active', 'ending')
left join sync_episode_control c on c.tenant_id = live.tenant_id and c.space_id = live.space_id and c.episode_id = live.id
left join lateral (
    select e.id, e.status, coalesce(e.started_at, e.created_at) as started_at, e.ended_at
    from episodes e
    where e.tenant_id = s.tenant_id and e.space_id = s.id
    order by e.created_at desc, e.id desc
    limit 1
) latest on true
left join lateral (
    select jsonb_agg(jsonb_build_object('participant_id', p.id, 'display_name', coalesce(p.name, ''))
                     order by p.first_joined_at desc, p.id) as participants
    from (
        select p.id, p.name, coalesce(p.first_joined_at, p.joined_at) as first_joined_at
        from participants p
        where p.tenant_id = s.tenant_id and p.space_id = s.id and p.episode_id = latest.id
          and coalesce(p.first_joined_at, p.joined_at) is not null
        order by coalesce(p.first_joined_at, p.joined_at) desc, p.id
        limit 5
    ) p
) recent on true
where s.tenant_id = sqlc.arg(tenant_id) and s.id = any(sqlc.arg(space_ids)::uuid[])
order by s.id;
