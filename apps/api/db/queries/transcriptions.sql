-- name: CreateTranscription :one
insert into transcriptions (
    id,
    tenant_id,
    recording_id,
    room_id,
    session_id,
    status,
    provider,
    model,
    languages,
    text,
    metadata,
    completed_at
) select
    sqlc.arg(id),
    recordings.tenant_id,
    recordings.id,
    recordings.room_id,
    recordings.session_id,
    sqlc.arg(status),
    sqlc.arg(provider),
    sqlc.arg(model),
    sqlc.arg(languages),
    sqlc.narg(text),
    sqlc.narg(metadata),
    sqlc.narg(completed_at)
from recordings
where
    recordings.tenant_id = sqlc.arg(tenant_id)
    and recordings.id = sqlc.arg(recording_id)
    and recordings.room_id = sqlc.arg(room_id)
    and recordings.session_id = sqlc.arg(session_id)
returning
    id,
    tenant_id,
    recording_id,
    room_id,
    session_id,
    status,
    provider,
    model,
    languages,
    text,
    metadata,
    completed_at,
    updated_at,
    created_at;

-- name: GetTenantTranscription :one
select
    id,
    tenant_id,
    recording_id,
    room_id,
    session_id,
    status,
    provider,
    model,
    languages,
    text,
    metadata,
    completed_at,
    updated_at,
    created_at
from transcriptions
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: ListTenantTranscriptions :many
select
    id,
    tenant_id,
    recording_id,
    room_id,
    session_id,
    status,
    provider,
    model,
    languages,
    text,
    metadata,
    completed_at,
    updated_at,
    created_at
from transcriptions
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        sqlc.narg(recording_id)::uuid is null
        or recording_id = sqlc.narg(recording_id)::uuid
    )
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantTranscription :one
update transcriptions
set
    status = case
        when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text
        else status
    end,
    provider = case
        when sqlc.arg(provider_set)::boolean then sqlc.arg(provider)::text
        else provider
    end,
    model = case
        when sqlc.arg(model_set)::boolean then sqlc.arg(model)::text
        else model
    end,
    languages = case
        when sqlc.arg(languages_set)::boolean then sqlc.arg(languages)::text[]
        else languages
    end,
    text = case
        when sqlc.arg(text_set)::boolean then sqlc.narg(text)::text
        else text
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    completed_at = case
        when sqlc.arg(completed_at_set)::boolean then sqlc.narg(completed_at)::timestamptz
        else completed_at
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    tenant_id,
    recording_id,
    room_id,
    session_id,
    status,
    provider,
    model,
    languages,
    text,
    metadata,
    completed_at,
    updated_at,
    created_at;
