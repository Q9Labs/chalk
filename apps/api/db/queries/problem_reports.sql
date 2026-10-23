-- name: GetProblemReportAttribution :one
select s.name as space_name,
    coalesce(case when p.name ~ '[^[:space:]@<>]+@[^[:space:]@<>]+' then
        case when p.role = 'owner' or p.account_id = s.created_by_user_id then 'Space owner' else 'Participant' end
        else p.name end, 'Participant')::text as reporter_name,
    (case when p.role = 'owner' or p.account_id = s.created_by_user_id then 'owner' else 'guest' end)::text as reporter_role
from participants p
join spaces s on s.tenant_id = p.tenant_id and s.id = p.space_id
where p.tenant_id = sqlc.arg(tenant_id) and p.space_id = sqlc.arg(space_id)
    and p.episode_id = sqlc.arg(episode_id) and p.id = sqlc.arg(participant_id)
    and p.generation = sqlc.arg(participant_generation);
