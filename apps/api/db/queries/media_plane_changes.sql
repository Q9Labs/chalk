-- name: ClaimUnemittedMediaPlaneChanges :many
select id, changed_at, scope, tenant_id, space_id, old_plane, new_plane, actor, reason, trace_id
from media_plane_changes
where emitted_at is null
order by id
limit $1
for update skip locked;

-- name: MarkMediaPlaneChangesEmitted :exec
update media_plane_changes set emitted_at = now() where id = any($1::bigint[]);
