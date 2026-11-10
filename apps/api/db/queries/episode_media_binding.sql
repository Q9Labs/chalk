-- name: LockTenantMediaPolicyForEpisode :one
select default_media_plane, default_media_plane_approved, media_plane_provider_config
from tenants
where id = $1
for share;
