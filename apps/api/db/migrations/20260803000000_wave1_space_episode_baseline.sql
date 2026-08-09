-- +goose Up
-- This migration is the one-time bridge from the Room/Session schema.  It is
-- intentionally transactional: every guard runs before the first rename or
-- DDL, and a failed guard leaves the old schema untouched.
-- +goose StatementBegin
do $$
declare
    duplicate_room uuid;
begin
    if to_regclass('spaces') is not null
        or to_regclass('episodes') is not null
        or to_regclass('identities') is not null then
        raise exception 'Space/Episode bridge requires the target schema to be absent';
    end if;

    if not exists (select 1 from pg_class where relname = 'rooms' and relkind = 'r')
        or not exists (select 1 from pg_class where relname = 'room_sessions' and relkind = 'r') then
        raise exception 'Space/Episode bridge requires the legacy Room/Session schema';
    end if;

    select room_id
    into duplicate_room
    from (
        select room_id
        from room_sessions
        where status in ('active', 'ending')
        group by room_id
        having count(*) > 1
        limit 1
    ) live;
    if duplicate_room is not null then
        raise exception 'Space/Episode bridge found multiple live Sessions for Room %', duplicate_room;
    end if;

    if exists (select 1 from sync_session_control where host_participant_session_id is not null) then
        raise exception 'Space/Episode bridge cannot migrate legacy host authority';
    end if;

    if exists (
        select 1
        from sync_session_control control
        join room_sessions session on session.id = control.session_id
        where session.status <> 'ended'
    ) then
        raise exception 'Space/Episode bridge requires every durable Session to be ended before migration';
    end if;

    if exists (
        select 1
        from sync_session_control
        where retention_cleaned_at is not null
    ) then
        raise exception 'Space/Episode bridge cannot rewrite a retained legacy Sync checkpoint';
    end if;

    if exists (
        select 1
        from sync_session_control control
        where control.control_revision > 0
          and not exists (
              select 1
              from sync_control_events event
              where event.tenant_id = control.tenant_id
                and event.session_id = control.session_id
                and event.revision = control.control_revision
          )
    ) then
        raise exception 'Space/Episode bridge found a durable Sync head without its terminal Event';
    end if;

    -- The legacy durable reducer is v3.  The target Episode reducer is v1;
    -- __chalk_bridge_snapshot below performs that explicit shape/version
    -- rewrite and __chalk_bridge_state_digest recomputes the v1 digest.  Do
    -- not accept any other source version, even when its JSON happens to look
    -- like a terminal snapshot.
    if exists (
        select 1
        from sync_session_control
        where state_schema_version <> 3
           or coalesce((folded_state ->> 'state_schema_version')::integer, 0) <> 3
           or coalesce(folded_state ->> 'admission_policy', '') not in ('open', 'approval', 'closed')
           or coalesce(folded_state ->> 'status', '') <> 'ended'
           or coalesce((folded_state ->> 'control_revision')::bigint, -1) <> control_revision
           or jsonb_typeof(folded_state -> 'participants') <> 'array'
           or jsonb_array_length(folded_state -> 'participants') <> 0
           or jsonb_typeof(folded_state -> 'admission_requests') <> 'array'
           or jsonb_array_length(folded_state -> 'admission_requests') <> 0
           or coalesce((folded_state ->> 'deadline_at_ms')::bigint, 0) < 1
           or coalesce((folded_state ->> 'deadline_generation')::bigint, 0) < 1
    ) then
        raise exception 'Space/Episode bridge found an unsupported terminal Sync snapshot';
    end if;

    if exists (
        select 1
        from sync_chat_streams
        group by tenant_id, room_id
        having count(*) > 1
    ) or exists (
        select 1
        from sync_whiteboard_scenes
        group by tenant_id, room_id, scene_id
        having count(*) > 1
    ) or exists (
        select 1
        from sync_whiteboard_scenes
        where is_current
        group by tenant_id, room_id
        having count(*) > 1
    ) then
        raise exception 'Space/Episode bridge found a Chat/Whiteboard collision';
    end if;

    if exists (select 1 from participants where user_id is not null) then
        raise exception 'Space/Episode bridge requires operator identity mapping for legacy Participant.user_id';
    end if;

    if exists (
        select 1
        from room_sessions
        where status not in ('active', 'ending', 'ended')
    ) or exists (
        select 1
        from participants
        where status not in ('joining', 'active', 'leaving', 'left')
    ) then
        raise exception 'Space/Episode bridge found an unsupported lifecycle enum';
    end if;

    if exists (
        select 1 from rooms where status not in ('active', 'archived', 'ended')
    ) then
        raise exception 'Space/Episode bridge found an unsupported Room status';
    end if;

    if exists (
        select 1 from participants
        where role not in ('host', 'cohost', 'participant')
    ) then
        raise exception 'Space/Episode bridge found an unsupported Participant role';
    end if;

    if exists (
        select 1
        from participants p
        cross join lateral unnest(p.eligible_roles) eligible(role_name)
        where eligible.role_name not in ('host', 'cohost', 'participant')
    ) then
        raise exception 'Space/Episode bridge found an unsupported eligible role';
    end if;

    if exists (
        select 1
        from sync_control_events
        where num_nonnulls(command_id, lifecycle_intent_id, external_operation_id) <> 1
    ) then
        raise exception 'Space/Episode bridge found an unsupported control-event origin';
    end if;

    if exists (
        select 1
        from sync_external_operations
        where operation_name not in (
            'admit_participant', 'deny_admission', 'admission_request_expired',
            'mute_participant', 'stop_participant_camera',
            'stop_participant_screen_share', 'remove_participant',
            'start_recording', 'stop_recording', 'participant_leave',
            'end_session', 'tenant_transfer_host', 'tenant_set_deadline',
            'tenant_end_session', 'maximum_duration_expired',
            'role_transition_cleanup', 'role_transition_source_stop'
        )
    ) then
        raise exception 'Space/Episode bridge found an unsupported external-operation enum';
    end if;

    if exists (
        select 1
        from provider_operation_receipts
        where effect not in (
            'media.grant_publication', 'media.revoke_publication',
            'media.remove_participant', 'media.end_session',
            'recording.start', 'recording.stop'
        )
    ) then
        raise exception 'Space/Episode bridge found an unsupported provider-operation enum';
    end if;

    if exists (
        select 1
        from sync_command_receipts
        where command_name not in (
            'raise_hand', 'lower_hand', 'set_hand_raised', 'set_display_name',
            'set_admission_policy', 'set_participant_role', 'transfer_host',
            'admit_participant', 'deny_admission', 'mute_participant',
            'stop_participant_camera', 'stop_participant_screen_share',
            'remove_participant', 'start_recording', 'stop_recording',
            'participant_leave', 'end_session'
        )
    ) then
        raise exception 'Space/Episode bridge found an unsupported command enum';
    end if;

    if exists (
        select 1
        from sync_command_receipts
        where rejection_reason is not null
          and rejection_reason not in (
              'session_ended', 'participant_inactive',
              'stale_participant_generation', 'capability_denied',
              'invalid_state', 'invalid_target', 'role_not_eligible',
              'host_transfer_required', 'screen_share_in_use',
              'recording_in_progress', 'external_operation_failed',
              'command_id_conflict'
          )
    ) then
        raise exception 'Space/Episode bridge found an unsupported command rejection reason';
    end if;

    if exists (
        select 1
        from (
            select unnest(p.capabilities) as capability
            from participants p
            union all
            select jsonb_array_elements_text(value) as capability
            from room_sessions rs
            cross join lateral jsonb_each(rs.role_capabilities)
        ) capabilities
        where capability not in (
            'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
            'raiseHand', 'renameSelf', 'manageAdmission', 'promoteDemote',
            'transferHost', 'muteOthers', 'stopVideoOthers',
            'stopScreenOthers', 'requestMediaOthers', 'removeParticipant',
            'manageRecording', 'endMeeting', 'sendChat', 'sendReaction',
            'drawWhiteboard', 'manageWhiteboard', 'assignRoles', 'endEpisode'
        )
    ) then
        raise exception 'Space/Episode bridge found an unsupported capability value';
    end if;

    if exists (
        select 1
        from room_sessions
        where jsonb_typeof(role_capabilities) <> 'object'
           or not role_capabilities ?& array['host', 'cohost', 'participant']
           or role_capabilities - array['host', 'cohost', 'participant'] <> '{}'::jsonb
           or jsonb_typeof(role_capabilities -> 'host') <> 'array'
           or jsonb_typeof(role_capabilities -> 'cohost') <> 'array'
           or jsonb_typeof(role_capabilities -> 'participant') <> 'array'
           or jsonb_array_length(role_capabilities -> 'host') < 1
           or jsonb_array_length(role_capabilities -> 'cohost') < 1
           or jsonb_array_length(role_capabilities -> 'participant') < 1
    ) then
        raise exception 'Space/Episode bridge found an unsupported or empty Session role policy';
    end if;

    if exists (
        select 1
        from room_sessions
        where maximum_duration_seconds not between 60 and 604800
           or maximum_duration_ceiling_seconds not between 60 and 604800
    ) then
        raise exception 'Space/Episode bridge found an unsupported Episode duration';
    end if;

    if exists (
        select 1
        from transcriptions
        where status not in ('pending', 'processing', 'completed', 'failed',
                             'not_requested', 'preparing', 'transcribing',
                             'verifying', 'complete', 'retryable_failure',
                             'terminal_failure', 'deleted')
    ) then
        raise exception 'Space/Episode bridge found an unsupported transcription status';
    end if;
end;
$$;
-- +goose StatementEnd

-- Preserve all legacy objects while the target definitions below are created.
-- Indexes are schema-scoped, so rename every legacy index before target DDL.
-- +goose StatementBegin
do $$
declare
    table_name text;
    index_name text;
    legacy_table_names constant text[] := array[
        'tenants', 'users', 'memberships', 'auth_identities', 'login_sessions',
        'api_keys', 'tenant_signing_keys', 'rooms', 'room_sessions',
        'participants', 'sync_session_control', 'sync_lifecycle_intents',
        'sync_control_events', 'sync_command_receipts', 'session_create_requests',
        'sync_external_operations', 'sync_admission_requests',
        'sync_screen_share_leases', 'sync_publication_fences',
        'sync_publication_grant_reservations', 'sync_recordings',
        'recordings', 'transcriptions', 'audit_logs', 'integration_connections',
        'observability_journey_events', 'webhook_tenant_state', 'webhook_endpoints',
        'webhook_endpoint_revisions', 'webhook_events', 'webhook_deliveries',
        'webhook_delivery_attempts', 'webhook_idempotency_records',
        'recording_transcription_sources', 'recording_transcription_source_chunks',
        'artifact_jobs', 'transcript_chunks', 'transcription_attempts',
        'transcription_chunk_results', 'transcription_cleanup_jobs',
        'recording_capacity', 'recording_pool_health', 'recording_reservations',
        'recording_pipelines', 'recording_jobs', 'recording_bundles',
        'recording_artifacts', 'provider_operation_receipts',
        'provider_operation_observation_heads', 'provider_operation_observations',
        'sync_whiteboard_scenes', 'sync_whiteboard_elements',
        'sync_whiteboard_permissions', 'sync_whiteboard_operation_receipts',
        'sync_whiteboard_files', 'sync_chat_streams', 'sync_chat_messages',
        'sync_chat_attachments', 'sync_chat_read_receipts'
    ];
begin
    foreach table_name in array legacy_table_names loop
        if to_regclass(table_name) is not null then
            execute format('alter table %I rename to %I', table_name, '__chalk_legacy_' || table_name);
        end if;
    end loop;

    if to_regprocedure('reject_recording_object_mutation()') is not null then
        execute 'alter function reject_recording_object_mutation() rename to __chalk_legacy_reject_recording_object_mutation';
    end if;

    for index_name in
        select c.relname
        from pg_class c
        join pg_index i on i.indexrelid = c.oid
        join pg_class t on t.oid = i.indrelid
        where c.relkind = 'i'
          and t.relname ~ '^__chalk_legacy_'
    loop
        execute format('alter index %I rename to %I', index_name, 'legacy_i_' || md5(index_name));
    end loop;
end;
$$;
-- +goose StatementEnd

create table tenants (
    id uuid primary key,
    name text not null,
    default_region text,
    -- cf_sfu, cf_rtk, mediasoup
    default_media_plane text,
    -- {
    --   "enabled": true,
    --   "provider": "cf_sfu" | "cf_rtk",
    --   "mode": "chalk_managed" | "tenant_managed",
    --   "cloudflare": {
    --     "account_id": "cloudflare-account-id",
    --     "api_token": string,
    --     "rtk": {
    --       "enabled": true,
    --       "app_id": "realtimekit-app-id",
    --       "host_preset": "facilitator",
    --       "participant_preset": "contributor"
    --     },
    --     "sfu": {
    --       "enabled": true,
    --       "app_id": "realtime-app-id",
    --       "app_secret": string
    --     }
    --   }
    -- }
    media_plane_provider_config jsonb,
    -- {
    --   "enabled": true,
    --   "provider": "openrouter",
    --   "mode": "chalk_managed" | "tenant_managed",
    --   "api_key": string,
    --   "base_url": "https://openrouter.ai/api/v1",
    --   "default_model": "openai/gpt-5.4-mini",
    --   "fallback_model": "anthropic/claude-fable-5",
    --   "allowed_models": [
    --     "openai/gpt-5.4-mini",
    --     "anthropic/claude-fable-5"
    --   ]
    -- }
    ai_provider_config jsonb,
    -- {
    --   "enabled": true,
    --   "provider": "cloudflare_r2" | "aws_s3",
    --   "mode": "chalk_managed" | "tenant_managed",
    --   "bucket": "chalk-recordings",
    --   "prefix": "recordings/",
    --   "access_key_id": string,
    --   "secret_access_key": string
    -- }
    storage_provider_config jsonb,
    logo_key text,
    website text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index tenants_created_at_id_idx on tenants(created_at desc, id desc);

create table users (
    id uuid primary key,
    name text not null,
    email text not null unique,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index users_created_at_id_idx on users(created_at desc, id desc);

create table memberships (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    user_id uuid not null references users(id),
    -- owner, admin, member, viewer
    role text not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(tenant_id, user_id)
);
create index memberships_tenant_created_at_id_idx on memberships(tenant_id, created_at desc, id desc);
create index memberships_user_id_idx on memberships(user_id);

create table auth_identities (
    id uuid primary key,
    user_id uuid not null references users(id),
    -- google, apple, password
    provider text not null,
    provider_subject text not null,
    password_hash text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(provider, provider_subject)
);

create table login_sessions (
    id uuid primary key,
    user_id uuid not null references users(id),
    token_hash text not null,
    user_agent text,
    device_name text,
    ip_address inet,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(token_hash)
);

create table api_keys (
    id uuid primary key,
    name text not null,
    scopes text[] not null,
    tenant_id uuid not null references tenants(id),
    key_hash text not null,
    key_prefix text not null,
    created_by_user_id uuid references users(id),
    last_used_ip inet,
    last_used_at timestamptz,
    revoked_at timestamptz,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (key_prefix)
);

-- Participant tokens: JWT/JWS
-- Algorithm: EdDSA / Ed25519
-- Key model: tenant signs with private key, Chalk stores public
-- key
-- Token TTL: short, like 5-15 minutes or longer like 60 minutes
create table tenant_signing_keys (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    key_id text not null,
    algorithm text not null,
    public_key_jwk jsonb not null,
    last_used_at timestamptz,
    created_by_api_key_id uuid references api_keys(id),
    created_by_user_id uuid references users(id),
    revoked_at timestamptz,
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (key_id)
);

create table spaces (
    id uuid primary key,
    name text not null,
    tenant_id uuid not null references tenants(id),
    slug text not null,
    -- cf_sfu, cf_rtk, mediasoup
    media_plane text not null,
    metadata jsonb,
    -- recurring_policy is null for non-recurring spaces.
    -- Example:
    -- {
    --   "timezone": "Asia/Dubai",
    --   "dtstart": "2026-07-01T09:00:00",
    --   "rrule": "FREQ=WEEKLY;BYDAY=MO,WE"
    -- }
    recurring_policy jsonb,
    admission_policy jsonb not null default '{"mode":"open"}'::jsonb
        check (jsonb_typeof(admission_policy) = 'object' and admission_policy ->> 'mode' in ('open', 'knock', 'members_only')),
    default_episode_duration_seconds integer not null default 86400,
    maximum_episode_duration_seconds integer not null default 86400,
    linger_window_seconds integer not null default 0,
    created_by_user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, slug),
    unique (tenant_id, id),
    check (default_episode_duration_seconds between 60 and 604800),
    check (maximum_episode_duration_seconds between 60 and 604800),
    check (default_episode_duration_seconds <= maximum_episode_duration_seconds),
    check (linger_window_seconds >= 0)
);
create index spaces_tenant_created_at_id_idx on spaces(tenant_id, created_at desc, id desc);

-- +goose StatementBegin
create function valid_capabilities(value text[])
returns boolean
language sql
immutable
strict
as $$
    select value <@ array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
        'assignRoles', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording',
        'startEpisode', 'extendEpisode', 'endEpisode', 'manageMembers',
        'clearSpaceContent'
    ]::text[]
        and cardinality(value) <= 23
        and cardinality(value) = (select count(distinct capability) from unnest(value) as capability)
$$;
-- +goose StatementEnd

create table identities (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    kind text not null check (kind in ('user', 'agent')),
    external_id text not null,
    display_name text not null,
    metadata jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, external_id),
    unique (tenant_id, id)
);
create index identities_tenant_created_at_id_idx on identities(tenant_id, created_at desc, id desc);

create table space_roles (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    name text not null,
    capabilities text[] not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, name),
    unique (tenant_id, space_id, id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    check (name <> '' and cardinality(capabilities) > 0 and valid_capabilities(capabilities))
);
create index space_roles_space_created_at_id_idx on space_roles(space_id, created_at desc, id desc);

create table space_members (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    identity_id uuid not null,
    role_id uuid not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (space_id, identity_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, role_id)
        references space_roles(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, identity_id)
        references identities(tenant_id, id)
        on delete restrict
);
create index space_members_space_created_at_id_idx on space_members(space_id, created_at desc, id desc);

-- +goose StatementBegin
create function validate_episode_config_snapshot(value jsonb)
returns boolean
language sql
immutable
strict
as $$
    select jsonb_typeof(value) = 'object'
        and jsonb_typeof(value -> 'roles') = 'object'
        and not exists (
            select 1
            from jsonb_each(value -> 'roles') role_entry
            where jsonb_typeof(role_entry.value) <> 'array'
                or not valid_capabilities(array(select jsonb_array_elements_text(role_entry.value)))
        )
        and jsonb_typeof(value -> 'admission_policy') = 'object'
        and value -> 'admission_policy' ->> 'mode' in ('open', 'knock', 'members_only')
        and (value ->> 'default_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'maximum_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'default_episode_duration_seconds')::integer <=
            (value ->> 'maximum_episode_duration_seconds')::integer
        and (value ->> 'linger_window_seconds')::integer >= 0
$$;
-- +goose StatementEnd

create table episodes (
    id uuid primary key,
    status text not null check (status in ('active', 'ending', 'ended')),
    metadata jsonb,
    space_id uuid not null,
    tenant_id uuid not null references tenants(id),
    created_by_user_id uuid references users(id),
    started_at timestamptz,
    ended_at timestamptz,
    config_snapshot jsonb not null check (validate_episode_config_snapshot(config_snapshot)),
    end_reason text check (end_reason in ('explicit', 'natural', 'deadline')),
    deadline_at timestamptz not null default (now() + interval '24 hours'),
    deadline_generation bigint not null default 1,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete restrict,
    check (
        deadline_generation > 0
    )
);
create index episodes_tenant_space_created_at_id_idx on episodes(tenant_id, space_id, created_at desc, id desc);
create index episodes_sync_ended_cleanup_idx
    on episodes(ended_at, tenant_id, id)
    where status = 'ended';
create unique index episodes_one_live_per_space_idx
    on episodes(tenant_id, space_id)
    where status in ('active', 'ending');

-- +goose StatementBegin
create function protect_immutable_episode_policy()
returns trigger
language plpgsql
as $$
begin
    if new.config_snapshot is distinct from old.config_snapshot then
        raise exception 'Episode config_snapshot is immutable';
    end if;

    if new.deadline_at is distinct from old.deadline_at
        then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'Episode deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
            raise exception 'Episode deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

create trigger episodes_immutable_config_snapshot
before update on episodes
for each row execute function protect_immutable_episode_policy();

create table episode_create_requests (
    tenant_id uuid not null,
    space_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    episode_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict
        deferrable initially deferred,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32)
);

create table participants (
    id uuid primary key,
    name text,
    metadata jsonb,
    capabilities text[] not null,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null,
    episode_id uuid not null,
    identity_id uuid,
    generation bigint not null check (generation > 0),
    status text not null check (status in ('joining', 'active', 'leaving', 'left')),
    role text not null,
    joined_at timestamptz,
    left_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, space_id, episode_id, id),
    unique (tenant_id, space_id, episode_id, id, generation),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, identity_id)
        references identities(tenant_id, id)
        on delete restrict,
    check (cardinality(capabilities) > 0 and valid_capabilities(capabilities))
);
create index participants_sync_active_episode_capacity_idx
    on participants(tenant_id, space_id, episode_id)
    where status in ('joining', 'active', 'leaving');

create table sync_chat_streams (
    tenant_id uuid not null,
    space_id uuid not null,
    head_sequence bigint not null default 0,
    retained_floor_sequence bigint,
    message_count bigint not null default 0,
    message_bytes bigint not null default 0,
    attachment_count bigint not null default 0,
    attachment_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete restrict,
    check (
        head_sequence >= 0
        and message_count between 0 and 250000
        and message_bytes between 0 and 2147483648
        and attachment_count between 0 and 1000
        and attachment_bytes between 0 and 5368709120
        and (
            (
                head_sequence = 0
                and retained_floor_sequence is null
                and message_count = 0
                and message_bytes = 0
            )
            or (
                head_sequence > 0
                and retained_floor_sequence between 1 and head_sequence + 1
                and message_count = head_sequence - retained_floor_sequence + 1
            )
        )
    )
);

create table sync_chat_messages (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    sequence bigint not null,
    message_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    client_message_id text not null,
    request_fingerprint bytea not null,
    display_name text not null,
    message_text text not null,
    encoded_bytes bigint not null,
    created_at timestamptz not null,
    primary key (tenant_id, space_id, sequence),
    unique (tenant_id, space_id, message_id),
    unique (
        tenant_id,
        space_id,
        participant_id,
        participant_generation,
        client_message_id
    ),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (sequence > 0),
    check (octet_length(client_message_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(display_name) between 1 and 256),
    check (
        octet_length(message_text) between 0 and 16384
        and char_length(message_text) <= 4000
    ),
    check (encoded_bytes between 1 and 32768)
);
create index sync_chat_messages_space_created_at_idx
    on sync_chat_messages(tenant_id, space_id, created_at, sequence);

create table sync_chat_attachments (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    attachment_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    client_attachment_id text not null,
    request_fingerprint bytea not null,
    upload_id uuid not null,
    object_key text not null,
    original_filename text not null,
    mime_type text not null,
    byte_length bigint not null,
    sha256 bytea not null,
    immutable_object_identity text,
    status text not null,
    expires_at timestamptz not null,
    message_sequence bigint,
    message_ordinal smallint,
    finalize_claim_token uuid,
    finalize_claimed_until timestamptz,
    finalize_attempts integer not null default 0,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    finalized_at timestamptz,
    attached_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, attachment_id),
    unique (upload_id),
    unique (object_key),
    unique (
        tenant_id,
        space_id,
        participant_id,
        participant_generation,
        client_attachment_id
    ),
    unique (tenant_id, space_id, message_sequence, message_ordinal),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(
            tenant_id,
            space_id,
            episode_id,
            id,
            generation
        )
        on delete restrict,
    foreign key (tenant_id, space_id, message_sequence)
        references sync_chat_messages(tenant_id, space_id, sequence)
        on delete restrict,
    check (octet_length(client_attachment_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(object_key) between 1 and 1024),
    check (octet_length(original_filename) between 1 and 255),
    check (
        mime_type in (
            'image/png',
            'image/jpeg',
            'image/gif',
            'image/webp',
            'application/pdf',
            'text/plain',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.oasis.opendocument.text',
            'application/vnd.oasis.opendocument.spreadsheet',
            'application/vnd.oasis.opendocument.presentation'
        )
    ),
    check (byte_length between 1 and 26214400),
    check (octet_length(sha256) = 32),
    check (
        immutable_object_identity is null
        or octet_length(immutable_object_identity) between 1 and 512
    ),
    check (status in ('pending', 'finalizing', 'ready', 'attached', 'failed')),
    check (
        (
            status = 'attached'
            and message_sequence is not null
            and message_ordinal between 0 and 4
            and attached_at is not null
        )
        or (
            status <> 'attached'
            and message_sequence is null
            and message_ordinal is null
            and attached_at is null
        )
    ),
    check (
        (
            status in ('ready', 'attached')
            and immutable_object_identity is not null
            and finalized_at is not null
        )
        or status in ('pending', 'finalizing', 'failed')
    ),
    check (
        finalize_attempts >= 0
        and (
            (
                status = 'finalizing'
                and finalize_claim_token is not null
                and finalize_claimed_until is not null
            )
            or (
                status <> 'finalizing'
                and finalize_claim_token is null
                and finalize_claimed_until is null
            )
        )
    ),
    check (
        cleanup_attempts >= 0
        and (
            (cleanup_claim_token is null and cleanup_claimed_until is null)
            or (cleanup_claim_token is not null and cleanup_claimed_until is not null)
        )
    )
);
create index sync_chat_attachments_cleanup_idx
    on sync_chat_attachments(status, expires_at)
    where status <> 'attached';
create index sync_chat_attachments_space_status_idx
    on sync_chat_attachments(tenant_id, space_id, status);
create index sync_chat_attachments_finalize_lease_idx
    on sync_chat_attachments(finalize_claimed_until)
    where status = 'finalizing';

create table sync_chat_read_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    sequence bigint not null,
    read_at timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (
        tenant_id,
        space_id,
        participant_id,
        participant_generation
    ),
    foreign key (tenant_id, space_id)
        references sync_chat_streams(tenant_id, space_id)
        on delete restrict,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(
            tenant_id,
            space_id,
            episode_id,
            id,
            generation
        )
        on delete restrict,
    check (sequence > 0)
);

create table sync_whiteboard_scenes (
    tenant_id uuid not null,
    space_id uuid not null,
    scene_id uuid not null,
    is_current boolean not null default true,
    revision bigint not null default 0,
    app_state jsonb,
    element_count integer not null default 0,
    encoded_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, scene_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    check (revision >= 0),
    check (element_count between 0 and 10000),
    check (encoded_bytes between 0 and 67108864),
    check (
        app_state is null
        or (
            jsonb_typeof(app_state) = 'object'
            and app_state ? 'view_background_color'
            and app_state - 'view_background_color' = '{}'::jsonb
            and jsonb_typeof(app_state -> 'view_background_color') = 'string'
        )
    )
);
create unique index sync_whiteboard_scenes_current_idx
    on sync_whiteboard_scenes(tenant_id, space_id)
    where is_current;

create table sync_whiteboard_elements (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    scene_id uuid not null,
    element_id text not null,
    element_type text not null,
    version bigint not null,
    version_nonce bigint not null,
    element_index text not null,
    is_deleted boolean not null,
    payload jsonb not null,
    encoded_bytes integer not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, scene_id, element_id),
    foreign key (tenant_id, space_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, space_id, scene_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    check (octet_length(element_id) between 1 and 128),
    check (octet_length(element_type) between 1 and 64),
    check (octet_length(element_index) between 1 and 64),
    check (version >= 0 and version_nonce >= 0),
    check (jsonb_typeof(payload) = 'object'),
    check (encoded_bytes between 2 and 16384)
);
create index sync_whiteboard_elements_snapshot_idx
    on sync_whiteboard_elements(tenant_id, space_id, scene_id, element_index, element_id);

create table sync_whiteboard_permissions (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    can_draw boolean not null,
    granted_by_participant_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, granted_by_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create table sync_whiteboard_operation_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    submitted_generation bigint not null,
    operation_id text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    outcome text not null,
    scene_id uuid not null,
    revision bigint not null,
    event_elements jsonb,
    event_encoded_bytes integer not null default 0,
    completed_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id, operation_id),
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        submitted_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (octet_length(operation_id) between 16 and 64),
    check (octet_length(request_fingerprint) = 32),
    check (operation_name in ('submit_update', 'clear', 'set_draw_permission')),
    check (outcome = 'committed'),
    check (revision >= 0),
    check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_encoded_bytes between 2 and 262144
        )
        or (
            operation_name <> 'submit_update'
            and event_elements is null
            and event_encoded_bytes = 0
        )
    )
);
create index sync_whiteboard_operation_receipts_retention_idx
    on sync_whiteboard_operation_receipts(tenant_id, space_id, completed_at);

create table sync_whiteboard_files (
    upload_id uuid primary key,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    scene_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    file_id text not null,
    object_key text not null unique,
    mime_type text not null,
    byte_length bigint not null,
    sha256 bytea not null,
    status text not null default 'pending',
    immutable_object_identity text,
    expires_at timestamptz not null,
    finalized_at timestamptz,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, space_id, scene_id, file_id),
    foreign key (tenant_id, space_id, scene_id)
        references sync_whiteboard_scenes(tenant_id, space_id, scene_id)
        on delete cascade,
    foreign key (
        tenant_id,
        space_id,
        episode_id,
        participant_id,
        participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (octet_length(file_id) between 1 and 128),
    check (octet_length(object_key) between 1 and 1024),
    check (octet_length(mime_type) between 1 and 255),
    check (byte_length between 1 and 268435456),
    check (octet_length(sha256) = 32),
    check (status in ('pending', 'finalizing', 'ready', 'failed')),
    check (cleanup_attempts >= 0),
    check ((cleanup_claim_token is null) = (cleanup_claimed_until is null)),
    check (
        (status = 'pending' and immutable_object_identity is null and finalized_at is null)
        or (status = 'finalizing' and immutable_object_identity is null and finalized_at is null)
        or (status = 'ready' and immutable_object_identity is not null and finalized_at is not null)
        or status = 'failed'
    )
);
create index sync_whiteboard_files_pending_cleanup_idx
    on sync_whiteboard_files(expires_at, cleanup_claimed_until, tenant_id, space_id)
    where status in ('pending', 'finalizing', 'failed');
create index sync_whiteboard_files_space_cleanup_idx
    on sync_whiteboard_files(tenant_id, space_id, cleanup_claimed_until);

create table sync_episode_control (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    control_revision bigint not null default 0,
    folded_state jsonb not null,
    state_schema_version integer not null check (state_schema_version > 0),
    state_digest bytea not null check (octet_length(state_digest) = 32),
    snapshot_bytes bigint not null,
    snapshot_reserved_bytes bigint not null default 0,
    participant_event_count bigint not null default 0,
    participant_event_bytes bigint not null default 0,
    lifecycle_event_count bigint not null default 0,
    lifecycle_event_bytes bigint not null default 0,
    lifecycle_reserved_events bigint not null default 1,
    lifecycle_reserved_bytes bigint not null default 16384,
    lifecycle_intent_count bigint not null default 0,
    lifecycle_intent_bytes bigint not null default 0,
    lifecycle_reserved_intents bigint not null default 1,
    lifecycle_reserved_intent_bytes bigint not null default 16384,
    receipt_count bigint not null default 0,
    receipt_bytes bigint not null default 0,
    retention_checkpoint_revision bigint,
    retention_checkpoint_state_digest bytea,
    retention_checkpoint_event_count bigint,
    retention_cleaned_at timestamptz,
    retention_deleted_event_rows bigint not null default 0,
    retention_deleted_event_bytes bigint not null default 0,
    retention_deleted_receipt_rows bigint not null default 0,
    retention_deleted_receipt_bytes bigint not null default 0,
    retention_deleted_lifecycle_intent_rows bigint not null default 0,
    retention_deleted_lifecycle_intent_bytes bigint not null default 0,
    retention_deleted_external_operation_rows bigint not null default 0,
    retention_deleted_external_operation_bytes bigint not null default 0,
    retention_deleted_admission_request_rows bigint not null default 0,
    retention_deleted_admission_request_bytes bigint not null default 0,
    retention_deleted_recording_rows bigint not null default 0,
    retention_deleted_recording_bytes bigint not null default 0,
    retention_deleted_screen_share_lease_rows bigint not null default 0,
    retention_deleted_screen_share_lease_bytes bigint not null default 0,
    retention_deleted_publication_fence_rows bigint not null default 0,
    retention_deleted_publication_fence_bytes bigint not null default 0,
    retention_deleted_publication_grant_reservation_rows bigint not null default 0,
    retention_deleted_publication_grant_reservation_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, episode_id),
    unique (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    check (
        control_revision >= 0
        and snapshot_bytes >= 0
        and snapshot_reserved_bytes >= 0
        and participant_event_count between 0 and 250000
        and participant_event_bytes between 0 and 2147483648
        and lifecycle_event_count >= 0
        and lifecycle_event_bytes >= 0
        and lifecycle_reserved_events >= 0
        and lifecycle_reserved_bytes >= 0
        and lifecycle_intent_count >= 0
        and lifecycle_intent_bytes >= 0
        and lifecycle_reserved_intents >= 0
        and lifecycle_reserved_intent_bytes >= 0
        and receipt_count between 0 and 500000
        and receipt_bytes between 0 and 4294967296
        and snapshot_bytes + snapshot_reserved_bytes <= 1048576
        and lifecycle_event_count + lifecycle_reserved_events <= 2048
        and lifecycle_event_bytes + lifecycle_reserved_bytes <= 33554432
        and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
        and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes <= 33554432
    ),
    check (
        (
            retention_cleaned_at is null
            and retention_checkpoint_revision is null
            and retention_checkpoint_state_digest is null
            and retention_checkpoint_event_count is null
            and retention_deleted_event_rows = 0
            and retention_deleted_event_bytes = 0
            and retention_deleted_receipt_rows = 0
            and retention_deleted_receipt_bytes = 0
            and retention_deleted_lifecycle_intent_rows = 0
            and retention_deleted_lifecycle_intent_bytes = 0
            and retention_deleted_external_operation_rows = 0
            and retention_deleted_external_operation_bytes = 0
            and retention_deleted_admission_request_rows = 0
            and retention_deleted_admission_request_bytes = 0
            and retention_deleted_recording_rows = 0
            and retention_deleted_recording_bytes = 0
            and retention_deleted_screen_share_lease_rows = 0
            and retention_deleted_screen_share_lease_bytes = 0
            and retention_deleted_publication_fence_rows = 0
            and retention_deleted_publication_fence_bytes = 0
            and retention_deleted_publication_grant_reservation_rows = 0
            and retention_deleted_publication_grant_reservation_bytes = 0
        )
        or (
            retention_cleaned_at is not null
            and retention_checkpoint_revision is not null
            and retention_checkpoint_revision >= 0
            and retention_checkpoint_state_digest is not null
            and octet_length(retention_checkpoint_state_digest) = 32
            and retention_checkpoint_event_count is not null
            and retention_checkpoint_event_count = retention_checkpoint_revision
            and retention_deleted_event_rows = retention_checkpoint_event_count
            and retention_deleted_event_bytes >= 0
            and retention_deleted_receipt_rows >= 0
            and retention_deleted_receipt_bytes >= 0
            and retention_deleted_lifecycle_intent_rows >= 0
            and retention_deleted_lifecycle_intent_bytes >= 0
            and retention_deleted_external_operation_rows >= 0
            and retention_deleted_external_operation_bytes >= 0
            and retention_deleted_admission_request_rows >= 0
            and retention_deleted_admission_request_bytes >= 0
            and retention_deleted_recording_rows >= 0
            and retention_deleted_recording_bytes >= 0
            and retention_deleted_screen_share_lease_rows >= 0
            and retention_deleted_screen_share_lease_bytes >= 0
            and retention_deleted_publication_fence_rows >= 0
            and retention_deleted_publication_fence_bytes >= 0
            and retention_deleted_publication_grant_reservation_rows >= 0
            and retention_deleted_publication_grant_reservation_bytes >= 0
        )
    )
);

create table sync_lifecycle_intents (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    lifecycle_intent_id uuid primary key,
    request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    intent_name text not null,
    participant_id uuid,
    participant_generation bigint,
    payload jsonb not null check (octet_length(payload::text) <= 16384),
    status text not null,
    terminal_reason text,
    applied_event_id uuid,
    applied_revision bigint,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    last_error_code text,
    next_attempt_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, lifecycle_intent_id),
    unique (tenant_id, episode_id, intent_name, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (
        (
            intent_name in ('participant_joined', 'participant_left')
            and participant_id is not null
            and participant_generation > 0
        )
        or (
            intent_name in ('episode_ended', 'admission_requested')
            and participant_id is null
            and participant_generation is null
        )
    ),
    check (
        (
            status = 'pending'
            and terminal_reason is null
            and applied_event_id is null
            and applied_revision is null
            and completed_at is null
        )
        or (
            status = 'applied'
            and terminal_reason is null
            and applied_event_id is not null
            and applied_revision > 0
            and completed_at is not null
        )
        or (
            status = 'superseded'
            and terminal_reason in (
                'superseded_by_episode_end',
                'participant_already_terminal',
                'participant_generation_replaced'
            )
            and applied_event_id is null
            and applied_revision is null
            and completed_at is not null
        )
    )
);
create unique index sync_lifecycle_intents_episode_end_key
    on sync_lifecycle_intents(tenant_id, episode_id)
    where intent_name = 'episode_ended';
create unique index sync_lifecycle_intents_participant_transition_key
    on sync_lifecycle_intents(
        tenant_id,
        episode_id,
        intent_name,
        participant_id,
        participant_generation
    )
    where intent_name in ('participant_joined', 'participant_left');
create index sync_lifecycle_intents_pending_attempt_idx
    on sync_lifecycle_intents(next_attempt_at, attempt_count, created_at, lifecycle_intent_id)
    where status = 'pending';
create index sync_lifecycle_intents_episode_pending_idx
    on sync_lifecycle_intents(tenant_id, episode_id)
    where status = 'pending';

create table sync_control_events (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    event_id uuid not null unique,
    base_revision bigint not null,
    revision bigint not null,
    event_name text not null,
    payload jsonb not null,
    actor_participant_id uuid,
    actor_generation bigint,
    command_id text,
    lifecycle_intent_id uuid,
    external_operation_id uuid,
    event_schema_version integer not null check (event_schema_version > 0),
    resulting_state_digest bytea not null check (octet_length(resulting_state_digest) = 32),
    encoded_bytes integer not null check (encoded_bytes between 1 and 32768),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, revision),
    unique (tenant_id, episode_id, lifecycle_intent_id, event_id, revision),
    unique (tenant_id, episode_id, external_operation_id, event_id, revision),
    unique (tenant_id, episode_id, event_id, revision),
    unique (
        tenant_id,
        episode_id,
        actor_participant_id,
        actor_generation,
        command_id,
        event_id,
        revision
    ),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, actor_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        actor_participant_id, actor_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (base_revision >= 0 and revision = base_revision + 1),
    check (
        num_nonnulls(command_id, lifecycle_intent_id, external_operation_id) = 1
        and (
            (
                command_id is not null
                and command_id ~ '^[A-Za-z0-9_-]{16,64}$'
                and actor_participant_id is not null
                and actor_generation > 0
            )
            or (
                lifecycle_intent_id is not null
                and actor_participant_id is null
                and actor_generation is null
            )
            or (
                external_operation_id is not null
                and (actor_participant_id is null) = (actor_generation is null)
                and (actor_generation is null or actor_generation > 0)
            )
        )
    )
);
create unique index sync_control_events_command_origin_key
    on sync_control_events(
        tenant_id,
        episode_id,
        actor_participant_id,
        command_id
    )
    where command_id is not null;
create unique index sync_control_events_lifecycle_origin_key
    on sync_control_events(tenant_id, episode_id, lifecycle_intent_id)
    where lifecycle_intent_id is not null;
create table sync_command_receipts (
    tenant_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    submitted_generation bigint not null check (submitted_generation > 0),
    command_id text not null check (command_id ~ '^[A-Za-z0-9_-]{16,64}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    command_name text not null check (command_name in (
        'raise_hand',
        'lower_hand',
        'set_hand_raised',
        'set_display_name',
        'set_admission_policy',
        'set_participant_role',
        'assign_roles',
        'admit_participant',
        'deny_admission',
        'mute_participant',
        'stop_participant_camera',
        'stop_participant_screen_share',
        'remove_participant',
        'start_recording',
        'stop_recording',
        'participant_leave',
        'end_episode'
    )),
    outcome text not null,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    resulting_state_digest bytea,
    external_operation_id uuid,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, command_id),
    foreign key (tenant_id, episode_id)
        references sync_episode_control(tenant_id, episode_id)
        on delete restrict,
    constraint sync_command_receipts_sync_event_fkey foreign key (
        tenant_id, episode_id, event_id, resulting_revision
    )
    references sync_control_events(
        tenant_id, episode_id, event_id, revision
    )
    on delete restrict
    deferrable initially deferred,
    check (
        (
            command_name in ('raise_hand', 'lower_hand')
            and resulting_state_digest is null
            and external_operation_id is null
            and completed_at is null
            and (
                (
                    outcome = 'committed'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                )
                or (
                    outcome = 'rejected'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'command_id_conflict'
                    )
                    and event_id is null
                    and resulting_revision is null
                )
            )
        )
        or (
            command_name in (
                'set_hand_raised',
                'set_display_name',
                'set_admission_policy',
                'set_participant_role',
                'assign_roles',
                'admit_participant',
                'deny_admission',
                'mute_participant',
                'stop_participant_camera',
                'stop_participant_screen_share',
                'remove_participant',
                'start_recording',
                'stop_recording',
                'participant_leave',
                'end_episode'
            )
            and (
                (
                    outcome = 'committed'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                    and octet_length(resulting_state_digest) = 32
                    and completed_at is not null
                )
                or (
                    outcome = 'satisfied'
                    and rejection_reason is null
                    and event_id is null
                    and resulting_revision >= 0
                    and octet_length(resulting_state_digest) = 32
                    and external_operation_id is null
                    and completed_at is not null
                )
                or (
                    outcome = 'pending'
                    and rejection_reason is null
                    and external_operation_id is not null
                    and completed_at is null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
                or (
                    outcome = 'rejected'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'invalid_target',
                        'role_not_eligible',
                        'role_assignment_required',
                        'screen_share_in_use',
                        'recording_in_progress',
                        'external_operation_failed'
                    )
                    and completed_at is not null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and external_operation_id is not null
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
            )
        )
    )
);

alter table sync_lifecycle_intents
    add foreign key (
        tenant_id,
        episode_id,
        lifecycle_intent_id,
        applied_event_id,
        applied_revision
    )
    references sync_control_events(
        tenant_id,
        episode_id,
        lifecycle_intent_id,
        event_id,
        revision
    )
    on delete restrict;

create table sync_external_operations (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    external_operation_id uuid primary key,
    parent_external_operation_id uuid,
    request_key text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    actor_participant_id uuid,
    actor_generation bigint,
    target_participant_id uuid,
    target_participant_generation bigint,
    source text,
    recording_id uuid,
    deadline_generation bigint,
    journey_id uuid,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    payload jsonb not null,
    status text not null default 'pending',
    fence_active boolean not null default false,
    attempt_count integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error_code text,
    applied_event_id uuid,
    applied_revision bigint,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, external_operation_id),
    unique (tenant_id, episode_id, external_operation_id),
    unique (tenant_id, episode_id, operation_name, request_key),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        actor_participant_id, actor_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        target_participant_id, target_participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(payload::text) <= 16384),
    check (operation_name in (
        'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
        'stop_participant_camera', 'stop_participant_screen_share',
        'remove_participant', 'start_recording', 'stop_recording',
        'participant_leave', 'end_episode', 'tenant_assign_roles', 'tenant_set_deadline',
        'tenant_end_episode', 'maximum_episode_duration_expired',
        'role_transition_cleanup', 'role_transition_source_stop'
    )),
    check (source is null or source in ('microphone', 'camera', 'screen')),
    check ((actor_participant_id is null) = (actor_generation is null)),
    check (actor_generation is null or actor_generation > 0),
    check ((target_participant_id is null) = (target_participant_generation is null)),
    check (target_participant_generation is null or target_participant_generation > 0),
    check (deadline_generation is null or deadline_generation > 0),
    check (
        (operation_name in ('tenant_set_deadline', 'maximum_episode_duration_expired'))
        = (deadline_generation is not null)
    ),
    check ((journey_id is null) = (parent_journey_event_id is null)),
    check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$'),
    check ((producing_trace_id is null) = (producing_span_id is null)),
    check (attempt_count between 0 and 100),
    check (
        (operation_name = 'role_transition_cleanup' and parent_external_operation_id is null and source is null)
        or (operation_name = 'role_transition_source_stop' and parent_external_operation_id is not null and source is not null)
        or (operation_name not in ('role_transition_cleanup', 'role_transition_source_stop') and parent_external_operation_id is null)
    ),
    check (
        (
            status = 'pending'
            and completed_at is null
            and applied_event_id is null
            and applied_revision is null
        )
        or (
            status = 'applied'
            and completed_at is not null
            and last_error_code is null
            and ((applied_event_id is null and applied_revision is null) or (applied_event_id is not null and applied_revision > 0))
            and fence_active = false
        )
        or (
            status = 'failed'
            and completed_at is not null
            and last_error_code is not null
            and applied_event_id is null
            and applied_revision is null
        )
    )
);
alter table sync_external_operations
    add foreign key (tenant_id, episode_id, parent_external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;
create unique index sync_external_operations_parent_source_key
    on sync_external_operations(tenant_id, episode_id, parent_external_operation_id, source)
    where parent_external_operation_id is not null;
create index sync_external_operations_pending_idx
    on sync_external_operations(next_attempt_at, external_operation_id)
    where status = 'pending';

alter table sync_control_events
    add foreign key (tenant_id, episode_id, external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;

alter table sync_external_operations
    add foreign key (
        tenant_id,
        episode_id,
        external_operation_id,
        applied_event_id,
        applied_revision
    )
    references sync_control_events(
        tenant_id,
        episode_id,
        external_operation_id,
        event_id,
        revision
    )
    on delete restrict;

alter table sync_command_receipts
    add foreign key (tenant_id, episode_id, external_operation_id)
    references sync_external_operations(tenant_id, episode_id, external_operation_id)
    on delete restrict;

create table sync_admission_requests (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    admission_request_id uuid primary key,
    request_key text not null,
    request_fingerprint bytea not null,
    participant_id uuid not null,
    display_name text not null,
    role text not null,
    status text not null default 'pending',
    decision_external_operation_id uuid,
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, admission_request_id),
    unique (tenant_id, episode_id, request_key),
    unique (tenant_id, episode_id, participant_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (tenant_id, episode_id, decision_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (expires_at > requested_at),
    check (
        (status = 'pending' and completed_at is null)
        or (status in ('admitted', 'denied', 'expired') and decision_external_operation_id is not null and completed_at is not null)
    )
);
create index sync_admission_requests_pending_idx
    on sync_admission_requests(expires_at, admission_request_id)
    where status = 'pending';

create table sync_screen_share_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    lease_id uuid not null unique,
    owner_participant_id uuid not null,
    owner_generation bigint not null,
    lease_generation bigint not null,
    status text not null,
    acquired_at timestamptz not null,
    renewed_until timestamptz not null,
    hard_expires_at timestamptz not null,
    primary key (tenant_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        owner_participant_id, owner_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (owner_generation > 0 and lease_generation > 0),
    check (status in ('acquiring', 'active')),
    check (acquired_at < renewed_until and renewed_until <= hard_expires_at)
);
create index sync_screen_share_leases_expiry_idx
    on sync_screen_share_leases(hard_expires_at, lease_id);

create table sync_publication_fences (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    external_operation_id uuid not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, episode_id, external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (source in ('microphone', 'camera', 'screen')),
    check (participant_generation > 0),
    check (expires_at > created_at)
);
create index sync_publication_fences_expiry_idx
    on sync_publication_fences(expires_at, external_operation_id);

create table sync_publication_grant_reservations (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    reservation_id uuid primary key,
    operation_id text not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    status text not null default 'pending',
    failure_code text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, episode_id, operation_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        participant_id, participant_generation
    ) references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (operation_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (status in ('pending', 'confirmed', 'failed', 'ambiguous')),
    check (expires_at > created_at),
    check (
        (status in ('pending', 'ambiguous') and completed_at is null)
        or (status = 'confirmed' and failure_code is null and completed_at is not null)
        or (status = 'failed' and failure_code is not null and completed_at is not null)
    )
);
create unique index sync_publication_grant_reservations_active_source_key
    on sync_publication_grant_reservations(tenant_id, episode_id, participant_id, source)
    where status in ('pending', 'ambiguous');
create index sync_publication_grant_reservations_expiry_idx
    on sync_publication_grant_reservations(expires_at, reservation_id);

create table sync_recordings (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid primary key,
    status text not null,
    generation bigint not null,
    adapter_metadata jsonb not null default '{}'::jsonb,
    started_by_participant_id uuid,
    started_by_generation bigint,
    start_external_operation_id uuid not null,
    stop_external_operation_id uuid,
    failure_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, space_id, episode_id, recording_id),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete restrict,
    foreign key (
        tenant_id, space_id, episode_id,
        started_by_participant_id, started_by_generation
    )
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, episode_id, start_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    foreign key (tenant_id, episode_id, stop_external_operation_id)
        references sync_external_operations(tenant_id, episode_id, external_operation_id)
        on delete restrict,
    check (status in ('starting', 'recording', 'stopping', 'stopped', 'failed')),
    check (generation > 0),
    check ((started_by_participant_id is null) = (started_by_generation is null)),
    check (started_by_generation is null or started_by_generation > 0),
    check (
        (status in ('starting', 'recording', 'stopping') and completed_at is null and failure_code is null)
        or (status = 'stopped' and completed_at is not null and failure_code is null)
        or (status = 'failed' and completed_at is not null and failure_code is not null)
    )
);
create unique index sync_recordings_one_active_per_episode_idx
    on sync_recordings(tenant_id, episode_id)
    where status in ('starting', 'recording', 'stopping');

-- +goose StatementBegin
create function sync_validate_receipt_event_origin()
returns trigger
language plpgsql
as $$
declare
    event_row sync_control_events%rowtype;
begin
    if new.outcome <> 'committed' then
        return new;
    end if;

    select *
    into event_row
    from sync_control_events
    where tenant_id = new.tenant_id
      and episode_id = new.episode_id
      and event_id = new.event_id
      and revision = new.resulting_revision;

    if not found then
        raise exception 'committed sync receipt references a missing event';
    end if;

    if event_row.command_id = new.command_id
        and event_row.actor_participant_id = new.participant_id
        and event_row.actor_generation = new.submitted_generation then
        return new;
    end if;

    if new.external_operation_id is not null
        and event_row.external_operation_id = new.external_operation_id then
        return new;
    end if;

    if new.command_name = 'admit_participant'
        and new.external_operation_id is not null
        and event_row.event_name = 'participant_joined'
        and event_row.lifecycle_intent_id is not null
        and exists (
            select 1
            from sync_admission_requests admission
            where admission.tenant_id = new.tenant_id
              and admission.episode_id = new.episode_id
              and admission.decision_external_operation_id = new.external_operation_id
              and admission.status = 'admitted'
              and admission.participant_id::text =
                  event_row.payload ->> 'participant_id'
        ) then
        return new;
    end if;

    raise exception 'committed sync receipt event origin does not match its durable request';
end;
$$;
-- +goose StatementEnd

create constraint trigger sync_command_receipts_event_origin
after insert or update on sync_command_receipts
deferrable initially deferred
for each row execute function sync_validate_receipt_event_origin();

create table recordings (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    -- pending (should be rare ideally), processing, completed, failed
    status text not null,
    -- s3, cf, do
    storage_provider text not null,
    storage_key text,
    metadata jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index recordings_tenant_created_at_id_idx on recordings(tenant_id, created_at desc, id desc);
create index recordings_tenant_episode_created_at_id_idx on recordings(tenant_id, episode_id, created_at desc, id desc);

create table transcriptions (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    -- not_requested, preparing, transcribing, verifying, complete,
    -- retryable_failure, terminal_failure, deleted
    status text not null,
    provider text,
    model text,
    languages text[] not null,
    metadata jsonb,
    artifact_key text,
    artifact_sha256 bytea,
    artifact_size bigint,
    artifact_content_type text,
    source_manifest_key text,
    source_manifest_sha256 bytea,
    source_manifest_size bigint,
    source_manifest_content_type text,
    generation bigint not null default 1,
    completed_at timestamptz,
    deleted_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint transcriptions_status_check check (status in ('not_requested', 'preparing', 'transcribing', 'verifying', 'complete', 'retryable_failure', 'terminal_failure', 'deleted')),
    constraint transcriptions_generation_check check (generation > 0),
    constraint transcriptions_artifact_sha256_check check (artifact_sha256 is null or octet_length(artifact_sha256) = 32),
    constraint transcriptions_source_manifest_sha256_check check (source_manifest_sha256 is null or octet_length(source_manifest_sha256) = 32),
    constraint transcriptions_artifact_size_check check (artifact_size is null or artifact_size >= 0),
    constraint transcriptions_source_manifest_size_check check (source_manifest_size is null or source_manifest_size >= 0),
    constraint transcriptions_artifact_key_check check (artifact_key is null or (length(artifact_key) between 1 and 1024 and artifact_key !~ '(^/|//|(^|/)\.\.?(/|$))'))
);
create index transcriptions_tenant_created_at_id_idx on transcriptions(tenant_id, created_at desc, id desc);
create index transcriptions_tenant_recording_created_at_id_idx on transcriptions(tenant_id, recording_id, created_at desc, id desc);
create unique index transcriptions_recording_id_uidx on transcriptions(recording_id);

create table recording_transcription_sources (
    recording_id uuid primary key references recordings(id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    manifest_key text not null,
    manifest_sha256 bytea not null,
    manifest_size bigint not null,
    manifest_content_type text not null,
    schema_version integer not null,
    committed_at timestamptz not null,
    constraint recording_transcription_sources_sha256_check check (octet_length(manifest_sha256) = 32),
    constraint recording_transcription_sources_size_check check (manifest_size between 1 and 524288000),
    constraint recording_transcription_sources_key_check check (length(manifest_key) between 1 and 1024),
    constraint recording_transcription_sources_content_type_check check (manifest_content_type = 'application/json')
);
create table recording_transcription_source_chunks (
    id uuid primary key,
    recording_id uuid not null references recording_transcription_sources(recording_id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    chunk_index integer not null,
    generation bigint not null default 1,
    start_ms bigint not null,
    end_ms bigint not null,
    participant_ref text,
    track_epoch text,
    identity_kind text not null default 'unknown',
    track_class text not null default 'unknown',
    storage_key text not null,
    checksum bytea not null,
    size bigint not null,
    content_type text not null,
    unique (recording_id, generation, chunk_index),
    constraint recording_transcription_source_chunks_index_check check (chunk_index >= 0),
    constraint recording_transcription_source_chunks_time_check check (start_ms >= 0 and end_ms > start_ms),
    constraint recording_transcription_source_chunks_identity_kind_check check (identity_kind in ('participant', 'shared', 'unknown')),
    constraint recording_transcription_source_chunks_track_class_check check (track_class in ('microphone', 'screen-share', 'system-audio', 'unknown')),
    constraint recording_transcription_source_chunks_identity_fields_check check (
        (identity_kind = 'participant' and participant_ref is not null and track_epoch is not null)
        or (identity_kind in ('shared', 'unknown') and participant_ref is null and track_epoch is null)
    ),
    constraint recording_transcription_source_chunks_system_audio_identity_check check (not (track_class = 'system-audio' and identity_kind = 'participant')),
    constraint recording_transcription_source_chunks_checksum_check check (octet_length(checksum) = 32),
    constraint recording_transcription_source_chunks_size_check check (size between 1 and 524288000)
);
create index recording_transcription_source_chunks_recording_idx on recording_transcription_source_chunks(recording_id, generation, chunk_index);

create table artifact_jobs (
    id uuid primary key,
    idempotency_key text not null,
    tenant_id uuid not null references tenants(id),
    episode_id uuid references episodes(id),
    recording_id uuid references recordings(id),
    transcript_id uuid references transcriptions(id),
    chunk_id uuid,
    artifact_kind text not null,
    payload_schema_version integer not null,
    state text not null,
    priority integer not null default 0,
    available_at timestamptz not null default now(),
    attempt_count integer not null default 0,
    attempt_limit integer not null default 4,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamptz,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    terminal_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, idempotency_key),
    constraint artifact_jobs_key_check check (idempotency_key ~ '^[A-Za-z0-9._-]{1,128}$'),
    constraint artifact_jobs_kind_check check (artifact_kind in ('recording', 'transcription', 'transcription_chunk', 'transcription_finalize')),
    constraint artifact_jobs_state_check check (state in ('pending', 'leased', 'retryable', 'completed', 'dead_letter', 'cancelled')),
    constraint artifact_jobs_schema_version_check check (payload_schema_version between 1 and 99),
    constraint artifact_jobs_priority_check check (priority between -100 and 100),
    constraint artifact_jobs_attempt_count_check check (attempt_count >= 0 and attempt_count <= attempt_limit),
    constraint artifact_jobs_attempt_limit_check check (attempt_limit between 1 and 32),
    constraint artifact_jobs_lease_hash_check check (lease_token_hash is null or octet_length(lease_token_hash) = 32),
    constraint artifact_jobs_owner_check check (lease_owner is null or length(lease_owner) between 1 and 128),
    constraint artifact_jobs_error_code_check check (error_code is null or length(error_code) between 1 and 128),
    constraint artifact_jobs_error_detail_check check (error_detail is null or octet_length(error_detail) <= 2048),
    constraint artifact_jobs_traceparent_check check (traceparent is null or length(traceparent) <= 256),
    constraint artifact_jobs_tracestate_check check (tracestate is null or length(tracestate) <= 512),
    constraint artifact_jobs_lease_fields_check check ((lease_token_hash is null and lease_owner is null and lease_expires_at is null) or (lease_token_hash is not null and lease_owner is not null and lease_expires_at is not null)),
    constraint artifact_jobs_terminal_fields_check check ((state in ('completed', 'dead_letter', 'cancelled')) = (terminal_at is not null))
);
create index artifact_jobs_claim_idx on artifact_jobs(priority desc, available_at asc, created_at asc, id asc) where state in ('pending', 'retryable');
create index artifact_jobs_lease_expiry_idx on artifact_jobs(lease_expires_at) where state = 'leased';
create index artifact_jobs_tenant_created_idx on artifact_jobs(tenant_id, created_at desc, id desc);

create table transcript_chunks (
    id uuid primary key,
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    tenant_id uuid not null references tenants(id),
    chunk_index integer not null,
    generation bigint not null default 1,
    start_ms bigint not null,
    end_ms bigint not null,
    participant_ref text,
    track_epoch text,
    identity_kind text not null default 'unknown',
    track_class text not null default 'unknown',
    storage_key text not null,
    result_key text not null,
    checksum bytea not null,
    size bigint not null,
    content_type text not null,
    created_at timestamptz not null default now(),
    unique (transcript_id, generation, chunk_index),
    constraint transcript_chunks_index_check check (chunk_index >= 0),
    constraint transcript_chunks_generation_check check (generation > 0),
    constraint transcript_chunks_time_check check (start_ms >= 0 and end_ms > start_ms),
    constraint transcript_chunks_identity_kind_check check (identity_kind in ('participant', 'shared', 'unknown')),
    constraint transcript_chunks_track_class_check check (track_class in ('microphone', 'screen-share', 'system-audio', 'unknown')),
    constraint transcript_chunks_identity_fields_check check (
        (identity_kind = 'participant' and participant_ref is not null and track_epoch is not null)
        or (identity_kind in ('shared', 'unknown') and participant_ref is null and track_epoch is null)
    ),
    constraint transcript_chunks_system_audio_identity_check check (not (track_class = 'system-audio' and identity_kind = 'participant')),
    constraint transcript_chunks_ref_check check (participant_ref is null or length(participant_ref) between 1 and 128),
    constraint transcript_chunks_epoch_check check (track_epoch is null or length(track_epoch) between 1 and 128),
    constraint transcript_chunks_checksum_check check (octet_length(checksum) = 32),
    constraint transcript_chunks_size_check check (size between 1 and 524288000),
    constraint transcript_chunks_key_check check (length(storage_key) between 1 and 1024 and storage_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcript_chunks_result_key_check check (length(result_key) between 1 and 1024 and result_key !~ '(^/|//|(^|/)\.\.?(/|$))')
);
alter table artifact_jobs add constraint artifact_jobs_chunk_fkey foreign key (chunk_id) references transcript_chunks(id) on delete restrict;
create index transcript_chunks_transcript_idx on transcript_chunks(transcript_id, generation, chunk_index);

create table transcription_attempts (
    id uuid primary key,
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    chunk_id uuid not null references transcript_chunks(id) on delete restrict,
    generation bigint not null,
    attempt integer not null,
    provider text not null,
    model text not null,
    provider_version text not null,
    execution_identity text,
    provider_request_id text,
    measured_audio_ms bigint,
    provider_observed_duration_ms bigint,
    state text not null,
    billed_audio_seconds integer,
    error_code text,
    error_detail text,
    journey_id uuid,
    traceparent text,
    tracestate text,
    quality jsonb not null default '{}'::jsonb,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    created_at timestamptz not null default now(),
    unique (chunk_id, generation, attempt),
    constraint transcription_attempts_generation_check check (generation > 0),
    constraint transcription_attempts_attempt_check check (attempt > 0 and attempt <= 32),
    constraint transcription_attempts_state_check check (state in ('started', 'retryable_failure', 'accepted', 'rejected', 'cancelled')),
    constraint transcription_attempts_provider_check check (length(provider) between 1 and 128),
    constraint transcription_attempts_model_check check (length(model) between 1 and 256),
    constraint transcription_attempts_version_check check (length(provider_version) between 1 and 256),
    constraint transcription_attempts_request_id_check check (provider_request_id is null or length(provider_request_id) between 1 and 256),
    constraint transcription_attempts_execution_identity_check check (execution_identity is null or length(execution_identity) between 1 and 256),
    constraint transcription_attempts_measured_audio_check check (measured_audio_ms is null or measured_audio_ms between 0 and 86400000),
    constraint transcription_attempts_observed_duration_check check (provider_observed_duration_ms is null or provider_observed_duration_ms between 0 and 86400000),
    constraint transcription_attempts_quality_check check (jsonb_typeof(quality) = 'object'),
    constraint transcription_attempts_billed_check check (billed_audio_seconds is null or billed_audio_seconds between 0 and 86400),
    constraint transcription_attempts_error_detail_check check (error_detail is null or octet_length(error_detail) <= 2048),
    constraint transcription_attempts_traceparent_check check (traceparent is null or length(traceparent) <= 256),
    constraint transcription_attempts_tracestate_check check (tracestate is null or length(tracestate) <= 512)
);

create table transcription_chunk_results (
    id uuid primary key,
    chunk_id uuid not null references transcript_chunks(id) on delete restrict,
    generation bigint not null,
    attempt_id uuid not null references transcription_attempts(id) on delete restrict,
    provider text not null,
    model text not null,
    provider_version text not null,
    result_key text not null,
    result_sha256 bytea not null,
    result_size bigint not null,
    result_content_type text not null,
    language text,
    billed_audio_seconds integer,
    quality jsonb not null default '{}'::jsonb,
    accepted_at timestamptz not null default now(),
    unique (chunk_id, generation),
    unique (attempt_id),
    constraint transcription_chunk_results_generation_check check (generation > 0),
    constraint transcription_chunk_results_sha256_check check (octet_length(result_sha256) = 32),
    constraint transcription_chunk_results_size_check check (result_size between 1 and 524288000),
    constraint transcription_chunk_results_key_check check (length(result_key) between 1 and 1024 and result_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcription_chunk_results_quality_check check (jsonb_typeof(quality) = 'object'),
    constraint transcription_chunk_results_billed_check check (billed_audio_seconds is null or billed_audio_seconds between 0 and 86400)
);
create table transcription_cleanup_jobs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    transcript_id uuid not null references transcriptions(id) on delete restrict,
    object_key text not null,
    object_kind text not null,
    due_at timestamptz not null,
    state text not null default 'pending',
    attempt_count integer not null default 0,
    attempt_limit integer not null default 8,
    lease_token_hash bytea,
    lease_owner text,
    lease_expires_at timestamptz,
    error_code text,
    error_detail text,
    verified_at timestamptz,
    provider_copy_status text not null default 'not_applicable',
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (transcript_id, object_key),
    constraint transcription_cleanup_jobs_key_check check (length(object_key) between 1 and 1024 and object_key !~ '(^/|//|(^|/)\.\.?(/|$))'),
    constraint transcription_cleanup_jobs_kind_check check (object_kind in ('final_artifact', 'temp_chunk', 'temp_result')),
    constraint transcription_cleanup_jobs_state_check check (state in ('pending', 'leased', 'retryable', 'completed', 'dead_letter')),
    constraint transcription_cleanup_jobs_attempt_check check (attempt_count >= 0 and attempt_count <= attempt_limit),
    constraint transcription_cleanup_jobs_attempt_limit_check check (attempt_limit between 1 and 32),
    constraint transcription_cleanup_jobs_lease_hash_check check (lease_token_hash is null or octet_length(lease_token_hash) = 32),
    constraint transcription_cleanup_jobs_lease_fields_check check ((lease_token_hash is null and lease_owner is null and lease_expires_at is null) or (lease_token_hash is not null and lease_owner is not null and lease_expires_at is not null)),
    constraint transcription_cleanup_jobs_verified_check check ((state = 'completed') = (verified_at is not null)),
    constraint transcription_cleanup_jobs_provider_copy_check check (provider_copy_status in ('not_applicable', 'pending', 'completed', 'failed'))
);
create index transcription_cleanup_jobs_claim_idx on transcription_cleanup_jobs(due_at, created_at, id) where state in ('pending', 'retryable');

create table recording_capacity (
    id smallint primary key check (id = 1),
    reserved_episodes integer not null default 0 check (reserved_episodes between 0 and 20),
    reserved_participants integer not null default 0 check (reserved_participants between 0 and 100),
    reserved_input_bitrate_bps bigint not null default 0 check (reserved_input_bitrate_bps >= 0),
    updated_at timestamptz not null default now()
);

create table recording_pool_health (
    role text primary key check (role in ('capture', 'render')),
    admission_open boolean not null,
    ready_capacity integer not null check (ready_capacity >= 0),
    reason text not null check (octet_length(reason) <= 256),
    observed_at timestamptz not null,
    updated_at timestamptz not null default now()
);

create table recording_reservations (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    space_id uuid not null references spaces(id),
    episode_id uuid not null references episodes(id),
    recording_id uuid not null references recordings(id),
    idempotency_key text not null,
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    participant_count integer not null check (participant_count between 1 and 10),
    max_duration_seconds integer not null check (max_duration_seconds between 1 and 7200),
    input_bitrate_bps bigint not null check (input_bitrate_bps between 1 and 4000000),
    state text not null check (state in ('reserved', 'released', 'expired')),
    starts_at timestamptz,
    ends_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, idempotency_key)
);
create index recording_reservations_active_idx
    on recording_reservations(state, starts_at, ends_at)
    where state = 'reserved';
create index recording_reservations_tenant_created_idx
    on recording_reservations(tenant_id, created_at desc, id desc);

create table recording_pipelines (
    recording_id uuid primary key references recordings(id),
    tenant_id uuid not null references tenants(id),
    reservation_id uuid not null unique references recording_reservations(id),
    state text not null check (state in (
        'requested', 'reserved', 'capture_leased', 'capturing_segmented',
        'capture_complete', 'render_queued', 'rendering', 'verifying',
        'committed', 'retryable_failure', 'terminal_failure', 'deleted'
    )),
    capture_completed_at timestamptz,
    committed_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index recording_pipelines_tenant_state_idx
    on recording_pipelines(tenant_id, state, updated_at desc);

create table recording_jobs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    episode_id uuid not null references episodes(id),
    recording_id uuid not null references recordings(id),
    kind text not null check (kind in ('capture', 'render')),
    idempotency_key text not null unique,
    payload_schema_version integer not null check (payload_schema_version > 0),
    state text not null check (state in ('pending', 'leased', 'succeeded', 'retryable_failure', 'terminal_failure', 'cancelled')),
    priority integer not null default 0,
    available_at timestamptz not null,
    attempt_count integer not null default 0 check (attempt_count >= 0),
    attempt_limit integer not null check (attempt_limit between 1 and 20),
    lease_token text,
    lease_owner text,
    lease_expires_at timestamptz,
    fencing_generation bigint not null default 0 check (fencing_generation >= 0),
    error_code text,
    error_detail text,
    terminal_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    check (error_code is null or octet_length(error_code) <= 128),
    check (error_detail is null or octet_length(error_detail) <= 2048),
    check ((state = 'leased') = (lease_token is not null and lease_owner is not null and lease_expires_at is not null))
);
create index recording_jobs_claim_idx
    on recording_jobs(kind, state, available_at, priority desc, id)
    where state = 'pending';
create index recording_jobs_lease_recovery_idx
    on recording_jobs(lease_expires_at, id)
    where state = 'leased';
create index recording_jobs_dead_letter_idx
    on recording_jobs(tenant_id, terminal_at desc, id)
    where state = 'terminal_failure';
create unique index recording_jobs_recording_kind_idx
    on recording_jobs(recording_id, kind);

create table recording_bundles (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    capture_job_id uuid not null references recording_jobs(id),
    sequence_number bigint not null check (sequence_number >= 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    object_key text not null,
    content_type text not null,
    codec text not null,
    layer text,
    byte_size bigint not null check (byte_size >= 0),
    checksum bytea not null check (octet_length(checksum) between 16 and 128),
    monotonic_start_millis bigint not null check (monotonic_start_millis >= 0),
    monotonic_end_millis bigint not null check (monotonic_end_millis >= monotonic_start_millis),
    media_start_millis bigint not null check (media_start_millis >= 0),
    media_end_millis bigint not null check (media_end_millis >= media_start_millis),
    created_at timestamptz not null default now(),
    unique (recording_id, sequence_number)
);
create index recording_bundles_recording_sequence_idx
    on recording_bundles(recording_id, sequence_number);

create table recording_artifacts (
    recording_id uuid primary key references recordings(id),
    tenant_id uuid not null references tenants(id),
    render_job_id uuid not null references recording_jobs(id),
    object_key text not null,
    content_type text not null,
    byte_size bigint not null check (byte_size >= 0),
    checksum bytea not null check (octet_length(checksum) between 16 and 128),
    duration_millis bigint not null check (duration_millis >= 0),
    committed_at timestamptz not null,
    created_at timestamptz not null default now()
);

-- +goose StatementBegin
create function reject_recording_object_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording object facts are immutable';
end;
$$;
-- +goose StatementEnd

create trigger recording_bundles_immutable
before update on recording_bundles
for each row execute function reject_recording_object_mutation();

create trigger recording_artifacts_immutable
before update on recording_artifacts
for each row execute function reject_recording_object_mutation();

create table audit_logs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    actor_user_id uuid references users(id),
    actor_type text not null, -- user, api_key, system
    action text not null,
    resource_type text,
    resource_id uuid,
    details jsonb,
    outcome text not null, -- success, failure, pending
    error_code text,
    error_message text,
    before jsonb,
    after jsonb,
    external_request_id text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index audit_logs_tenant_created_at_id_idx on audit_logs(tenant_id, created_at desc, id desc);
create index audit_logs_tenant_action_created_at_id_idx on audit_logs(tenant_id, action, created_at desc, id desc);
create index audit_logs_tenant_resource_created_at_id_idx
    on audit_logs(tenant_id, resource_type, resource_id, created_at desc, id desc)
    where resource_type is not null and resource_id is not null;

create table integration_connections (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    user_id uuid not null references users(id),
    -- composio, direct, arcade, nango
    provider text not null,
    -- slack, github, linear, notion, google_calendar, gmail
    service text not null,
    external_account_ref text not null,
    external_auth_config_ref text,
    -- pending, active, expired, revoked, disabled, failed
    status text not null,
    account_label text,
    account_email text,
    scopes text[] not null default '{}',
    metadata jsonb,
    connected_at timestamptz,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, provider, service, external_account_ref)
);
create index integration_connections_tenant_user_service_idx
    on integration_connections(tenant_id, user_id, service, created_at desc, id desc);
create index integration_connections_tenant_provider_service_idx
    on integration_connections(tenant_id, provider, service, created_at desc, id desc);
create index integration_connections_tenant_status_idx
    on integration_connections(tenant_id, status, created_at desc, id desc);
create index integration_connections_tenant_created_at_id_idx
    on integration_connections(tenant_id, created_at desc, id desc);

create table observability_journey_events (
    event_id uuid primary key,
    journey_id uuid not null,
    sequence bigint not null check (sequence >= 0),
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    name text not null,
    phase text not null,
    state text not null,
    origin_kind text not null,
    first_observed_layer text not null,
    upstream_visibility text not null,
    parent_event_id uuid,
    trace_id text,
    span_id text,
    attributes jsonb not null default '{}'::jsonb,
    check (jsonb_typeof(attributes) = 'object')
);
create index observability_journey_events_journey_order_idx
    on observability_journey_events(journey_id, sequence asc, occurred_at asc, event_id asc);
create index observability_journey_events_terminal_idx
    on observability_journey_events(journey_id, sequence desc, occurred_at desc, event_id desc)
    where phase = 'terminal'
        and state in ('completed', 'succeeded', 'failed', 'cancelled', 'canceled', 'exhausted', 'erased');

alter table sync_lifecycle_intents
    add column journey_id uuid,
    add column parent_journey_event_id uuid,
    add column producing_trace_id text,
    add column producing_span_id text,
    add constraint sync_lifecycle_intents_trace_id_check
        check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    add constraint sync_lifecycle_intents_span_id_check
        check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$');

create table webhook_tenant_state (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    updated_at timestamptz not null default now()
);

create table webhook_endpoints (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    enabled boolean not null,
    revision integer not null,
    current_target_revision integer not null,
    current_secret_ciphertext bytea,
    previous_secret_ciphertext bytea,
    previous_secret_expires_at timestamptz,
    created_by_user_id uuid references users(id) on delete set null,
    deleted_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint webhook_endpoints_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_endpoints_name_check
        check (char_length(btrim(name)) between 1 and 100 and name = btrim(name)),
    constraint webhook_endpoints_revision_check
        check (revision > 0 and current_target_revision > 0),
    constraint webhook_endpoints_previous_secret_check check (
        (previous_secret_ciphertext is null and previous_secret_expires_at is null)
        or
        (previous_secret_ciphertext is not null and previous_secret_expires_at is not null)
    ),
    constraint webhook_endpoints_deleted_secret_check check (
        (deleted_at is null and current_secret_ciphertext is not null)
        or
        (
            deleted_at is not null
            and not enabled
            and current_secret_ciphertext is null
            and previous_secret_ciphertext is null
            and previous_secret_expires_at is null
        )
    )
);

create index webhook_endpoints_tenant_created_at_id_idx
    on webhook_endpoints(tenant_id, created_at desc, id desc)
    where deleted_at is null;

create table webhook_endpoint_revisions (
    id uuid primary key,
    tenant_id uuid not null,
    endpoint_id uuid not null,
    revision integer not null,
    url_ciphertext bytea,
    url_redacted text not null,
    url_destroyed_at timestamptz,
    api_version integer not null,
    event_types text[] not null,
    created_at timestamptz not null default now(),
    constraint webhook_endpoint_revisions_tenant_id_id_key
        unique (tenant_id, id),
    constraint webhook_endpoint_revisions_identity_key
        unique (tenant_id, endpoint_id, revision),
    constraint webhook_endpoint_revisions_delivery_key
        unique (tenant_id, id, endpoint_id, revision),
    constraint webhook_endpoint_revisions_endpoint_fkey
        foreign key (tenant_id, endpoint_id)
        references webhook_endpoints(tenant_id, id)
        on delete cascade,
    constraint webhook_endpoint_revisions_revision_check check (revision > 0),
    constraint webhook_endpoint_revisions_url_check
        check (octet_length(url_redacted) between 1 and 2048),
    constraint webhook_endpoint_revisions_url_ciphertext_check check (
        (url_ciphertext is not null and url_destroyed_at is null)
        or (url_ciphertext is null and url_destroyed_at is not null)
    ),
    constraint webhook_endpoint_revisions_api_version_check check (api_version = 1),
    constraint webhook_endpoint_revisions_event_types_check check (
        cardinality(event_types) between 1 and 14
        and event_types <@ array[
            'space.created',
            'space.updated',
            'space.archived',
            'space.restored',
            'episode.started',
            'episode.ended',
            'participant.joined',
            'participant.left',
            'recording.started',
            'recording.completed',
            'recording.failed',
            'transcript.started',
            'transcript.completed',
            'transcript.failed'
        ]::text[]
    )
);

alter table webhook_endpoints
    add constraint webhook_endpoints_current_revision_fkey
    foreign key (tenant_id, id, current_target_revision)
    references webhook_endpoint_revisions(tenant_id, endpoint_id, revision)
    on delete restrict
    deferrable initially deferred;

create table webhook_events (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    event_name text not null,
    api_version integer not null,
    occurred_at timestamptz not null,
    body bytea,
    body_sha256 bytea not null,
    semantic_transition_key text not null,
    resource_type text not null,
    resource_id uuid not null,
    linked_user_id uuid references users(id) on delete restrict,
    journey_id uuid not null,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    erased_at timestamptz,
    created_at timestamptz not null default now(),
    constraint webhook_events_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_events_semantic_transition_key
        unique (tenant_id, semantic_transition_key, api_version),
    constraint webhook_events_name_check check (event_name in (
        'space.created',
        'space.updated',
        'space.archived',
        'space.restored',
        'episode.started',
        'episode.ended',
        'participant.joined',
        'participant.left',
        'recording.started',
        'recording.completed',
        'recording.failed',
        'transcript.started',
        'transcript.completed',
        'transcript.failed',
        'endpoint.test'
    )),
    constraint webhook_events_api_version_check check (api_version = 1),
    constraint webhook_events_body_hash_check check (octet_length(body_sha256) = 32),
    constraint webhook_events_body_check check (
        (
            body is not null
            and octet_length(body) between 1 and 262144
            and erased_at is null
        )
        or (body is null and erased_at is not null)
    ),
    constraint webhook_events_semantic_key_check
        check (octet_length(semantic_transition_key) between 1 and 200),
    constraint webhook_events_resource_type_check check (resource_type in (
        'space', 'episode', 'participant', 'recording', 'transcript', 'webhook_endpoint'
    )),
    constraint webhook_events_trace_id_check
        check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    constraint webhook_events_span_id_check
        check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$')
);

create index webhook_events_tenant_occurred_at_id_idx
    on webhook_events(tenant_id, occurred_at desc, id desc);
create index webhook_events_linked_user_id_idx
    on webhook_events(linked_user_id, occurred_at, id)
    where linked_user_id is not null and erased_at is null;
create index webhook_events_retention_idx
    on webhook_events(occurred_at, tenant_id, id);

create table webhook_deliveries (
    id uuid primary key,
    tenant_id uuid not null,
    event_id uuid not null,
    endpoint_id uuid not null,
    endpoint_revision_id uuid not null,
    endpoint_revision integer not null,
    state text not null,
    next_attempt_at timestamptz,
    attempt_count integer not null default 0,
    lease_token uuid,
    lease_owner text,
    lease_expires_at timestamptz,
    terminal_at timestamptz,
    queued_journey_event_id uuid not null,
    terminal_journey_event_id uuid,
    parent_delivery_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint webhook_deliveries_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_deliveries_event_fkey
        foreign key (tenant_id, event_id)
        references webhook_events(tenant_id, id)
        on delete cascade,
    constraint webhook_deliveries_revision_fkey
        foreign key (tenant_id, endpoint_revision_id, endpoint_id, endpoint_revision)
        references webhook_endpoint_revisions(tenant_id, id, endpoint_id, revision)
        on delete cascade,
    constraint webhook_deliveries_parent_fkey
        foreign key (tenant_id, parent_delivery_id)
        references webhook_deliveries(tenant_id, id)
        on delete cascade,
    constraint webhook_deliveries_state_check check (state in (
        'pending', 'delivering', 'retry_wait', 'succeeded', 'exhausted', 'canceled', 'erased'
    )),
    constraint webhook_deliveries_attempt_count_check
        check (attempt_count between 0 and 11),
    constraint webhook_deliveries_lease_check check (
        (
            state = 'delivering'
            and lease_token is not null
            and lease_owner is not null
            and lease_expires_at is not null
        )
        or
        (
            state <> 'delivering'
            and lease_token is null
            and lease_owner is null
            and lease_expires_at is null
        )
    ),
    constraint webhook_deliveries_schedule_check check (
        (state in ('pending', 'retry_wait') and next_attempt_at is not null and terminal_at is null)
        or (state = 'delivering' and next_attempt_at is null and terminal_at is null)
        or (state in ('succeeded', 'exhausted', 'canceled', 'erased') and next_attempt_at is null and terminal_at is not null)
    )
);

create unique index webhook_deliveries_automatic_fanout_key
    on webhook_deliveries(tenant_id, event_id, endpoint_revision_id)
    where parent_delivery_id is null;
create index webhook_deliveries_claim_idx
    on webhook_deliveries(next_attempt_at, created_at, id)
    where state in ('pending', 'retry_wait');
create index webhook_deliveries_lease_expiry_idx
    on webhook_deliveries(lease_expires_at, tenant_id, id)
    where state = 'delivering';
create index webhook_deliveries_endpoint_state_idx
    on webhook_deliveries(tenant_id, endpoint_id, state, created_at desc, id desc);
create index webhook_deliveries_tenant_created_at_id_idx
    on webhook_deliveries(tenant_id, created_at desc, id desc);

create table webhook_delivery_attempts (
    id uuid primary key,
    tenant_id uuid not null,
    delivery_id uuid not null,
    attempt_number integer not null,
    started_at timestamptz not null,
    finished_at timestamptz,
    latency_milliseconds integer,
    outcome text not null,
    http_status integer,
    error_code text,
    trace_id text,
    span_id text,
    created_at timestamptz not null default now(),
    constraint webhook_delivery_attempts_tenant_id_id_key unique (tenant_id, id),
    constraint webhook_delivery_attempts_delivery_fkey
        foreign key (tenant_id, delivery_id)
        references webhook_deliveries(tenant_id, id)
        on delete cascade,
    constraint webhook_delivery_attempts_number_key
        unique (tenant_id, delivery_id, attempt_number),
    constraint webhook_delivery_attempts_number_check
        check (attempt_number between 1 and 11),
    constraint webhook_delivery_attempts_outcome_check check (outcome in (
        'started', 'succeeded', 'retryable_failure', 'terminal_failure', 'lease_expired'
    )),
    constraint webhook_delivery_attempts_completion_check check (
        (
            outcome = 'started'
            and finished_at is null
            and latency_milliseconds is null
            and http_status is null
            and error_code is null
        )
        or
        (
            outcome <> 'started'
            and finished_at is not null
            and latency_milliseconds >= 0
        )
    ),
    constraint webhook_delivery_attempts_http_status_check
        check (http_status is null or http_status between 100 and 599),
    constraint webhook_delivery_attempts_error_code_check
        check (error_code is null or octet_length(error_code) between 1 and 96),
    constraint webhook_delivery_attempts_trace_id_check
        check (trace_id is null or trace_id ~ '^[0-9a-f]{32}$'),
    constraint webhook_delivery_attempts_span_id_check
        check (span_id is null or span_id ~ '^[0-9a-f]{16}$')
);

create index webhook_delivery_attempts_delivery_idx
    on webhook_delivery_attempts(tenant_id, delivery_id, attempt_number);

create table webhook_idempotency_records (
    tenant_id uuid not null references tenants(id) on delete cascade,
    operation text not null,
    idempotency_key text not null,
    request_sha256 bytea not null,
    response_status integer not null,
    response_ciphertext bytea,
    resource_id uuid,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, operation, idempotency_key),
    constraint webhook_idempotency_records_operation_check check (operation in (
        'endpoint.create',
        'endpoint.patch',
        'endpoint.delete',
        'endpoint.rotate_secret',
        'endpoint.test',
        'delivery.redeliver'
    )),
    constraint webhook_idempotency_records_key_check
        check (idempotency_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint webhook_idempotency_records_hash_check
        check (octet_length(request_sha256) = 32),
    constraint webhook_idempotency_records_status_check
        check (response_status between 200 and 299),
    constraint webhook_idempotency_records_expiry_check
        check (expires_at > created_at)
);

create index webhook_idempotency_records_expiry_idx
    on webhook_idempotency_records(expires_at, tenant_id);

create table provider_operation_receipts (
    operation_id text not null,
    effect text not null,
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    participant_id uuid,
    participant_generation bigint,
    publication_source text,
    recording_id uuid references recordings(id) on delete restrict,
    request_fingerprint bytea not null,
    request_payload jsonb not null,
    state text not null default 'prepared',
    outcome text,
    reason text,
    created_at timestamptz not null default now(),
    dispatching_at timestamptz,
    completed_at timestamptz,
    primary key (operation_id, effect),
    constraint provider_operation_receipts_operation_id_check check (
        operation_id ~ '^[A-Za-z0-9_-]{16,128}$'
    ),
    constraint provider_operation_receipts_effect_check check (effect in (
        'media.grant_publication', 'media.revoke_publication',
        'media.remove_participant', 'media.end_episode',
        'recording.start', 'recording.stop'
    )),
    constraint provider_operation_receipts_fingerprint_check check (octet_length(request_fingerprint) = 32),
    constraint provider_operation_receipts_payload_check check (octet_length(request_payload::text) <= 16384),
    constraint provider_operation_receipts_state_check check (state in ('prepared', 'dispatching', 'completed')),
    constraint provider_operation_receipts_outcome_check check (outcome is null or outcome in (
        'confirmed', 'satisfied', 'retryable_failure', 'terminal_failure', 'ambiguous'
    )),
    constraint provider_operation_receipts_reason_check check (reason is null or octet_length(reason) between 1 and 256),
    constraint provider_operation_receipts_participant_check check (
        (participant_id is not null or participant_generation is null)
        and (participant_generation is null or participant_generation > 0)
    ),
    constraint provider_operation_receipts_source_check check (
        publication_source is null or publication_source in ('microphone', 'camera', 'screen')
    ),
    constraint provider_operation_receipts_state_outcome_check check (
        (state in ('prepared', 'dispatching') and outcome is null and completed_at is null)
        or (state = 'completed' and outcome is not null and completed_at is not null)
    ),
    constraint provider_operation_receipts_dispatching_check check (
        (state = 'prepared' and dispatching_at is null)
        or (state in ('dispatching', 'completed') and dispatching_at is not null)
    ),
    constraint provider_operation_receipts_effect_fields_check check (
        (
            effect in ('media.grant_publication', 'media.revoke_publication')
            and participant_id is not null
            and publication_source is not null
            and recording_id is null
        )
        or (
            effect = 'media.remove_participant'
            and participant_id is not null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect = 'media.end_episode'
            and participant_id is null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect in ('recording.start', 'recording.stop')
            and participant_id is null
            and publication_source is null
            and recording_id is not null
        )
    )
);

create index provider_operation_receipts_episode_idx
    on provider_operation_receipts(tenant_id, episode_id, created_at desc, operation_id, effect);
create index provider_operation_receipts_reconciliation_idx
    on provider_operation_receipts(state, created_at, operation_id, effect)
    where state in ('prepared', 'dispatching');

create table provider_operation_observation_heads (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    incarnation bigint not null default 0,
    sequence bigint not null default 0,
    observation_fingerprint bytea not null default decode(repeat('00', 32), 'hex'),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, episode_id),
    constraint provider_operation_observation_heads_cursor_check check (
        incarnation >= 0 and sequence >= 0
    ),
    constraint provider_operation_observation_heads_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);

create table provider_operation_observations (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    incarnation bigint not null,
    sequence bigint not null,
    publications jsonb not null,
    observation_fingerprint bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, incarnation, sequence),
    constraint provider_operation_observations_cursor_check check (incarnation >= 0 and sequence >= 0),
    constraint provider_operation_observations_publications_check check (
        jsonb_typeof(publications) = 'array' and octet_length(publications::text) <= 16384
    ),
    constraint provider_operation_observations_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);

create index provider_operation_observations_episode_cursor_idx
    on provider_operation_observations(tenant_id, episode_id, incarnation, sequence);

-- The old wire vocabulary appears in schema-owned Sync payloads as well as
-- column names. Translate only those known contracts. Opaque product,
-- customer, provider, audit, and observability JSON is copied unchanged below.
-- +goose StatementBegin
create function __chalk_bridge_payload(value jsonb)
returns jsonb
language plpgsql
immutable
strict
as $$
declare
    key text;
    child jsonb;
    output jsonb := '{}'::jsonb;
    mapped_key text;
begin
    if jsonb_typeof(value) = 'object' then
        for key, child in select * from jsonb_each(value) loop
            mapped_key := case key
                when 'room_id' then 'space_id'
                when 'session_id' then 'episode_id'
                when 'participant_session_id' then 'participant_id'
                when 'actor_participant_session_id' then 'actor_participant_id'
                when 'target_participant_session_id' then 'target_participant_id'
                when 'granted_by_participant_session_id' then 'granted_by_participant_id'
                when 'started_by_participant_session_id' then 'started_by_participant_id'
                when 'host_participant_session_id' then 'host_participant_id'
                when 'participant_session_generation' then 'participant_generation'
                else key
            end;

            if mapped_key in ('intent_name', 'event_name', 'command_name', 'operation_name')
                and jsonb_typeof(child) = 'string' then
                child := to_jsonb(case child #>> '{}'
                    when 'session_ended' then 'episode_ended'
                    when 'end_session' then 'end_episode'
                    when 'transfer_host' then 'assign_roles'
                    when 'tenant_end_session' then 'tenant_end_episode'
                    when 'maximum_duration_expired' then 'maximum_episode_duration_expired'
                    when 'tenant_transfer_host' then 'tenant_assign_roles'
                    else child #>> '{}'
                end);
            elsif mapped_key in ('rejection_reason', 'terminal_reason')
                and jsonb_typeof(child) = 'string' then
                child := to_jsonb(case child #>> '{}'
                    when 'session_ended' then 'episode_ended'
                    when 'superseded_by_session_end' then 'superseded_by_episode_end'
                    when 'host_transfer_required' then 'role_assignment_required'
                    else child #>> '{}'
                end);
            elsif mapped_key in ('role', 'initial_role', 'new_role', 'old_role')
                and jsonb_typeof(child) = 'string' then
                child := to_jsonb(case child #>> '{}'
                    when 'host' then 'owner'
                    when 'cohost' then 'cohost'
                    when 'participant' then 'participant'
                    else child #>> '{}'
                end);
            elsif mapped_key in ('eligible_roles', 'roles')
                and jsonb_typeof(child) = 'array' then
                child := (
                    select coalesce(jsonb_agg(to_jsonb(case item #>> '{}'
                        when 'host' then 'owner'
                        when 'cohost' then 'cohost'
                        when 'participant' then 'participant'
                        else item #>> '{}'
                    end)), '[]'::jsonb)
                    from jsonb_array_elements(child) item
                );
            else
                child := __chalk_bridge_payload(child);
            end if;

            output := output || jsonb_build_object(mapped_key, child);
        end loop;
        return output;
    elsif jsonb_typeof(value) = 'array' then
        return (
            select coalesce(jsonb_agg(__chalk_bridge_payload(item)), '[]'::jsonb)
            from jsonb_array_elements(value) item
        );
    end if;
    return value;
end;
$$;
-- +goose StatementEnd

-- Legacy media roles used three names that have direct Episode equivalents.
-- The two role-capability names that represented the same permission are
-- deduplicated after translation because target capability arrays are sets.
-- +goose StatementBegin
create function __chalk_bridge_capabilities(value text[])
returns text[]
language sql
immutable
strict
as $$
    select coalesce(array_agg(distinct case capability
        when 'promoteDemote' then 'assignRoles'
        when 'transferHost' then 'assignRoles'
        when 'endMeeting' then 'endEpisode'
        else capability
    end order by case capability
        when 'promoteDemote' then 'assignRoles'
        when 'transferHost' then 'assignRoles'
        when 'endMeeting' then 'endEpisode'
        else capability
    end), '{}'::text[])
    from unnest(value) capability
$$;
-- +goose StatementEnd

-- Return the durable Space role policy represented by one legacy Session
-- policy. Host becomes owner. Cohost and participant stay distinct so the
-- bridge cannot union a more privileged bundle into an ordinary Participant.
-- +goose StatementBegin
create function __chalk_bridge_role_config(
    value jsonb,
    whiteboard_value jsonb default '{}'::jsonb,
    action_value jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
immutable
strict
as $$
declare
    role_name text;
    mapped_role text;
    capability_value jsonb;
    mapped_capabilities text[];
    existing_capabilities text[];
    output jsonb := '{}'::jsonb;
begin
    for role_name, capability_value in
        select entries.key, entries.value
        from jsonb_each(value) entries
        union all
        select entries.key, entries.value
        from jsonb_each(whiteboard_value) entries
        union all
        select entries.key, entries.value
        from jsonb_each(action_value) entries
    loop
        mapped_role := case role_name
            when 'host' then 'owner'
            when 'cohost' then 'cohost'
            when 'participant' then 'participant'
            else role_name
        end;
        mapped_capabilities := __chalk_bridge_capabilities(array(
            select jsonb_array_elements_text(capability_value)
        ));
        existing_capabilities := case
            when output ? mapped_role then array(
                select jsonb_array_elements_text(output -> mapped_role)
            )
            else '{}'::text[]
        end;
        output := output || jsonb_build_object(
            mapped_role,
            to_jsonb(__chalk_bridge_capabilities(existing_capabilities || mapped_capabilities))
        );
    end loop;
    if output = '{}'::jsonb then
        output := jsonb_build_object(
            'owner', to_jsonb(array['publishAudio', 'publishVideo', 'publishScreen', 'subscribe']::text[]),
            'cohost', to_jsonb(array['publishAudio', 'publishVideo', 'subscribe']::text[]),
            'participant', to_jsonb(array['publishAudio', 'publishVideo', 'subscribe']::text[])
        );
    end if;
    return output;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_bridge_role_name(value text)
returns text
language sql
immutable
strict
as $$
    select case value
        when 'host' then 'owner'
        when 'cohost' then 'cohost'
        when 'participant' then 'participant'
        else value
    end
$$;
-- +goose StatementEnd

-- A legacy Participant row may have no capability array because the Session
-- role policy was authoritative.  Use that Participant's own role bundle in
-- that case.  Non-empty arrays remain explicit per-Participant overrides.
-- +goose StatementBegin
create function __chalk_bridge_participant_capabilities(
    value text[],
    role_name text,
    role_config jsonb
)
returns text[]
language plpgsql
immutable
strict
as $$
declare
    mapped_role text;
    configured_capabilities jsonb;
begin
    if cardinality(value) > 0 then
        return __chalk_bridge_capabilities(value);
    end if;

    mapped_role := __chalk_bridge_role_name(role_name);
    configured_capabilities := role_config -> mapped_role;
    if jsonb_typeof(configured_capabilities) <> 'array'
        or jsonb_array_length(configured_capabilities) = 0 then
        raise exception 'Space/Episode bridge found an empty role policy for Participant role %', role_name;
    end if;

    return __chalk_bridge_capabilities(array(
        select jsonb_array_elements_text(configured_capabilities)
    ));
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_bridge_admission_policy(value text)
returns text
language sql
immutable
strict
as $$
    select case value
        when 'open' then 'open'
        when 'approval' then 'knock'
        when 'closed' then 'members_only'
        else null
    end
$$;
-- +goose StatementEnd

-- Build the exact Episode reducer snapshot. A recursive key rename is not
-- enough because the old reducer had extra authority fields and a different
-- admission-request shape.
-- +goose StatementBegin
create function __chalk_bridge_snapshot(value jsonb, role_config jsonb)
returns jsonb
language plpgsql
immutable
strict
as $$
declare
    participants jsonb;
    admission_requests jsonb;
begin
    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'participant_id', participant -> 'participant_session_id',
                'display_name', participant -> 'display_name',
                'hand_raised', participant -> 'hand_raised',
                'role', __chalk_bridge_role_name(participant ->> 'role'),
                'capabilities', role_config -> __chalk_bridge_role_name(participant ->> 'role'),
                'admission_revision', participant -> 'admission_revision'
            )
            order by participant ->> 'participant_session_id'
        ),
        '[]'::jsonb
    )
    into participants
    from jsonb_array_elements(value -> 'participants') participant;

    select coalesce(
        jsonb_agg(
            jsonb_build_object(
                'admission_request_id', request -> 'admission_request_id',
                'participant_id', request -> 'participant_session_id',
                'display_name', request -> 'display_name',
                'role', __chalk_bridge_role_name(request ->> 'initial_role'),
                'expires_at_ms', request -> 'expires_at_ms'
            )
            order by request ->> 'admission_request_id'
        ),
        '[]'::jsonb
    )
    into admission_requests
    from jsonb_array_elements(value -> 'admission_requests') request;

    return jsonb_build_object(
        'admission_policy', __chalk_bridge_admission_policy(value ->> 'admission_policy'),
        'admission_requests', admission_requests,
        'control_revision', value -> 'control_revision',
        'deadline_at_ms', value -> 'deadline_at_ms',
        'deadline_generation', value -> 'deadline_generation',
        'participants', participants,
        'recording', value -> 'recording',
        'role_capabilities', role_config,
        'state_schema_version', 1,
        'status', value -> 'status'
    );
end;
$$;
-- +goose StatementEnd

-- Canonical JSON mirrors ChalkSync.CanonicalJSON for the reducer's bounded
-- value set. Schema-owned object keys are sorted lexically before hashing.
-- +goose StatementBegin
create function __chalk_bridge_canonical_json(value jsonb)
returns text
language plpgsql
immutable
strict
as $$
declare
    encoded text;
begin
    case jsonb_typeof(value)
        when 'object' then
            select '{' || coalesce(
                string_agg(to_jsonb(entry.key)::text || ':' || __chalk_bridge_canonical_json(entry.value), ',' order by entry.key),
                ''
            ) || '}'
            into encoded
            from jsonb_each(value) entry;
            return encoded;
        when 'array' then
            select '[' || coalesce(
                string_agg(__chalk_bridge_canonical_json(entry.value), ',' order by entry.ordinality),
                ''
            ) || ']'
            into encoded
            from jsonb_array_elements(value) with ordinality entry(value, ordinality);
            return encoded;
        else
            return value::text;
    end case;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_bridge_state_digest(value jsonb)
returns bytea
language sql
immutable
strict
as $$
    select sha256(
        convert_to('chalk-sync-state-v1', 'UTF8')
        || int4send(1)
        || convert_to(__chalk_bridge_canonical_json(value), 'UTF8')
    )
$$;
-- +goose StatementEnd

insert into tenants (
    id, name, default_region, default_media_plane,
    media_plane_provider_config, ai_provider_config, storage_provider_config,
    logo_key, website, updated_at, created_at
)
select id, name, default_region, default_media_plane,
    null, null, null, logo_key, website, updated_at, created_at
from __chalk_legacy_tenants;

insert into users (id, name, email, updated_at, created_at)
select id, name, email, updated_at, created_at
from __chalk_legacy_users;

insert into memberships (id, tenant_id, user_id, role, updated_at, created_at)
select id, tenant_id, user_id, role, updated_at, created_at
from __chalk_legacy_memberships;

insert into auth_identities (
    id, user_id, provider, provider_subject, password_hash, updated_at, created_at
)
select id, user_id, provider, provider_subject, password_hash, updated_at, created_at
from __chalk_legacy_auth_identities;

insert into login_sessions (
    id, user_id, token_hash, user_agent, device_name, ip_address,
    expires_at, revoked_at, updated_at, created_at
)
select id, user_id, token_hash, user_agent, device_name, ip_address,
    expires_at, revoked_at, updated_at, created_at
from __chalk_legacy_login_sessions;

insert into api_keys (
    id, name, scopes, tenant_id, key_hash, key_prefix,
    created_by_user_id, last_used_ip, last_used_at, revoked_at,
    expires_at, updated_at, created_at
)
select id, name, scopes, tenant_id, key_hash, key_prefix,
    created_by_user_id, last_used_ip, last_used_at, revoked_at,
    expires_at, updated_at, created_at
from __chalk_legacy_api_keys;

insert into tenant_signing_keys (
    id, tenant_id, key_id, algorithm, public_key_jwk, last_used_at,
    created_by_api_key_id, created_by_user_id, revoked_at, expires_at,
    updated_at, created_at
)
select id, tenant_id, key_id, algorithm, public_key_jwk, last_used_at,
    created_by_api_key_id, created_by_user_id, revoked_at, expires_at,
    updated_at, created_at
from __chalk_legacy_tenant_signing_keys;

insert into spaces (
    id, name, tenant_id, slug, media_plane, metadata, recurring_policy,
    created_by_user_id, updated_at, created_at
)
select id, name, tenant_id, slug, media_plane,
    case when status <> 'active'
        then coalesce(metadata, '{}'::jsonb) || jsonb_build_object('legacy_status', status)
        else metadata
    end,
    recurring_policy, created_by_user_id, updated_at, created_at
from __chalk_legacy_rooms;

insert into space_roles (
    id, tenant_id, space_id, name, capabilities, updated_at, created_at
)
select md5(s.id::text || ':' || roles.role_name)::uuid,
    s.tenant_id, s.id, roles.role_name, roles.capabilities,
    s.updated_at, s.created_at
from spaces s
join lateral (
    select mapped.role_name,
        __chalk_bridge_capabilities(array_agg(mapped.capability order by mapped.capability)) as capabilities
    from (
        select case key
                when 'host' then 'owner'
                when 'cohost' then 'cohost'
                when 'participant' then 'participant'
                else key
            end as role_name,
            jsonb_array_elements_text(value) as capability
        from (
            select __chalk_bridge_role_config(
                rs.role_capabilities,
                rs.whiteboard_role_capabilities,
                rs.room_action_role_capabilities
            ) as role_capabilities
            from __chalk_legacy_room_sessions rs
            where rs.room_id = s.id
            order by rs.created_at desc, rs.id desc
            limit 1
        ) latest
        cross join lateral jsonb_each(latest.role_capabilities)
    ) mapped
    group by mapped.role_name
) roles on true
where roles.capabilities <> '{}'::text[];

-- The query above intentionally chooses one policy per Space.  Episodes keep
-- their own immutable policy snapshot, so historical policy changes remain
-- lossless even though Space roles are the current durable default.
insert into space_roles (
    id, tenant_id, space_id, name, capabilities, updated_at, created_at
)
select md5(s.id::text || ':' || defaults.name)::uuid,
    s.tenant_id, s.id, defaults.name, defaults.capabilities, s.updated_at, s.created_at
from spaces s
cross join (values
    ('owner', array['publishAudio', 'publishVideo', 'publishScreen', 'subscribe']::text[]),
    ('cohost', array['publishAudio', 'publishVideo', 'subscribe']::text[]),
    ('participant', array['publishAudio', 'publishVideo', 'subscribe']::text[])
) defaults(name, capabilities)
where not exists (
    select 1 from space_roles sr
    where sr.space_id = s.id and sr.name = defaults.name
);

insert into episodes (
    id, status, metadata, space_id, tenant_id, created_by_user_id,
    started_at, ended_at, config_snapshot, end_reason, deadline_at,
    deadline_generation, updated_at, created_at
)
select rs.id, rs.status, rs.metadata, rs.room_id, rs.tenant_id,
    rs.created_by_user_id, rs.started_at, rs.ended_at,
    jsonb_build_object(
            'roles', __chalk_bridge_role_config(
                rs.role_capabilities,
                rs.whiteboard_role_capabilities,
                rs.room_action_role_capabilities
            ),
        'admission_policy', jsonb_build_object(
            'mode', coalesce(
                (
                    select __chalk_bridge_admission_policy(control.folded_state ->> 'admission_policy')
                    from __chalk_legacy_sync_session_control control
                    where control.tenant_id = rs.tenant_id
                      and control.session_id = rs.id
                ),
                'open'
            )
        ),
        'host_exit_policy', rs.host_exit_policy,
        'default_episode_duration_seconds', greatest(60, least(rs.maximum_duration_seconds, 604800)),
        'maximum_episode_duration_seconds', greatest(60, least(rs.maximum_duration_ceiling_seconds, 604800)),
        'linger_window_seconds', 0
    ),
    case when rs.status <> 'ended' then null
        when exists (
            select 1 from __chalk_legacy_sync_external_operations op
            where op.tenant_id = rs.tenant_id
              and op.session_id = rs.id
              and op.operation_name = 'maximum_duration_expired'
        ) then 'deadline'
        else 'explicit'
    end,
    coalesce(rs.deadline_at, rs.created_at + interval '24 hours'),
    rs.deadline_generation, rs.updated_at, rs.created_at
from __chalk_legacy_room_sessions rs;

insert into episode_create_requests (
    tenant_id, space_id, request_key, request_fingerprint, episode_id, created_at
)
select tenant_id, room_id, request_key, request_fingerprint, session_id, created_at
from __chalk_legacy_session_create_requests;

insert into participants (
    id, name, metadata, capabilities, tenant_id, space_id, episode_id,
    identity_id, generation, status, role, joined_at, left_at,
    updated_at, created_at
)
select p.id, p.name,
    coalesce(p.metadata, '{}'::jsonb) || jsonb_build_object(
        'legacy_role', p.role,
        'legacy_eligible_roles', p.eligible_roles
    ),
    __chalk_bridge_participant_capabilities(
        p.capabilities,
        p.role,
        __chalk_bridge_role_config(
            session.role_capabilities,
            session.whiteboard_role_capabilities,
            session.room_action_role_capabilities
        )
    ), p.tenant_id, p.room_id, p.session_id,
    null,
    p.generation, p.status,
    __chalk_bridge_role_name(p.role),
    p.joined_at, p.left_at, p.updated_at, p.created_at
from __chalk_legacy_participants p
join __chalk_legacy_room_sessions session
  on session.tenant_id = p.tenant_id
 and session.room_id = p.room_id
 and session.id = p.session_id;

insert into sync_chat_streams (
    tenant_id, space_id, head_sequence, retained_floor_sequence,
    message_count, message_bytes, attachment_count, attachment_bytes,
    created_at, updated_at
)
select tenant_id, room_id, head_sequence, retained_floor_sequence,
    message_count, message_bytes, attachment_count, attachment_bytes,
    created_at, updated_at
from __chalk_legacy_sync_chat_streams;

insert into sync_chat_messages (
    tenant_id, space_id, episode_id, sequence, message_id,
    participant_id, participant_generation, client_message_id,
    request_fingerprint, display_name, message_text, encoded_bytes, created_at
)
select tenant_id, room_id, session_id, sequence, message_id,
    participant_session_id, participant_session_generation, client_message_id,
    request_fingerprint, display_name, message_text, encoded_bytes, created_at
from __chalk_legacy_sync_chat_messages;

insert into sync_chat_attachments (
    tenant_id, space_id, episode_id, attachment_id, participant_id,
    participant_generation, client_attachment_id, request_fingerprint,
    upload_id, object_key, original_filename, mime_type, byte_length, sha256,
    immutable_object_identity, status, expires_at, message_sequence,
    message_ordinal, finalize_claim_token, finalize_claimed_until,
    finalize_attempts, cleanup_claim_token, cleanup_claimed_until,
    cleanup_attempts, finalized_at, attached_at, updated_at, created_at
)
select tenant_id, room_id, session_id, attachment_id, participant_session_id,
    participant_session_generation, client_attachment_id, request_fingerprint,
    upload_id, object_key, original_filename, mime_type, byte_length, sha256,
    immutable_object_identity, status, expires_at, message_sequence,
    message_ordinal, finalize_claim_token, finalize_claimed_until,
    finalize_attempts, cleanup_claim_token, cleanup_claimed_until,
    cleanup_attempts, finalized_at, attached_at, updated_at, created_at
from __chalk_legacy_sync_chat_attachments;

insert into sync_chat_read_receipts (
    tenant_id, space_id, episode_id, participant_id, participant_generation,
    sequence, read_at, updated_at
)
select tenant_id, room_id, session_id, participant_session_id,
    participant_session_generation, sequence, read_at, updated_at
from __chalk_legacy_sync_chat_read_receipts;

insert into sync_whiteboard_scenes (
    tenant_id, space_id, scene_id, is_current, revision, app_state,
    element_count, encoded_bytes, created_at, updated_at
)
select tenant_id, room_id, scene_id, is_current, revision, app_state,
    element_count, encoded_bytes, created_at, updated_at
from __chalk_legacy_sync_whiteboard_scenes;

insert into sync_whiteboard_elements (
    tenant_id, space_id, episode_id, scene_id, element_id, element_type,
    version, version_nonce, element_index, is_deleted, payload, encoded_bytes,
    updated_at
)
select tenant_id, room_id, session_id, scene_id, element_id, element_type,
    version, version_nonce, element_index, is_deleted,
    payload, encoded_bytes, updated_at
from __chalk_legacy_sync_whiteboard_elements;

insert into sync_whiteboard_permissions (
    tenant_id, space_id, episode_id, participant_id, can_draw,
    granted_by_participant_id, updated_at
)
select tenant_id, room_id, session_id, participant_session_id, can_draw,
    granted_by_participant_session_id, updated_at
from __chalk_legacy_sync_whiteboard_permissions;

insert into sync_whiteboard_operation_receipts (
    tenant_id, space_id, episode_id, participant_id, submitted_generation,
    operation_id, request_fingerprint, operation_name, outcome, scene_id,
    revision, event_elements, event_encoded_bytes, completed_at
)
select tenant_id, room_id, session_id, participant_session_id,
    submitted_generation, operation_id, request_fingerprint, operation_name,
    outcome, scene_id, revision, event_elements,
    event_encoded_bytes, completed_at
from __chalk_legacy_sync_whiteboard_operation_receipts;

insert into sync_whiteboard_files (
    upload_id, tenant_id, space_id, episode_id, scene_id, participant_id,
    participant_generation, file_id, object_key, mime_type, byte_length,
    sha256, status, immutable_object_identity, expires_at, finalized_at,
    cleanup_claim_token, cleanup_claimed_until, cleanup_attempts,
    created_at, updated_at
)
select upload_id, tenant_id, room_id, session_id, scene_id,
    participant_session_id, participant_generation, file_id, object_key,
    mime_type, byte_length, sha256, status, immutable_object_identity,
    expires_at, finalized_at, cleanup_claim_token, cleanup_claimed_until,
    cleanup_attempts, created_at, updated_at
from __chalk_legacy_sync_whiteboard_files;

insert into sync_episode_control (
    tenant_id, space_id, episode_id, control_revision, folded_state,
    state_schema_version, state_digest, snapshot_bytes, snapshot_reserved_bytes,
    participant_event_count, participant_event_bytes, lifecycle_event_count,
    lifecycle_event_bytes, lifecycle_reserved_events, lifecycle_reserved_bytes,
    lifecycle_intent_count, lifecycle_intent_bytes, lifecycle_reserved_intents,
    lifecycle_reserved_intent_bytes, receipt_count, receipt_bytes,
    retention_checkpoint_revision, retention_checkpoint_state_digest,
    retention_checkpoint_event_count, retention_cleaned_at,
    retention_deleted_event_rows, retention_deleted_event_bytes,
    retention_deleted_receipt_rows, retention_deleted_receipt_bytes,
    retention_deleted_lifecycle_intent_rows,
    retention_deleted_lifecycle_intent_bytes,
    retention_deleted_external_operation_rows,
    retention_deleted_external_operation_bytes,
    retention_deleted_admission_request_rows,
    retention_deleted_admission_request_bytes,
    retention_deleted_recording_rows, retention_deleted_recording_bytes,
    retention_deleted_screen_share_lease_rows,
    retention_deleted_screen_share_lease_bytes,
    retention_deleted_publication_fence_rows,
    retention_deleted_publication_fence_bytes,
    retention_deleted_publication_grant_reservation_rows,
    retention_deleted_publication_grant_reservation_bytes,
    created_at, updated_at
)
with transformed as (
    select control.*,
        __chalk_bridge_snapshot(
            control.folded_state,
            __chalk_bridge_role_config(
                session.role_capabilities,
                session.whiteboard_role_capabilities,
                session.room_action_role_capabilities
            )
        ) as episode_snapshot
    from __chalk_legacy_sync_session_control control
    join __chalk_legacy_room_sessions session
      on session.tenant_id = control.tenant_id
     and session.id = control.session_id
), hashed as (
    select transformed.*,
        __chalk_bridge_state_digest(episode_snapshot) as episode_digest
    from transformed
)
select tenant_id, room_id, session_id, control_revision, episode_snapshot,
    1, episode_digest,
    octet_length(
        __chalk_bridge_canonical_json(
            episode_snapshot || jsonb_build_object('state_digest', encode(episode_digest, 'hex'))
        )
    ),
    snapshot_reserved_bytes,
    participant_event_count, participant_event_bytes, lifecycle_event_count,
    lifecycle_event_bytes, lifecycle_reserved_events, lifecycle_reserved_bytes,
    lifecycle_intent_count, lifecycle_intent_bytes, lifecycle_reserved_intents,
    lifecycle_reserved_intent_bytes, receipt_count, receipt_bytes,
    retention_checkpoint_revision, retention_checkpoint_state_digest,
    retention_checkpoint_event_count, retention_cleaned_at,
    retention_deleted_event_rows, retention_deleted_event_bytes,
    retention_deleted_receipt_rows, retention_deleted_receipt_bytes,
    retention_deleted_lifecycle_intent_rows,
    retention_deleted_lifecycle_intent_bytes,
    retention_deleted_external_operation_rows,
    retention_deleted_external_operation_bytes,
    retention_deleted_admission_request_rows,
    retention_deleted_admission_request_bytes,
    retention_deleted_recording_rows, retention_deleted_recording_bytes,
    retention_deleted_screen_share_lease_rows,
    retention_deleted_screen_share_lease_bytes,
    retention_deleted_publication_fence_rows,
    retention_deleted_publication_fence_bytes,
    retention_deleted_publication_grant_reservation_rows,
    retention_deleted_publication_grant_reservation_bytes,
    created_at, updated_at
from hashed;

-- External operations are staged before Events because the target Event
-- foreign key is immediate. Their terminal fields are restored after the
-- Event rows (which provide the applied-event proof) are present.
insert into sync_external_operations (
    tenant_id, space_id, episode_id, external_operation_id,
    parent_external_operation_id, request_key, request_fingerprint,
    operation_name, actor_participant_id, actor_generation,
    target_participant_id, target_participant_generation, source, recording_id,
    deadline_generation, journey_id, parent_journey_event_id,
    producing_trace_id, producing_span_id, payload, status, fence_active,
    attempt_count, next_attempt_at, last_error_code, applied_event_id,
    applied_revision, created_at, completed_at
)
select tenant_id, room_id, session_id, external_operation_id,
    null, request_key, request_fingerprint,
    case operation_name
        when 'end_session' then 'end_episode'
        when 'tenant_end_session' then 'tenant_end_episode'
        when 'tenant_transfer_host' then 'tenant_assign_roles'
        when 'maximum_duration_expired' then 'maximum_episode_duration_expired'
        else operation_name
    end,
    actor_participant_session_id, actor_generation,
    target_participant_session_id, target_participant_generation, source,
    recording_id, deadline_generation, journey_id, parent_journey_event_id,
    producing_trace_id, producing_span_id, __chalk_bridge_payload(payload),
    'pending', false, attempt_count, next_attempt_at, null,
    null, null, created_at, null
from __chalk_legacy_sync_external_operations;

insert into sync_lifecycle_intents (
    tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
    request_fingerprint, intent_name, participant_id, participant_generation,
    payload, status, terminal_reason, applied_event_id, applied_revision,
    attempt_count, last_error_code, next_attempt_at, created_at, completed_at
)
select tenant_id, room_id, session_id, lifecycle_intent_id, request_key,
    request_fingerprint,
    case intent_name when 'session_ended' then 'episode_ended' else intent_name end,
    participant_session_id, participant_session_generation,
    __chalk_bridge_payload(payload), 'pending', null,
    null, null, attempt_count, last_error_code,
    next_attempt_at, created_at, null
from __chalk_legacy_sync_lifecycle_intents;

insert into sync_control_events (
    tenant_id, space_id, episode_id, event_id, base_revision, revision,
    event_name, payload, actor_participant_id, actor_generation, command_id,
    lifecycle_intent_id, external_operation_id, event_schema_version,
    resulting_state_digest, encoded_bytes, created_at
)
select tenant_id, room_id, session_id, event_id, base_revision, revision,
    case event_name when 'session_ended' then 'episode_ended' else event_name end,
    __chalk_bridge_payload(payload), actor_participant_session_id,
    actor_generation, command_id, lifecycle_intent_id, external_operation_id,
    event_schema_version, resulting_state_digest, encoded_bytes, created_at
from __chalk_legacy_sync_control_events;

-- Legacy cursors are invalidated by the coordinated client release. The
-- terminal head still needs the rebuilt Episode digest so every new cursor
-- starts from one coherent authority point.
update sync_control_events event
set resulting_state_digest = control.state_digest
from sync_episode_control control
where event.tenant_id = control.tenant_id
  and event.episode_id = control.episode_id
  and event.revision = control.control_revision;

-- Event vocabulary and the terminal digest changed, so the stored wire size
-- must be rebuilt from the same map shape used by ChalkSync. External events
-- carry actor and operation fields; command and lifecycle events do not.
update sync_control_events event
set encoded_bytes = octet_length(
    __chalk_bridge_canonical_json(
        jsonb_build_object(
            'event_id', event.event_id,
            'base_revision', event.base_revision,
            'revision', event.revision,
            'name', event.event_name,
            'payload', event.payload,
            'command_id', event.command_id,
            'lifecycle_intent_id', event.lifecycle_intent_id,
            'schema_version', event.event_schema_version,
            'resulting_state_digest', encode(event.resulting_state_digest, 'hex')
        ) || case when event.external_operation_id is not null then
            jsonb_build_object(
                'external_operation_id', event.external_operation_id,
                'actor_participant_id', event.actor_participant_id,
                'actor_generation', event.actor_generation
            )
        else '{}'::jsonb end
    )
);

-- Replay and retention admission read these counters directly. Rebuild them
-- from the translated rows instead of carrying legacy byte totals forward.
update sync_episode_control control
set participant_event_count = totals.participant_count,
    participant_event_bytes = totals.participant_bytes,
    lifecycle_event_count = totals.lifecycle_count,
    lifecycle_event_bytes = totals.lifecycle_bytes
from (
    select current_control.tenant_id, current_control.episode_id,
        count(event.event_id) filter (where event.lifecycle_intent_id is null) as participant_count,
        coalesce(sum(event.encoded_bytes) filter (where event.lifecycle_intent_id is null), 0) as participant_bytes,
        count(event.event_id) filter (where event.lifecycle_intent_id is not null) as lifecycle_count,
        coalesce(sum(event.encoded_bytes) filter (where event.lifecycle_intent_id is not null), 0) as lifecycle_bytes
    from sync_episode_control current_control
    left join sync_control_events event
      on event.tenant_id = current_control.tenant_id
     and event.episode_id = current_control.episode_id
    group by current_control.tenant_id, current_control.episode_id
) totals
where control.tenant_id = totals.tenant_id
  and control.episode_id = totals.episode_id;

update sync_lifecycle_intents target
set status = source.status,
    terminal_reason = case source.terminal_reason
        when 'superseded_by_session_end' then 'superseded_by_episode_end'
        else source.terminal_reason
    end,
    applied_event_id = source.applied_event_id,
    applied_revision = source.applied_revision,
    completed_at = source.completed_at
from __chalk_legacy_sync_lifecycle_intents source
where target.lifecycle_intent_id = source.lifecycle_intent_id
  and source.status <> 'pending';

insert into sync_command_receipts (
    tenant_id, episode_id, participant_id, submitted_generation, command_id,
    request_fingerprint, command_name, outcome, rejection_reason, event_id,
    resulting_revision, resulting_state_digest, external_operation_id,
    completed_at, created_at
)
select r.tenant_id, r.session_id, r.participant_session_id,
    r.submitted_generation, r.command_id, r.request_fingerprint,
    case r.command_name
        when 'end_session' then 'end_episode'
        when 'transfer_host' then 'assign_roles'
        else r.command_name
    end,
    r.outcome,
    case r.rejection_reason
        when 'session_ended' then 'episode_ended'
        when 'host_transfer_required' then 'role_assignment_required'
        else r.rejection_reason
    end,
    r.event_id, r.resulting_revision,
    case when r.resulting_revision = control.control_revision then control.state_digest
        when r.resulting_state_digest is not null then r.resulting_state_digest
        when r.event_id is not null then e.resulting_state_digest
        else null
    end,
    r.external_operation_id,
    case when r.command_name in ('raise_hand', 'lower_hand') then null
        else coalesce(r.completed_at, r.created_at)
    end,
    r.created_at
from __chalk_legacy_sync_command_receipts r
left join __chalk_legacy_sync_control_events e
    on e.tenant_id = r.tenant_id
   and e.session_id = r.session_id
   and e.event_id = r.event_id
   and e.revision = r.resulting_revision
left join sync_episode_control control
    on control.tenant_id = r.tenant_id
   and control.episode_id = r.session_id;

update sync_external_operations target
set parent_external_operation_id = source.parent_external_operation_id,
    status = source.status,
    fence_active = source.fence_active,
    last_error_code = source.last_error_code,
    applied_event_id = source.applied_event_id,
    applied_revision = source.applied_revision,
    completed_at = source.completed_at
from __chalk_legacy_sync_external_operations source
where target.external_operation_id = source.external_operation_id;

insert into sync_admission_requests (
    tenant_id, space_id, episode_id, admission_request_id, request_key,
    request_fingerprint, participant_id, display_name, role, status,
    decision_external_operation_id, requested_at, expires_at, completed_at
)
select tenant_id, room_id, session_id, admission_request_id, request_key,
    request_fingerprint, participant_session_id, display_name,
    __chalk_bridge_role_name(initial_role),
    status, decision_external_operation_id, requested_at, expires_at,
    completed_at
from __chalk_legacy_sync_admission_requests;

insert into sync_screen_share_leases (
    tenant_id, space_id, episode_id, lease_id, owner_participant_id,
    owner_generation, lease_generation, status, acquired_at, renewed_until,
    hard_expires_at
)
select tenant_id, room_id, session_id, lease_id,
    owner_participant_session_id, owner_generation, lease_generation, status,
    acquired_at, renewed_until, hard_expires_at
from __chalk_legacy_sync_screen_share_leases;

insert into sync_publication_fences (
    tenant_id, space_id, episode_id, participant_id, participant_generation,
    source, external_operation_id, expires_at, created_at
)
select tenant_id, room_id, session_id, participant_session_id,
    participant_generation, source, external_operation_id, expires_at, created_at
from __chalk_legacy_sync_publication_fences;

insert into sync_publication_grant_reservations (
    tenant_id, space_id, episode_id, reservation_id, operation_id,
    participant_id, participant_generation, source, status, failure_code,
    expires_at, created_at, completed_at
)
select tenant_id, room_id, session_id, reservation_id, operation_id,
    participant_session_id, participant_generation, source, status,
    failure_code, expires_at, created_at, completed_at
from __chalk_legacy_sync_publication_grant_reservations;

insert into sync_recordings (
    tenant_id, space_id, episode_id, recording_id, status, generation,
    adapter_metadata, started_by_participant_id, started_by_generation,
    start_external_operation_id, stop_external_operation_id, failure_code,
    created_at, updated_at, completed_at
)
select tenant_id, room_id, session_id, recording_id, status, generation,
    adapter_metadata, started_by_participant_session_id,
    started_by_generation, start_external_operation_id, stop_external_operation_id,
    failure_code, created_at, updated_at, completed_at
from __chalk_legacy_sync_recordings;

insert into recordings (
    id, tenant_id, space_id, episode_id, status, storage_provider,
    storage_key, metadata, updated_at, created_at
)
select id, tenant_id, room_id, session_id, status, storage_provider,
    storage_key, metadata, updated_at, created_at
from __chalk_legacy_recordings;

insert into transcriptions (
    id, tenant_id, recording_id, space_id, episode_id, status, provider, model,
    languages, metadata, completed_at, updated_at, created_at
)
select id, tenant_id, recording_id, room_id, session_id,
    case status
        when 'pending' then 'preparing'
        when 'processing' then 'transcribing'
        when 'completed' then 'complete'
        when 'failed' then 'terminal_failure'
        else status
    end,
    provider, model, languages, metadata,
    completed_at, updated_at, created_at
from __chalk_legacy_transcriptions;

insert into recording_transcription_sources (
    recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size,
    manifest_content_type, schema_version, committed_at
)
select recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size,
    manifest_content_type, schema_version, committed_at
from __chalk_legacy_recording_transcription_sources;

insert into recording_transcription_source_chunks (
    id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key,
    checksum, size, content_type
)
select id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key,
    checksum, size, content_type
from __chalk_legacy_recording_transcription_source_chunks;

insert into artifact_jobs (
    id, idempotency_key, tenant_id, episode_id, recording_id, transcript_id,
    chunk_id, artifact_kind, payload_schema_version, state, priority,
    available_at, attempt_count, attempt_limit, lease_token_hash, lease_owner,
    lease_expires_at, error_code, error_detail, journey_id, traceparent,
    tracestate, terminal_at, updated_at, created_at
)
select id, idempotency_key, tenant_id, session_id, recording_id, transcript_id,
    chunk_id, artifact_kind, payload_schema_version,
    case state when 'retryable_failure' then 'retryable'
        when 'terminal_failure' then 'dead_letter'
        else state
    end,
    priority, available_at, attempt_count, attempt_limit, lease_token_hash,
    lease_owner, lease_expires_at, error_code, error_detail, journey_id,
    traceparent, tracestate, terminal_at, updated_at, created_at
from __chalk_legacy_artifact_jobs;

insert into transcript_chunks (
    id, transcript_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key,
    result_key, checksum, size, content_type, created_at
)
select id, transcript_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key,
    result_key, checksum, size, content_type, created_at
from __chalk_legacy_transcript_chunks;

insert into transcription_attempts (
    id, transcript_id, chunk_id, generation, attempt, provider, model,
    provider_version, execution_identity, provider_request_id,
    measured_audio_ms, provider_observed_duration_ms, state,
    billed_audio_seconds, error_code, error_detail, journey_id, traceparent,
    tracestate, quality, started_at, finished_at, created_at
)
select id, transcript_id, chunk_id, generation, attempt, provider, model,
    provider_version, execution_identity, provider_request_id,
    measured_audio_ms, provider_observed_duration_ms, state,
    billed_audio_seconds, error_code, error_detail, journey_id, traceparent,
    tracestate, quality, started_at, finished_at,
    created_at
from __chalk_legacy_transcription_attempts;

insert into transcription_chunk_results (
    id, chunk_id, generation, attempt_id, provider, model, provider_version,
    result_key, result_sha256, result_size, result_content_type, language,
    billed_audio_seconds, quality, accepted_at
)
select id, chunk_id, generation, attempt_id, provider, model, provider_version,
    result_key, result_sha256, result_size, result_content_type, language,
    billed_audio_seconds, quality, accepted_at
from __chalk_legacy_transcription_chunk_results;

insert into transcription_cleanup_jobs (
    id, tenant_id, transcript_id, object_key, object_kind, due_at, state,
    attempt_count, attempt_limit, lease_token_hash, lease_owner,
    lease_expires_at, error_code, error_detail, verified_at,
    provider_copy_status, updated_at, created_at
)
select id, tenant_id, transcript_id, object_key, object_kind, due_at, state,
    attempt_count, attempt_limit, lease_token_hash, lease_owner,
    lease_expires_at, error_code, error_detail, verified_at,
    provider_copy_status, updated_at, created_at
from __chalk_legacy_transcription_cleanup_jobs;

insert into recording_capacity (
    id, reserved_episodes, reserved_participants, reserved_input_bitrate_bps,
    updated_at
)
select id, reserved_meetings, reserved_participants, reserved_input_bitrate_bps,
    updated_at
from __chalk_legacy_recording_capacity;

insert into recording_pool_health (
    role, admission_open, ready_capacity, reason, observed_at, updated_at
)
select role, admission_open, ready_capacity, reason, observed_at, updated_at
from __chalk_legacy_recording_pool_health;

insert into recording_reservations (
    id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
    request_fingerprint, participant_count, max_duration_seconds,
    input_bitrate_bps, state, starts_at, ends_at, updated_at, created_at
)
select id, tenant_id, room_id, session_id, recording_id, idempotency_key,
    request_fingerprint, participant_count, max_duration_seconds,
    input_bitrate_bps, state, starts_at, ends_at, updated_at, created_at
from __chalk_legacy_recording_reservations;

insert into recording_pipelines (
    recording_id, tenant_id, reservation_id, state, capture_completed_at,
    committed_at, updated_at, created_at
)
select recording_id, tenant_id, reservation_id, state, capture_completed_at,
    committed_at, updated_at, created_at
from __chalk_legacy_recording_pipelines;

insert into recording_jobs (
    id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at,
    fencing_generation, error_code, error_detail, terminal_at,
    updated_at, created_at
)
select id, tenant_id, session_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at,
    fencing_generation, error_code, error_detail, terminal_at,
    updated_at, created_at
from __chalk_legacy_recording_jobs;

insert into recording_bundles (
    id, tenant_id, recording_id, capture_job_id, sequence_number,
    fencing_generation, object_key, content_type, codec, layer, byte_size,
    checksum, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, created_at
)
select id, tenant_id, recording_id, capture_job_id, sequence_number,
    fencing_generation, object_key, content_type, codec, layer, byte_size,
    checksum, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, created_at
from __chalk_legacy_recording_bundles;

insert into recording_artifacts (
    recording_id, tenant_id, render_job_id, object_key, content_type,
    byte_size, checksum, duration_millis, committed_at, created_at
)
select recording_id, tenant_id, render_job_id, object_key, content_type,
    byte_size, checksum, duration_millis, committed_at, created_at
from __chalk_legacy_recording_artifacts;

insert into audit_logs (
    id, tenant_id, actor_user_id, actor_type, action, resource_type,
    resource_id, details, outcome, error_code, error_message, before, after,
    external_request_id, updated_at, created_at
)
select id, tenant_id, actor_user_id, actor_type, action, resource_type,
    resource_id, details, outcome, error_code,
    error_message, before, after,
    external_request_id, updated_at, created_at
from __chalk_legacy_audit_logs;

insert into integration_connections (
    id, tenant_id, user_id, provider, service, external_account_ref,
    external_auth_config_ref, status, account_label, account_email, scopes,
    metadata, connected_at, expires_at, last_used_at, revoked_at,
    updated_at, created_at
)
select id, tenant_id, user_id, provider, service, external_account_ref,
    external_auth_config_ref, status, account_label, account_email, scopes,
    metadata, connected_at, expires_at, last_used_at,
    revoked_at, updated_at, created_at
from __chalk_legacy_integration_connections;

insert into observability_journey_events (
    event_id, journey_id, sequence, occurred_at, received_at, name, phase,
    state, origin_kind, first_observed_layer, upstream_visibility,
    parent_event_id, trace_id, span_id, attributes
)
select event_id, journey_id, sequence, occurred_at, received_at, name, phase,
    state, origin_kind, first_observed_layer, upstream_visibility,
    parent_event_id, trace_id, span_id, attributes
from __chalk_legacy_observability_journey_events;

insert into webhook_tenant_state (tenant_id, updated_at)
select tenant_id, updated_at
from __chalk_legacy_webhook_tenant_state;

insert into webhook_endpoints (
    id, tenant_id, name, enabled, revision, current_target_revision,
    current_secret_ciphertext, previous_secret_ciphertext,
    previous_secret_expires_at, created_by_user_id, deleted_at, updated_at,
    created_at
)
select id, tenant_id, name, enabled, revision, current_target_revision,
    current_secret_ciphertext, previous_secret_ciphertext,
    previous_secret_expires_at, created_by_user_id, deleted_at, updated_at,
    created_at
from __chalk_legacy_webhook_endpoints;

insert into webhook_endpoint_revisions (
    id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted,
    url_destroyed_at, api_version, event_types, created_at
)
select id, tenant_id, endpoint_id, revision, url_ciphertext, url_redacted,
    url_destroyed_at, api_version, event_types, created_at
from __chalk_legacy_webhook_endpoint_revisions;

insert into webhook_events (
    id, tenant_id, event_name, api_version, occurred_at, body, body_sha256,
    semantic_transition_key, resource_type, resource_id, linked_user_id,
    journey_id, parent_journey_event_id, producing_trace_id,
    producing_span_id, erased_at, created_at
)
select id, tenant_id, event_name, api_version, occurred_at, body, body_sha256,
    semantic_transition_key, resource_type, resource_id, linked_user_id,
    journey_id, parent_journey_event_id, producing_trace_id,
    producing_span_id, erased_at, created_at
from __chalk_legacy_webhook_events;

insert into webhook_deliveries (
    id, tenant_id, event_id, endpoint_id, endpoint_revision_id,
    endpoint_revision, state, next_attempt_at, attempt_count, lease_token,
    lease_owner, lease_expires_at, terminal_at, queued_journey_event_id,
    terminal_journey_event_id, parent_delivery_id, created_at, updated_at
)
select id, tenant_id, event_id, endpoint_id, endpoint_revision_id,
    endpoint_revision, state, next_attempt_at, attempt_count, lease_token,
    lease_owner, lease_expires_at, terminal_at, queued_journey_event_id,
    terminal_journey_event_id, parent_delivery_id, created_at, updated_at
from __chalk_legacy_webhook_deliveries;

insert into webhook_delivery_attempts (
    id, tenant_id, delivery_id, attempt_number, started_at, finished_at,
    latency_milliseconds, outcome, http_status, error_code, trace_id,
    span_id, created_at
)
select id, tenant_id, delivery_id, attempt_number, started_at, finished_at,
    latency_milliseconds, outcome, http_status, error_code, trace_id,
    span_id, created_at
from __chalk_legacy_webhook_delivery_attempts;

insert into webhook_idempotency_records (
    tenant_id, operation, idempotency_key, request_sha256, response_status,
    response_ciphertext, resource_id, expires_at, created_at
)
select tenant_id, operation, idempotency_key, request_sha256, response_status,
    response_ciphertext, resource_id, expires_at, created_at
from __chalk_legacy_webhook_idempotency_records;

insert into provider_operation_receipts (
    operation_id, effect, tenant_id, episode_id, participant_id,
    participant_generation, publication_source, recording_id,
    request_fingerprint, request_payload, state, outcome, reason, created_at,
    dispatching_at, completed_at
)
select operation_id,
    case effect when 'media.end_session' then 'media.end_episode' else effect end,
    tenant_id, session_id, participant_session_id, participant_session_generation,
    publication_source, recording_id, request_fingerprint,
    __chalk_bridge_payload(request_payload), state, outcome, reason, created_at,
    dispatching_at, completed_at
from __chalk_legacy_provider_operation_receipts;

insert into provider_operation_observation_heads (
    tenant_id, episode_id, incarnation, sequence, observation_fingerprint,
    updated_at
)
select tenant_id, session_id, incarnation, sequence, observation_fingerprint,
    updated_at
from __chalk_legacy_provider_operation_observation_heads;

insert into provider_operation_observations (
    tenant_id, episode_id, incarnation, sequence, publications,
    observation_fingerprint, created_at
)
select tenant_id, session_id, incarnation, sequence,
    publications, observation_fingerprint, created_at
from __chalk_legacy_provider_operation_observations;

-- Row-count parity is the final guard against a silent omission.  Every
-- legacy relation that has a target counterpart is checked before the source
-- graph is removed; transformed core relations are checked separately by
-- their one-to-one Room/Session IDs.
-- +goose StatementBegin
do $$
declare
    pair record;
    source_count bigint;
    target_count bigint;
begin
    for pair in select * from (values
        ('tenants', 'tenants'), ('users', 'users'), ('memberships', 'memberships'),
        ('auth_identities', 'auth_identities'), ('login_sessions', 'login_sessions'),
        ('api_keys', 'api_keys'), ('tenant_signing_keys', 'tenant_signing_keys'),
        ('rooms', 'spaces'), ('room_sessions', 'episodes'), ('participants', 'participants'),
        ('session_create_requests', 'episode_create_requests'),
        ('sync_session_control', 'sync_episode_control'),
        ('sync_lifecycle_intents', 'sync_lifecycle_intents'),
        ('sync_control_events', 'sync_control_events'),
        ('sync_command_receipts', 'sync_command_receipts'),
        ('sync_external_operations', 'sync_external_operations'),
        ('sync_admission_requests', 'sync_admission_requests'),
        ('sync_screen_share_leases', 'sync_screen_share_leases'),
        ('sync_publication_fences', 'sync_publication_fences'),
        ('sync_publication_grant_reservations', 'sync_publication_grant_reservations'),
        ('sync_recordings', 'sync_recordings'),
        ('sync_whiteboard_scenes', 'sync_whiteboard_scenes'),
        ('sync_whiteboard_elements', 'sync_whiteboard_elements'),
        ('sync_whiteboard_permissions', 'sync_whiteboard_permissions'),
        ('sync_whiteboard_operation_receipts', 'sync_whiteboard_operation_receipts'),
        ('sync_whiteboard_files', 'sync_whiteboard_files'),
        ('sync_chat_streams', 'sync_chat_streams'),
        ('sync_chat_messages', 'sync_chat_messages'),
        ('sync_chat_attachments', 'sync_chat_attachments'),
        ('sync_chat_read_receipts', 'sync_chat_read_receipts'),
        ('recordings', 'recordings'), ('transcriptions', 'transcriptions'),
        ('recording_transcription_sources', 'recording_transcription_sources'),
        ('recording_transcription_source_chunks', 'recording_transcription_source_chunks'),
        ('artifact_jobs', 'artifact_jobs'), ('transcript_chunks', 'transcript_chunks'),
        ('transcription_attempts', 'transcription_attempts'),
        ('transcription_chunk_results', 'transcription_chunk_results'),
        ('transcription_cleanup_jobs', 'transcription_cleanup_jobs'),
        ('recording_capacity', 'recording_capacity'), ('recording_pool_health', 'recording_pool_health'),
        ('recording_reservations', 'recording_reservations'),
        ('recording_pipelines', 'recording_pipelines'), ('recording_jobs', 'recording_jobs'),
        ('recording_bundles', 'recording_bundles'), ('recording_artifacts', 'recording_artifacts'),
        ('audit_logs', 'audit_logs'), ('integration_connections', 'integration_connections'),
        ('observability_journey_events', 'observability_journey_events'),
        ('webhook_tenant_state', 'webhook_tenant_state'), ('webhook_endpoints', 'webhook_endpoints'),
        ('webhook_endpoint_revisions', 'webhook_endpoint_revisions'), ('webhook_events', 'webhook_events'),
        ('webhook_deliveries', 'webhook_deliveries'), ('webhook_delivery_attempts', 'webhook_delivery_attempts'),
        ('webhook_idempotency_records', 'webhook_idempotency_records'),
        ('provider_operation_receipts', 'provider_operation_receipts'),
        ('provider_operation_observation_heads', 'provider_operation_observation_heads'),
        ('provider_operation_observations', 'provider_operation_observations')
    ) as mappings(source_name, target_name) loop
        execute format('select count(*) from %I', '__chalk_legacy_' || pair.source_name)
            into source_count;
        execute format('select count(*) from %I', pair.target_name)
            into target_count;
        if source_count <> target_count then
            raise exception 'Space/Episode bridge row-count mismatch for %: legacy %, target %',
                pair.source_name, source_count, target_count;
        end if;
    end loop;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
do $$
declare
    table_name text;
    legacy_table_names constant text[] := array[
        'tenants', 'users', 'memberships', 'auth_identities', 'login_sessions',
        'api_keys', 'tenant_signing_keys', 'rooms', 'room_sessions',
        'participants', 'sync_session_control', 'sync_lifecycle_intents',
        'sync_control_events', 'sync_command_receipts', 'session_create_requests',
        'sync_external_operations', 'sync_admission_requests',
        'sync_screen_share_leases', 'sync_publication_fences',
        'sync_publication_grant_reservations', 'sync_recordings',
        'recordings', 'transcriptions', 'audit_logs', 'integration_connections',
        'observability_journey_events', 'webhook_tenant_state', 'webhook_endpoints',
        'webhook_endpoint_revisions', 'webhook_events', 'webhook_deliveries',
        'webhook_delivery_attempts', 'webhook_idempotency_records',
        'recording_transcription_sources', 'recording_transcription_source_chunks',
        'artifact_jobs', 'transcript_chunks', 'transcription_attempts',
        'transcription_chunk_results', 'transcription_cleanup_jobs',
        'recording_capacity', 'recording_pool_health', 'recording_reservations',
        'recording_pipelines', 'recording_jobs', 'recording_bundles',
        'recording_artifacts', 'provider_operation_receipts',
        'provider_operation_observation_heads', 'provider_operation_observations',
        'sync_whiteboard_scenes', 'sync_whiteboard_elements',
        'sync_whiteboard_permissions', 'sync_whiteboard_operation_receipts',
        'sync_whiteboard_files', 'sync_chat_streams', 'sync_chat_messages',
        'sync_chat_attachments', 'sync_chat_read_receipts'
    ];
begin
    foreach table_name in array legacy_table_names loop
        execute format('drop table if exists %I cascade', '__chalk_legacy_' || table_name);
    end loop;
    drop function __chalk_bridge_payload(jsonb);
    drop function __chalk_bridge_capabilities(text[]);
    drop function __chalk_bridge_role_config(jsonb, jsonb, jsonb);
    drop function __chalk_bridge_snapshot(jsonb, jsonb);
    drop function __chalk_bridge_state_digest(jsonb);
    drop function __chalk_bridge_canonical_json(jsonb);
    drop function __chalk_bridge_participant_capabilities(text[], text, jsonb);
    drop function __chalk_bridge_role_name(text);
    drop function __chalk_bridge_admission_policy(text);
    drop function if exists __chalk_legacy_reject_recording_object_mutation();
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- The bridge has no lossless rollback: restoring the old table graph would
-- require reconstructing legacy policy columns and JSON payload vocabulary.
-- +goose StatementBegin
do $$
begin
    raise exception 'Space/Episode bridge is irreversible; restore from a backup instead of running Down';
end;
$$;
-- +goose StatementEnd
