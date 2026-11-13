-- name: ReserveSpaceCreateRequest :one
insert into space_create_requests (
    tenant_id,
    request_key,
    request_fingerprint,
    space_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(space_id)
)
on conflict (tenant_id, request_key) do nothing
returning *;

-- name: GetSpaceCreateRequest :one
select *
from space_create_requests
where tenant_id = sqlc.arg(tenant_id)
  and request_key = sqlc.arg(request_key);

-- name: CreateSpace :one
with tenant_facts as (
    select
        tenants.id,
        tenant_artifact_policies.transcription_default_mode
    from tenants
    join tenant_artifact_policies on tenant_artifact_policies.tenant_id = tenants.id
    where tenants.id = sqlc.arg(tenant_id)
    for update of tenants, tenant_artifact_policies
), inserted as (
insert into spaces (
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    media_plane_setting_written,
    media_plane_setting_against,
    metadata,
    recurring_policy,
    admission_policy,
    recording_policy,
    transcription_policy,
    transcript_language,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id
)
select
    sqlc.arg(id),
    sqlc.arg(name),
    tenant_facts.id,
    sqlc.arg(slug),
    sqlc.arg(media_plane),
    sqlc.narg(media_plane_setting)::text,
    case when sqlc.narg(media_plane_setting)::text is null then null else btrim(sqlc.arg(media_plane)) end,
    sqlc.narg(metadata),
    sqlc.narg(recurring_policy),
    sqlc.narg(admission_policy),
    coalesce(sqlc.narg(recording_policy)::text, 'automatic'),
    coalesce(sqlc.narg(transcription_policy)::text, tenant_facts.transcription_default_mode),
    sqlc.narg(transcript_language)::text,
    sqlc.arg(default_episode_duration_seconds),
    sqlc.arg(maximum_episode_duration_seconds),
    sqlc.arg(linger_window_seconds),
    sqlc.narg(created_by_user_id)
from tenant_facts
returning *
), seeded as (
    insert into space_roles (id, tenant_id, space_id, name, capabilities)
    select
        (md5(inserted.id::text || ':' || role_defaults.name))::uuid,
        inserted.tenant_id,
        inserted.id,
        role_defaults.name,
        role_defaults.capabilities
    from inserted
    cross join (
        values
        (
            'owner'::text,
            array[
                'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
                'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
                'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
                'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
                'requestMediaOthers', 'removeParticipant', 'manageRecording',
                'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
                'clearSpaceContent'
            ]::text[]
        ),
        (
            'collaborator'::text,
            array[
                'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
                'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
                'drawWhiteboard'
            ]::text[]
        ),
        ('observer'::text, array['subscribe', 'sendReaction']::text[])
    ) as role_defaults(name, capabilities)
    on conflict (tenant_id, space_id, name) do nothing
    returning id
), invite_seeded as (
    insert into space_public_invites (
        tenant_id, space_id, handle, generation, state_epoch, enabled,
        public_role, admission_mode, last_actor_id
    )
    select
        inserted.tenant_id,
        inserted.id,
        sqlc.arg(public_invite_handle),
        1,
        1,
        true,
        'collaborator',
        inserted.admission_policy ->> 'mode',
        inserted.created_by_user_id
    from inserted
    on conflict (tenant_id, space_id) do nothing
    returning tenant_id, space_id
)
select
    inserted.id,
    inserted.name,
    inserted.tenant_id,
    inserted.slug,
    inserted.media_plane,
    inserted.media_plane_setting_written,
    inserted.media_plane_setting_against,
    inserted.media_plane_setting,
    inserted.metadata,
    inserted.recurring_policy,
    inserted.admission_policy,
    inserted.recording_policy,
    inserted.transcription_policy,
    inserted.transcript_language,
    inserted.default_episode_duration_seconds,
    inserted.maximum_episode_duration_seconds,
    inserted.linger_window_seconds,
    inserted.created_by_user_id,
    inserted.updated_at,
    inserted.created_at,
    inserted.archived_at
from inserted;

-- name: SeedDefaultSpaceRoles :exec
insert into space_roles (id, tenant_id, space_id, name, capabilities)
values
(
    sqlc.arg(owner_role_id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    'owner',
    array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent'
    ]::text[]
),
(
    sqlc.arg(collaborator_role_id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    'collaborator',
    array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard'
    ]::text[]
),
(
    sqlc.arg(observer_role_id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    'observer',
    array['subscribe', 'sendReaction']::text[]
)
on conflict (tenant_id, space_id, name) do nothing;
