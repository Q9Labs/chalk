-- name: GetTenantSpace :one
select
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    media_plane_setting,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at
from spaces
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: ListTenantSpaces :many
select
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    media_plane_setting,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at
from spaces
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        not sqlc.arg(archived_set)::boolean
        or (sqlc.arg(archived)::boolean and archived_at is not null)
        or (not sqlc.arg(archived)::boolean and archived_at is null)
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

-- name: UpdateTenantSpace :one
update spaces
set
    name = case
        when sqlc.arg(name_set)::boolean then sqlc.arg(name)::text
        else name
    end,
    slug = case
        when sqlc.arg(slug_set)::boolean then sqlc.arg(slug)::text
        else slug
    end,
    media_plane = case
        when sqlc.arg(media_plane_set)::boolean then sqlc.arg(media_plane)::text
        else media_plane
    end,
    media_plane_setting_written = case
        when sqlc.arg(media_plane_setting_set)::boolean then sqlc.narg(media_plane_setting)::text
        else media_plane_setting_written
    end,
    media_plane_setting_against = case
        when sqlc.arg(media_plane_setting_set)::boolean then
            case when sqlc.narg(media_plane_setting)::text is null then null
            else btrim(case when sqlc.arg(media_plane_set)::boolean then sqlc.arg(media_plane)::text else media_plane end) end
        else media_plane_setting_against
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    recurring_policy = case
        when sqlc.arg(recurring_policy_set)::boolean then sqlc.narg(recurring_policy)::jsonb
        else recurring_policy
    end,
    admission_policy = case
        when sqlc.arg(admission_policy_set)::boolean then sqlc.narg(admission_policy)::jsonb
        else admission_policy
    end,
    recording_policy = case
        when sqlc.arg(recording_policy_set)::boolean then sqlc.arg(recording_policy)::text
        else recording_policy
    end,
    transcript_language = case when sqlc.arg(transcript_language_set)::boolean then sqlc.narg(transcript_language)::text else transcript_language end,
    transcription_policy = case
        when sqlc.arg(transcription_policy_set)::boolean then sqlc.arg(transcription_policy)::text
        else transcription_policy
    end,
    default_episode_duration_seconds = case
        when sqlc.arg(default_episode_duration_seconds_set)::boolean then sqlc.arg(default_episode_duration_seconds)::integer
        else default_episode_duration_seconds
    end,
    maximum_episode_duration_seconds = case
        when sqlc.arg(maximum_episode_duration_seconds_set)::boolean then sqlc.arg(maximum_episode_duration_seconds)::integer
        else maximum_episode_duration_seconds
    end,
    linger_window_seconds = case
        when sqlc.arg(linger_window_seconds_set)::boolean then sqlc.arg(linger_window_seconds)::integer
        else linger_window_seconds
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    media_plane_setting,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at;

-- name: ArchiveTenantSpace :one
update spaces
set
    archived_at = coalesce(archived_at, now()),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id)
returning
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    media_plane_setting,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at;

-- name: RestoreTenantSpace :one
update spaces
set
    archived_at = null,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id)
returning
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    media_plane_setting,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at;

-- name: AdoptSpaceMediaPlaneSetting :execrows
-- Moves a Space stored on a plane onto the setting without changing where it runs. It writes only
-- while the Space still has no setting and still stores that plane, and the Tenant can still serve
-- the own SFU, so a choice made after the caller looked is never overwritten.
update spaces
set media_plane_setting_written = sqlc.arg(plane)::text,
    media_plane_setting_against = sqlc.arg(plane)::text
where spaces.tenant_id = sqlc.arg(tenant_id)
  and spaces.id = sqlc.arg(id)
  and spaces.media_plane_setting is null
  and btrim(spaces.media_plane) = sqlc.arg(plane)::text
  and exists (
    select 1 from tenants
    where tenants.id = spaces.tenant_id
      and (
        tenants.media_plane_provider_config is null
        or tenants.media_plane_provider_config = 'null'::jsonb
        or (
          (tenants.media_plane_provider_config->'enabled' is null
            or tenants.media_plane_provider_config->'enabled' in ('true'::jsonb, 'null'::jsonb))
          and btrim(coalesce(tenants.media_plane_provider_config->>'mode', '')) = 'chalk_managed'
        )
      )
  );
