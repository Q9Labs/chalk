-- name: LockTenantMediaPolicyForEpisode :one
select default_media_plane, media_plane_provider_config
from tenants
where id = $1
for share;
