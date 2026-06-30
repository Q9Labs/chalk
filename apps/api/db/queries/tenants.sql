-- name: GetTenant :one
select
    id,
    name,
    default_region,
    default_media_plane,
    logo_key,
    website,
    updated_at,
    created_at
from tenants
where id = $1;
