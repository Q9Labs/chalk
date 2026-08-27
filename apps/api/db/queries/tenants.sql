-- name: GetTenant :one
select
    tenants.id::uuid as id,
    tenants.name,
    tenants.default_region,
    tenants.default_media_plane,
    tenants.media_plane_provider_config,
    tenants.ai_provider_config,
    tenants.storage_provider_config,
    tenants.logo_key,
    tenants.website,
    tenant_artifact_policies.transcription_ceiling,
    tenant_artifact_policies.transcription_default_mode,
    tenant_artifact_policies.provider_policy_version,
    tenant_artifact_policies.recording_retention_seconds,
    tenant_artifact_policies.transcript_retention_seconds,
    tenant_artifact_policies.source_window_seconds,
    tenants.updated_at,
    tenants.created_at
from tenants
join tenant_artifact_policies on tenant_artifact_policies.tenant_id = tenants.id
where tenants.id = $1;

-- name: ListTenants :many
select
    tenants.id::uuid as id,
    tenants.name,
    tenants.default_region,
    tenants.default_media_plane,
    tenants.media_plane_provider_config,
    tenants.ai_provider_config,
    tenants.storage_provider_config,
    tenants.logo_key,
    tenants.website,
    tenant_artifact_policies.transcription_ceiling,
    tenant_artifact_policies.transcription_default_mode,
    tenant_artifact_policies.provider_policy_version,
    tenant_artifact_policies.recording_retention_seconds,
    tenant_artifact_policies.transcript_retention_seconds,
    tenant_artifact_policies.source_window_seconds,
    tenants.updated_at,
    tenants.created_at
from tenants
join tenant_artifact_policies on tenant_artifact_policies.tenant_id = tenants.id
where
    (
        not sqlc.arg(cursor_set)::boolean
        or (tenants.created_at, tenants.id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by tenants.created_at desc, tenants.id desc
limit sqlc.arg(page_size)::integer;

-- name: CreateTenant :one
with inserted as (
insert into tenants (
    id,
    name,
    default_region,
    default_media_plane,
    media_plane_provider_config,
    ai_provider_config,
    storage_provider_config,
    logo_key,
    website
) values (
    sqlc.arg(id),
    sqlc.arg(name),
    sqlc.narg(default_region),
    sqlc.narg(default_media_plane),
    sqlc.narg(media_plane_provider_config),
    sqlc.narg(ai_provider_config),
    sqlc.narg(storage_provider_config),
    sqlc.narg(logo_key),
    sqlc.narg(website)
)
returning *
), seeded as (
    insert into tenant_artifact_policies (tenant_id)
    select id
    from inserted
    returning
        tenant_id,
        transcription_ceiling,
        transcription_default_mode,
        provider_policy_version,
        recording_retention_seconds,
        transcript_retention_seconds,
        source_window_seconds
)
select
    inserted.id::uuid as id,
    inserted.name,
    inserted.default_region,
    inserted.default_media_plane,
    inserted.media_plane_provider_config,
    inserted.ai_provider_config,
    inserted.storage_provider_config,
    inserted.logo_key,
    inserted.website,
    seeded.transcription_ceiling,
    seeded.transcription_default_mode,
    seeded.provider_policy_version,
    seeded.recording_retention_seconds,
    seeded.transcript_retention_seconds,
    seeded.source_window_seconds,
    inserted.updated_at,
    inserted.created_at
from inserted
join seeded on seeded.tenant_id = inserted.id;

-- name: UpdateTenant :one
with updated_tenant as (
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
    media_plane_provider_config = case
        when sqlc.arg(media_plane_provider_config_set)::boolean then sqlc.narg(media_plane_provider_config)::jsonb
        else media_plane_provider_config
    end,
    ai_provider_config = case
        when sqlc.arg(ai_provider_config_set)::boolean then sqlc.narg(ai_provider_config)::jsonb
        else ai_provider_config
    end,
    storage_provider_config = case
        when sqlc.arg(storage_provider_config_set)::boolean then sqlc.narg(storage_provider_config)::jsonb
        else storage_provider_config
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
returning *
), updated_policy as (
update tenant_artifact_policies
set
    transcription_ceiling = case
        when sqlc.arg(transcription_ceiling_set)::boolean then sqlc.arg(transcription_ceiling)::text
        else transcription_ceiling
    end,
    transcription_default_mode = case
        when sqlc.arg(transcription_default_mode_set)::boolean then sqlc.arg(transcription_default_mode)::text
        else transcription_default_mode
    end,
    provider_policy_version = case
        when sqlc.arg(provider_policy_version_set)::boolean then sqlc.narg(provider_policy_version)::text
        else provider_policy_version
    end,
    recording_retention_seconds = case
        when sqlc.arg(recording_retention_seconds_set)::boolean then sqlc.narg(recording_retention_seconds)::bigint
        else recording_retention_seconds
    end,
    transcript_retention_seconds = case
        when sqlc.arg(transcript_retention_seconds_set)::boolean then sqlc.narg(transcript_retention_seconds)::bigint
        else transcript_retention_seconds
    end,
    source_window_seconds = case
        when sqlc.arg(source_window_seconds_set)::boolean then sqlc.narg(source_window_seconds)::bigint
        else source_window_seconds
    end,
    updated_at = now()
where tenant_id = (select id from updated_tenant)
returning *
)
select
    updated_tenant.id::uuid as id,
    updated_tenant.name,
    updated_tenant.default_region,
    updated_tenant.default_media_plane,
    updated_tenant.media_plane_provider_config,
    updated_tenant.ai_provider_config,
    updated_tenant.storage_provider_config,
    updated_tenant.logo_key,
    updated_tenant.website,
    updated_policy.transcription_ceiling,
    updated_policy.transcription_default_mode,
    updated_policy.provider_policy_version,
    updated_policy.recording_retention_seconds,
    updated_policy.transcript_retention_seconds,
    updated_policy.source_window_seconds,
    updated_tenant.updated_at,
    updated_tenant.created_at
from updated_tenant
join updated_policy on updated_policy.tenant_id = updated_tenant.id;
