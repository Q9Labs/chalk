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

-- name: ListTenants :many
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
where
    (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: CreateTenant :one
insert into tenants (
    id,
    name,
    default_region,
    default_media_plane,
    logo_key,
    website
) values (
    sqlc.arg(id),
    sqlc.arg(name),
    sqlc.narg(default_region),
    sqlc.narg(default_media_plane),
    sqlc.narg(logo_key),
    sqlc.narg(website)
)
returning
    id,
    name,
    default_region,
    default_media_plane,
    logo_key,
    website,
    updated_at,
    created_at;

-- name: UpdateTenant :one
update tenants
set
    name = case
        when sqlc.arg(name_set)::boolean then sqlc.arg(name)::text
        else name
    end,
    default_region = case
        when sqlc.arg(default_region_set)::boolean then sqlc.narg(default_region)::text
        else default_region
    end,
    default_media_plane = case
        when sqlc.arg(default_media_plane_set)::boolean then sqlc.narg(default_media_plane)::text
        else default_media_plane
    end,
    logo_key = case
        when sqlc.arg(logo_key_set)::boolean then sqlc.narg(logo_key)::text
        else logo_key
    end,
    website = case
        when sqlc.arg(website_set)::boolean then sqlc.narg(website)::text
        else website
    end,
    updated_at = now()
where id = sqlc.arg(id)
returning
    id,
    name,
    default_region,
    default_media_plane,
    logo_key,
    website,
    updated_at,
    created_at;
