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
with inserted as (
insert into spaces (
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    admission_policy,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id
) values (
    sqlc.arg(id),
    sqlc.arg(name),
    sqlc.arg(tenant_id),
    sqlc.arg(slug),
    sqlc.arg(media_plane),
    sqlc.narg(metadata),
    sqlc.narg(recurring_policy),
    sqlc.narg(admission_policy),
    sqlc.arg(default_episode_duration_seconds),
    sqlc.arg(maximum_episode_duration_seconds),
    sqlc.arg(linger_window_seconds),
    sqlc.narg(created_by_user_id)
)
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
)
select
    inserted.id,
    inserted.name,
    inserted.tenant_id,
    inserted.slug,
    inserted.media_plane,
    inserted.metadata,
    inserted.recurring_policy,
    inserted.admission_policy,
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

-- name: ListSpaceRoles :many
select
    id,
    tenant_id,
    space_id,
    name,
    capabilities,
    updated_at,
    created_at
from space_roles
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
order by created_at, id;

-- name: GetTenantSpace :one
select
    id,
    name,
    tenant_id,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    admission_policy,
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
    metadata,
    recurring_policy,
    admission_policy,
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
    metadata,
    recurring_policy,
    admission_policy,
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
    metadata,
    recurring_policy,
    admission_policy,
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
    metadata,
    recurring_policy,
    admission_policy,
    default_episode_duration_seconds,
    maximum_episode_duration_seconds,
    linger_window_seconds,
    created_by_user_id,
    updated_at,
    created_at,
    archived_at;

-- name: CreateEpisode :one
insert into episodes (
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot
) select
    sqlc.arg(id),
    sqlc.arg(status),
    sqlc.narg(metadata),
    spaces.id,
    spaces.tenant_id,
    sqlc.narg(created_by_user_id),
    sqlc.narg(started_at),
    sqlc.narg(ended_at),
    jsonb_build_object(
        'roles', coalesce((
            select jsonb_object_agg(role.name, to_jsonb(role.capabilities))
            from space_roles role
            where role.tenant_id = spaces.tenant_id and role.space_id = spaces.id
        ), '{}'::jsonb),
        'admission_policy', spaces.admission_policy,
        'default_episode_duration_seconds', spaces.default_episode_duration_seconds,
        'maximum_episode_duration_seconds', spaces.maximum_episode_duration_seconds,
        'linger_window_seconds', spaces.linger_window_seconds
    )
from spaces
where
    spaces.tenant_id = sqlc.arg(tenant_id)
    and spaces.id = sqlc.arg(space_id)
    and spaces.archived_at is null
for update
returning
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at;

-- name: CreateIdentity :one
insert into identities (
    id,
    tenant_id,
    kind,
    external_id,
    display_name,
    metadata
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(kind),
    sqlc.arg(external_id),
    sqlc.arg(display_name),
    sqlc.narg(metadata)
)
returning *;

-- name: GetTenantIdentityByExternalID :one
select *
from identities
where tenant_id = sqlc.arg(tenant_id)
  and external_id = sqlc.arg(external_id);

-- name: CreateSpaceRole :one
insert into space_roles (
    id,
    tenant_id,
    space_id,
    name,
    capabilities
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(name),
    sqlc.arg(capabilities)
)
returning *;

-- name: UpdateSpaceRole :one
update space_roles
set
    name = case when sqlc.arg(name_set)::boolean then sqlc.arg(name)::text else name end,
    capabilities = case when sqlc.arg(capabilities_set)::boolean then sqlc.arg(capabilities)::text[] else capabilities end,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and id = sqlc.arg(id)
returning *;

-- name: CreateSpaceMember :one
insert into space_members (
    id,
    tenant_id,
    space_id,
    identity_id,
    role_id
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(identity_id),
    sqlc.arg(role_id)
)
returning *;

-- name: GetSpaceMember :one
select *
from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and identity_id = sqlc.arg(identity_id);

-- name: ListSpaceMembers :many
select *
from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
order by created_at, id;

-- name: DeleteSpaceMember :exec
delete from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and identity_id = sqlc.arg(identity_id);

-- name: GetTenantEpisode :one
select
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(id);

-- name: ListTenantEpisodes :many
select
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantEpisode :one
update episodes
set
    status = case
        when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text
        else status
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    started_at = case
        when sqlc.arg(started_at_set)::boolean then sqlc.narg(started_at)::timestamptz
        else started_at
    end,
    ended_at = case
        when sqlc.arg(ended_at_set)::boolean then sqlc.narg(ended_at)::timestamptz
        else ended_at
    end,
    end_reason = case
        when sqlc.arg(end_reason_set)::boolean then sqlc.narg(end_reason)::text
        else end_reason
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(id)
returning
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at;
