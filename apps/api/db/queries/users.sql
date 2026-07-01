-- name: GetUser :one
select
    id,
    name,
    email,
    updated_at,
    created_at
from users
where id = $1;

-- name: ListUsers :many
select
    id,
    name,
    email,
    updated_at,
    created_at
from users
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

-- name: CreateUser :one
insert into users (
    id,
    name,
    email
) values (
    sqlc.arg(id),
    sqlc.arg(name),
    sqlc.arg(email)
)
returning
    id,
    name,
    email,
    updated_at,
    created_at;
