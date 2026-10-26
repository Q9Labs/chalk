-- Schema snapshot through migration 20261023190003.
create table tenants (
    recording_render_mode text not null default 'on_demand' check (recording_render_mode in ('on_demand', 'automatic')),
    id uuid primary key,
    name text not null,
    default_region text,
    -- cf_sfu
    default_media_plane text,
    -- {
    --   "enabled": true,
    --   "provider": "cf_sfu",
    --   "mode": "chalk_managed" | "tenant_managed",
    --   "cloudflare": {
    --     "account_id": "cloudflare-account-id",
    --     "sfu": {
    --       "enabled": true,
    --       "app_id": "realtime-app-id",
    --       "app_secret": string
    --     }
    --   }
    -- }
    media_plane_provider_config jsonb,
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
    cors_allowed_origins text[] not null default '{}',
    constraint tenants_cors_allowed_origins_count_check
        check (cardinality(cors_allowed_origins) <= 32),
    logo_key text,
    website text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);

create index tenants_created_at_id_idx on tenants(created_at desc, id desc);

create table tenant_artifact_policies (
    tenant_id uuid primary key references tenants(id) on delete cascade,
    transcription_ceiling text not null default 'automatic',
    transcription_default_mode text not null default 'automatic',
    provider_policy_version text not null default 'chalk-automatic-v1',
    recording_retention_seconds bigint not null default 2592000,
    transcript_retention_seconds bigint not null default 0,
    source_window_seconds bigint not null default 86400,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint tenant_artifact_policies_ceiling_check
        check (transcription_ceiling in ('disabled', 'on_demand', 'automatic')),
    constraint tenant_artifact_policies_default_check
        check (transcription_default_mode in ('disabled', 'on_demand', 'automatic')),
    constraint tenant_artifact_policies_default_ceiling_check
        check (
            (transcription_ceiling = 'disabled' and transcription_default_mode = 'disabled')
            or (transcription_ceiling = 'on_demand' and transcription_default_mode in ('disabled', 'on_demand'))
            or (transcription_ceiling = 'automatic')
        ),
    constraint tenant_artifact_policies_recording_retention_check
        check (recording_retention_seconds between 0 and 9223372036),
    constraint tenant_artifact_policies_transcript_retention_check
        check (transcript_retention_seconds between 0 and 9223372036),
    constraint tenant_artifact_policies_source_window_check
        check (
            (transcription_ceiling = 'disabled' and source_window_seconds = 0)
            or (transcription_ceiling in ('on_demand', 'automatic') and source_window_seconds between 1 and 2592000)
        ),
    constraint tenant_artifact_policies_provider_policy_check
        check (transcription_ceiling = 'disabled' or btrim(provider_policy_version) <> '')
);

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
    -- owner, collaborator, observer
    role text not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique(tenant_id, user_id)
);
create index memberships_tenant_created_at_id_idx on memberships(tenant_id, created_at desc, id desc);
create index memberships_user_id_idx on memberships(user_id);

create table tenant_onboarding_requests (
    account_id uuid not null references users(id),
    request_key text not null,
    request_fingerprint bytea not null,
    tenant_id uuid not null references tenants(id) deferrable initially deferred,
    tenant_access_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (account_id, request_key),
    unique (tenant_id),
    unique (tenant_access_id),
    constraint tenant_onboarding_requests_key_check
        check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint tenant_onboarding_requests_fingerprint_check
        check (octet_length(request_fingerprint) = 32)
);
create index tenant_onboarding_requests_created_at_idx
    on tenant_onboarding_requests(created_at desc);

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

create table password_resets (
    account_id uuid primary key references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index password_resets_expires_at_idx on password_resets(expires_at);

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

-- API-key mutation reservations contain no secret material. They make retries
-- deterministic while preserving one-time secret display semantics.
create table api_key_mutation_requests (
    tenant_id uuid not null references tenants(id),
    operation text not null check (operation in ('create', 'rotate')),
    request_key text not null,
    request_fingerprint bytea not null,
    api_key_id uuid references api_keys(id),
    created_at timestamptz not null default now(),
    primary key (tenant_id, operation, request_key)
);

create index api_key_mutation_requests_resource_idx
    on api_key_mutation_requests (tenant_id, api_key_id)
    where api_key_id is not null;

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
    -- cf_sfu
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
    recording_policy text not null default 'automatic'
        check (recording_policy in ('disabled', 'manual', 'automatic')),
    transcription_policy text not null default 'automatic'
        check (transcription_policy in ('disabled', 'on_demand', 'automatic')),
    default_episode_duration_seconds integer not null default 86400,
    maximum_episode_duration_seconds integer not null default 86400,
    linger_window_seconds integer not null default 0,
    created_by_user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    archived_at timestamptz,
    unique (tenant_id, slug),
    unique (tenant_id, id),
    check (default_episode_duration_seconds between 60 and 604800),
    check (maximum_episode_duration_seconds between 60 and 604800),
    check (default_episode_duration_seconds <= maximum_episode_duration_seconds),
    check (linger_window_seconds >= 0)
);
create index spaces_tenant_created_at_id_idx on spaces(tenant_id, created_at desc, id desc);
create index spaces_tenant_archived_created_at_id_idx on spaces(tenant_id, archived_at, created_at desc, id desc);

create table space_create_requests (
    tenant_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    space_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, request_key),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete no action
        deferrable initially deferred,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32)
);
create index space_create_requests_space_idx on space_create_requests(tenant_id, space_id);

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
        and (
            not (value ? 'artifact_policy')
            or (
                jsonb_typeof(value -> 'artifact_policy') = 'object'
                and value -> 'artifact_policy' ->> 'schema_version' = 'episode_config.v2'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording') = 'object'
                and value -> 'artifact_policy' -> 'recording' ->> 'mode' in ('disabled', 'manual', 'automatic')
                and value -> 'artifact_policy' -> 'recording' ->> 'profile' = 'composite_720p_v1'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription') = 'object'
                and value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('disabled', 'on_demand', 'automatic')
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'transcription' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and (
                    (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' = 'disabled'
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint = 0
                    )
                    or (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('on_demand', 'automatic')
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 2592000
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;

-- A zero recording retention was valid before deferred Export but did not
-- govern rendered MP4 lifetime. Keep those immutable legacy snapshots intact
-- while giving their newly deferred source and MP4 a capture-anchored 30-day
-- operational window. Explicit positive snapshot values remain exact.
create function recording_deferred_retention_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select coalesce(
        nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0),
        2592000
    );
$$;

-- Transcription uses its immutable source window, never extending beyond the
-- recording source window that also fences deferred Export.
create function recording_transcription_source_window_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select least(
        recording_deferred_retention_seconds(config_snapshot),
        coalesce((config_snapshot -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint, 0)
    );
$$;

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
    account_id uuid references users(id) on delete restrict,
    identity_id uuid,
    media_connection_id text,
    media_connection_generation bigint,
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
create index participants_admission_cleanup_active_idx
    on participants(tenant_id, episode_id, id)
    where status = 'active';
create unique index participants_dashboard_account_episode_idx
    on participants(tenant_id, episode_id, account_id)
    where account_id is not null and status in ('joining', 'active');
create index participants_dashboard_account_space_idx
    on participants(tenant_id, space_id, account_id, created_at desc)
    where account_id is not null;
-- Chat limits apply to a person: the account, else the identity, else that one row.
create index participants_chat_person_idx
    on participants(tenant_id, space_id, (coalesce(account_id, identity_id, id)));
create function chat_person_participant_ids(p_tenant_id uuid, p_space_id uuid, p_participant_id uuid)
returns table (participant_id uuid)
language sql
stable
as $$
    select sibling.id
    from participants sender
    join participants sibling
        on sibling.tenant_id = sender.tenant_id
        and sibling.space_id = sender.space_id
        and coalesce(sibling.account_id, sibling.identity_id, sibling.id)
            = coalesce(sender.account_id, sender.identity_id, sender.id)
    where sender.tenant_id = p_tenant_id
        and sender.space_id = p_space_id
        and sender.id = p_participant_id
$$;

create table participant_media_refreshes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null check (participant_generation > 0),
    request_hash bytea not null check (octet_length(request_hash) = 32),
    connection_id text not null,
    response_ciphertext bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id, participant_id, participant_generation, request_hash),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade
);

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
create index sync_chat_messages_episode_sequence_idx
    on sync_chat_messages(tenant_id, space_id, episode_id, sequence);
create index sync_chat_messages_participant_usage_idx
    on sync_chat_messages(tenant_id, space_id, participant_id) include (created_at, encoded_bytes);

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
    episode_id uuid not null,
    scene_id uuid not null,
    is_current boolean not null default true,
    presenting_episode_id uuid,
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
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
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
    on sync_whiteboard_scenes(tenant_id, space_id, episode_id)
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

create function space_public_invite_code(handle bytea) returns text
language sql immutable strict parallel safe
as $$
    select string_agg(chr(97 + get_byte(digest, i) % 26), '' order by i)
    from (select sha256('chalk/public-invite/code/v1'::bytea || handle) as digest) hashed,
         generate_series(0, 9) as i
$$;

create function space_public_invite_words(handle bytea) returns text
language sql immutable strict parallel safe
as $$
    select string_agg(words[1 + ((get_byte(digest, (i * 10) / 8)::bigint * 65536
        + get_byte(digest, (i * 10) / 8 + 1) * 256
        + get_byte(digest, (i * 10) / 8 + 2)) >> (14 - (i * 10) % 8) & 1023)], '-' order by i)
    from (select sha256('chalk/public-invite/words/v1'::bytea || handle) as digest,
        array['abacus','able','accent','acorn','acoustic','acre','acrobat','active','actor','adore','aerial','agenda','agent','agile','ahead','aim','airport','album','alike','alive','almond','aloe','aloha','alone','alpaca','alto','alumni','amber','amend','ample','amuse','anchor','angle','animal','anthem','antique','anvil','apple','april','apron','aqua','arcade','arctic','area','arena','arise','aroma','array','art','artist','aspire','astute','atlas','atom','attach','attain','attic','audio','autumn','avenue','avocado','awake','award','awning','bacon','badge','bagel','baked','baker','bakery','bamboo','banana','banjo','banner','barge','barn','basil','basket','batch','baton','beacon','beetle','blank','blanket','blaze','blend','blink','blog','blossom','bluebird','boat','bobcat','bolt','bonsai','bonus','book','booth','boots','boss','botany','both','bottle','boulder','bounce','bowler','branch','breeze','brick','bright','brim','bring','brisk','broil','bronze','brook','broom','brush','bubble','bucket','budget','buffalo','builder','bulb','bulk','bunch','bundle','bunny','busy','butter','button','buzz','cabana','cable','cactus','cake','calm','cameo','camera','camper','campus','canal','canary','candle','candy','canopy','canyon','cape','captain','carbon','card','cargo','carrot','carry','cartoon','case','castle','catalog','cedar','celery','chair','charm','cheer','cheese','chef','cherry','chess','chief','chill','chip','chunk','churn','cinema','circle','circus','citrus','city','civic','civil','claim','clamp','clap','clasp','class','clay','clean','clear','clever','click','cling','clip','cloak','clock','clone','closet','cloth','cloud','clover','clump','coach','coast','coat','cobalt','cocoa','coconut','coffee','coil','cola','cold','colony','comfy','comic','compass','concert','condor','cone','cookie','cope','copper','copy','coral','cork','corner','cosmic','cost','cotton','couch','cover','craft','crane','crate','crave','crawl','crayon','create','cricket','crisp','crop','crowd','crown','crumb','crust','crystal','cub','cube','cupcake','curl','curry','cursor','curve','cut','cycle','daffodil','daily','daisy','dance','dash','date','dawn','deal','debug','decaf','deck','decor','delta','deluxe','denim','depth','desk','device','dial','diary','dice','dig','dime','diner','dinner','disco','dish','dock','doing','doll','dolphin','domain','dome','donut','dot','down','dragon','dragonfly','drama','draw','drawing','dress','dried','drift','drill','drive','drizzle','drove','drum','dry','duck','duke','duo','dusk','dust','duty','eagle','early','earth','easel','east','echo','eclipse','edge','editor','eel','effort','elder','elf','elk','elm','email','ember','emblem','emboss','emerald','encore','energy','engine','enrich','enter','entry','equal','equator','eraser','errand','even','evolve','exact','exit','expert','fable','fabric','fact','factory','falcon','fall','fame','family','fancy','feast','feather','feed','fence','fern','ferry','fetch','fiber','fiddle','figure','film','filter','final','finale','finch','firefly','fit','five','flag','flame','flap','flick','flight','flip','float','flock','flower','foam','fog','foil','folk','font','food','forest','fossil','found','fountain','fox','frame','fresh','fridge','friend','from','front','frost','fruit','gala','galaxy','game','gap','garage','garden','garlic','gave','gazebo','gear','gecko','gem','gerbil','giant','gift','gig','ginger','giraffe','glacier','glad','glass','glide','glitter','glory','gloss','glove','glow','glue','goal','going','golden','golf','good','gown','grab','grain','granite','grant','grape','graph','grasp','grass','gravy','green','greet','grew','grid','grill','grip','groom','groove','guide','guitar','gulf','gummy','gush','habit','half','hamster','happy','harvest','hatch','haven','hazel','hazy','heap','heat','hedge','helium','helmet','help','heron','hickory','holiday','honey','horizon','hub','hula','hull','human','humid','hurry','hut','ice','iceberg','icing','icon','igloo','image','insect','iron','island','item','ivory','ivy','jacket','jaguar','jam','jasmine','jazz','jelly','jersey','jet','jigsaw','job','jog','jolly','jolt','journal','joy','judge','juice','juicy','july','jumbo','jump','jungle','keep','kettle','kilt','king','kite','kitten','kiwi','koala','ladder','lady','lagoon','lake','lamp','land','lantern','laptop','large','latch','laurel','lavender','leaflet','legend','lemon','length','lens','leopard','letter','lettuce','level','lever','library','lid','life','lift','lilac','lily','limit','line','linen','lint','lion','liquid','list','little','lively','lizard','lobster','locket','lotus','luggage','lumber','lunar','lunch','lyric','magnet','maker','mango','manor','many','map','maple','marble','marine','market','mascot','mash','match','math','meadow','melon','mercury','meteor','mitten','mocha','monkey','mop','mosaic','motor','motto','mount','mouse','move','movie','mud','muffin','mug','mural','muse','museum','mushroom','music','nacho','nail','name','nap','napkin','nature','neat','nectar','neon','nest','net','next','nickel','noodle','nugget','nutmeg','nylon','oak','oasis','oat','oatmeal','ocean','octagon','octopus','oil','olive','onion','opal','open','opera','orchid','origami','otter','outdoor','outer','oval','oven','owl','oxygen','oyster','ozone','pace','packet','pager','palace','palm','panda','panther','pantry','pants','papaya','paper','parade','parcel','park','parrot','parsley','party','pasta','pastel','patch','path','patio','pebble','pecan','pelican','pencil','penguin','penny','pepper','perch','petal','photo','picnic','pigeon','pillow','plank','plant','plaza','plenty','pluck','plug','plus','pod','poem','poet','point','polar','polka','polo','pond','pony','poppy','portal','poster','pouch','pound','power','press','print','prism','prize','proof','pug','pull','pulp','pulse','puma','pupil','puppet','puppy','purse','push','puzzle','quiet','quilt','quota','quote','race','rack','radar','radio','radish','raft','rail','rake','rally','ramp','ranch','range','ranger','rank','raven','reach','react','recap','relax','relay','relic','remix','repay','reply','rerun','reset','rhyme','ribbon','rice','rich','ride','rinse','ripple','rise','river','robe','robin','rock','rocket','rope','rover','royal','ruby','rug','rule','rush','safari','sage','salad','salon','salsa','salt','sample','sandy','satin','say','scale','scan','scarf','scoop','scoot','scope','score','scout','scrap','screen','script','scrub','scuba','scuff','sedan','send','serve','seven','shack','shade','shaky','shape','shed','sheep','shelf','shell','shine','shiny','ship','shirt','shop','shore','sift','silk','silly','silver','simple','single','sip','size','skate','sketch','skid','skip','skirt','sky','slab','slack','slate','sled','sleek','sleep','slice','slick','sling','slip','slush','small','smile','snack','snap','snowy','speak','speed','spend','spent','spill','spiny','spoke','sponge','spool','spoon','sport','spot','spout','spray','spring','sprint','sprout','spruce','spur','squad','squid','stack','staff','stage','stall','stamp','stand','staple','start','state','statue','steam','steep','stem','step','stereo','stew','stick','sting','stir','stock','stool','stop','storm','stove','straw','stream','street','strut','stuck','studio','stuff','stump','stunt','subway','sugar','surf','sushi','swan','sway','sweep','swell','swim','swing','swipe','swirl','swoop','syrup','tablet','taco','tag','take','tall','task','taste','tasty','thaw','theme','think','thread','thumb','tiara','tidal','tidy','tiger','tile','tilt','tint','tiny','trace','track','trade','train','travel','tray','treat','tree','trek','trend','trial','trick','trio','trophy','trout','truck','trunk','try','tug','tulip','turf','turtle','tutor','tweak','tweet','twice','twins','twirl','twist','uncle','undo','unify','unit','untie','update','upper','urban','user','valley','value','velvet','venue','verify','verse','vest','video','view','violet','vista','vocal','voice','volt','vowel','voyage','wafer','wagon','wake','walk','walnut','wand','watch','water','wavy','wheat','whoop','widen','width','willow','wing','wink','wipe','wise','wish','wizard','wok','wolf','wool','word','work','woven','yam','yard','year','yelp','yield','yoga','yogurt','yummy','zebra','zero','zesty','zippy','zone','zoom' ] as words) hashed,
        generate_series(0, 3) as i
$$;

create table space_public_invites (
    tenant_id uuid not null,
    space_id uuid not null,
    handle bytea not null,
    invite_code text not null generated always as (space_public_invite_code(handle)) stored,
    invite_words text not null generated always as (space_public_invite_words(handle)) stored,
    generation bigint not null default 1,
    state_epoch bigint not null default 1,
    enabled boolean not null default true,
    public_role text not null default 'collaborator',
    admission_mode text not null default 'open',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    rotated_at timestamptz,
    disabled_at timestamptz,
    last_actor_id uuid references users(id),
    last_rotation_request_key text,
    primary key (tenant_id, space_id),
    unique (handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    check (octet_length(handle) = 32),
    check (generation > 0),
    check (state_epoch > 0),
    check (public_role = 'collaborator'),
    check (admission_mode in ('open', 'knock', 'members_only')),
    check (last_rotation_request_key is null or octet_length(last_rotation_request_key) between 16 and 128)
);
create index space_public_invites_handle_idx on space_public_invites(handle);
create unique index space_public_invites_invite_code_idx on space_public_invites(invite_code);
create unique index space_public_invites_invite_words_idx on space_public_invites(invite_words);

create table space_public_arrivals (
    arrival_handle uuid primary key,
    tenant_id uuid not null,
    space_id uuid not null,
    invite_handle bytea not null,
    invite_generation bigint not null,
    invite_state_epoch bigint not null,
    identity_mode text not null check (identity_mode in ('account', 'guest')),
    display_name text not null,
    guest_credential_hash bytea,
    account_id uuid references users(id),
    credential_family text,
    idempotency_key text not null,
    idempotency_fingerprint bytea not null,
    state text not null check (state in ('pending', 'admitted', 'rejected', 'left', 'unavailable')),
    episode_id uuid,
    participant_id uuid,
    participant_generation bigint,
    provider text,
    provider_subject text,
    expires_at timestamptz not null,
    terminal_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    terminal_at timestamptz,
    unique (tenant_id, space_id, idempotency_key),
    unique (tenant_id, space_id, arrival_handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id)
        references space_public_invites(tenant_id, space_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (octet_length(invite_handle) = 32),
    check (invite_generation > 0 and invite_state_epoch > 0),
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (octet_length(idempotency_fingerprint) = 32),
    check (guest_credential_hash is null or octet_length(guest_credential_hash) = 32),
    check (identity_mode = 'guest' or (account_id is not null and guest_credential_hash is null)),
    check (identity_mode = 'account' or (account_id is null and guest_credential_hash is not null)),
    check (participant_generation is null or participant_generation > 0),
    check ((provider is null) = (provider_subject is null)),
    check (provider is null or octet_length(provider) between 1 and 128),
    check (provider_subject is null or octet_length(provider_subject) between 1 and 256),
    check (
        (state in ('pending', 'rejected', 'unavailable')
         and episode_id is null and participant_id is null and participant_generation is null
         and provider is null and provider_subject is null)
        or
        (state in ('admitted', 'left')
         and episode_id is not null and participant_id is not null and participant_generation is not null
         and provider is not null and provider_subject is not null)
    )
);
create index space_public_arrivals_expiry_idx on space_public_arrivals(expires_at, state);
create index space_public_arrivals_space_state_idx on space_public_arrivals(tenant_id, space_id, state, created_at);

create function bind_public_arrival_media_connection() returns trigger
language plpgsql as $$
begin
    if new.state = 'admitted' and new.provider_subject is not null and
       (TG_OP = 'INSERT' or old.state is distinct from new.state or
        old.provider_subject is distinct from new.provider_subject or
        old.participant_generation is distinct from new.participant_generation or
        old.participant_id is distinct from new.participant_id) then
        update participants set media_connection_id = new.provider_subject,
            media_connection_generation = new.participant_generation
        where tenant_id = new.tenant_id and episode_id = new.episode_id
          and id = new.participant_id and generation = new.participant_generation;
    end if;
    return new;
end;
$$;
create trigger public_arrival_media_connection
    after insert or update of state, provider_subject, participant_generation, participant_id
    on space_public_arrivals for each row execute function bind_public_arrival_media_connection();

create table space_public_admission_requests (
    request_handle uuid primary key,
    arrival_handle uuid not null,
    tenant_id uuid not null,
    space_id uuid not null,
    display_name text not null,
    state text not null check (state in ('pending', 'approved', 'denied', 'expired', 'invalidated')),
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    decided_at timestamptz,
    decided_by uuid references users(id),
    decision_request_key text,
    unique (tenant_id, space_id, request_handle),
    unique (arrival_handle),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, arrival_handle)
        references space_public_arrivals(tenant_id, space_id, arrival_handle)
        on delete cascade,
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (decision_request_key is null or octet_length(decision_request_key) between 16 and 128)
);
create index space_public_admission_requests_pending_idx
    on space_public_admission_requests(tenant_id, space_id, requested_at)
    where state = 'pending';

create table auto_space_lifecycles (
    tenant_id uuid not null,
    space_id uuid not null,
    deadline_at timestamptz not null,
    creator_arrival_handle uuid,
    state text not null check (state in ('active', 'archiving', 'archived')),
    claim_expires_at timestamptz,
    next_retry_at timestamptz,
    retry_count integer not null default 0,
    last_error_family text,
    archive_completed_at timestamptz,
    journey_id uuid,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, creator_arrival_handle)
        references space_public_arrivals(tenant_id, space_id, arrival_handle)
        on delete restrict,
    check (retry_count >= 0),
    check (last_error_family is null or octet_length(last_error_family) between 1 and 64),
    check ((state = 'archiving') = (claim_expires_at is not null)),
    check (state <> 'archived' or archive_completed_at is not null)
);
create index auto_space_lifecycles_due_idx
    on auto_space_lifecycles(deadline_at, next_retry_at, claim_expires_at)
    where state <> 'archived';

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

create table sync_whiteboard_draw_policies (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    updated_by_participant_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, updated_by_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create table sync_whiteboard_draw_policy_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    operation_id text not null check (octet_length(operation_id) between 16 and 64),
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    completed_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id, operation_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create index sync_whiteboard_draw_policy_receipts_episode
    on sync_whiteboard_draw_policy_receipts (tenant_id, space_id, episode_id);

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
    event_presenting boolean,
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
    check (operation_name in ('submit_update', 'clear', 'set_draw_permission', 'set_presentation')),
    check (outcome = 'committed'),
    check (revision >= 0),
    check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_presenting is null
            and event_encoded_bytes between 2 and 16777216
        )
        or (
            operation_name = 'set_presentation'
            and event_elements is null
            and event_presenting is not null
            and event_encoded_bytes = 0
        )
        or (
            operation_name not in ('submit_update', 'set_presentation')
            and event_elements is null
            and event_presenting is null
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
    constraint sync_lifecycle_intents_sync_v3_generation_fkey
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
        'start_episode',
        'extend_episode',
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
    constraint sync_command_receipts_shape_check check (
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
                'start_episode',
                'extend_episode',
                'end_episode'
            )
            and (
                (
                    outcome = 'committed'
                    and command_name <> 'start_episode'
                    and (command_name <> 'extend_episode' or external_operation_id is null)
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                    and octet_length(resulting_state_digest) = 32
                    and completed_at is not null
                )
                or (
                    outcome = 'satisfied'
                    and command_name <> 'extend_episode'
                    and rejection_reason is null
                    and event_id is null
                    and resulting_revision >= 0
                    and octet_length(resulting_state_digest) = 32
                    and external_operation_id is null
                    and completed_at is not null
                )
                or (
                    outcome = 'pending'
                    and command_name not in ('start_episode', 'extend_episode')
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
                    and command_name <> 'start_episode'
                    and (command_name <> 'extend_episode' or external_operation_id is null)
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
                        'recording_policy_disabled',
                        'external_operation_failed'
                    )
                    and (
                        rejection_reason <> 'recording_policy_disabled'
                        or command_name = 'start_recording'
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
    producing_traceparent text,
    producing_tracestate text,
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
        'recording_capture_ready', 'recording_capture_stopped', 'recording_capture_failed',
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
    check (
        producing_traceparent is null
        or producing_traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$'
    ),
    check (
        producing_tracestate is null
        or octet_length(producing_tracestate) between 1 and 512
    ),
    check (producing_traceparent is not null or producing_tracestate is null),
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

create index sync_admission_requests_admitted_participant_idx
    on sync_admission_requests(tenant_id, episode_id, participant_id)
    where status = 'admitted';

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

create table sync_media_pauses (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    publication_id text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete cascade,
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (octet_length(publication_id) between 1 and 256)
);

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
    storage_content_type text,
    storage_size bigint check (storage_size is null or storage_size >= 0),
    storage_checksum bytea check (storage_checksum is null or octet_length(storage_checksum) between 16 and 128),
    duration_millis bigint check (duration_millis is null or duration_millis >= 0),
    completed_at timestamptz,
    metadata jsonb,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index recordings_tenant_created_at_id_idx on recordings(tenant_id, created_at desc, id desc);
create index recordings_tenant_episode_created_at_id_idx on recordings(tenant_id, episode_id, created_at desc, id desc);
create index recordings_tenant_space_created_at_id_idx on recordings(tenant_id, space_id, created_at desc, id desc);

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
    reserved_participants integer not null default 0 constraint recording_capacity_reserved_participants_check1 check (reserved_participants between 0 and 200),
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
    policy_snapshot_version text not null check (policy_snapshot_version = 'episode_config.v2'),
    participant_count integer not null check (participant_count between 1 and 10),
    max_duration_seconds integer not null constraint recording_reservations_max_duration_seconds_check1 check (max_duration_seconds between 1 and 14400),
    input_bitrate_bps bigint not null check (input_bitrate_bps between 1 and 4000000),
    state text not null check (state in ('reserved', 'released', 'expired')),
    starts_at timestamptz,
    ends_at timestamptz not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, idempotency_key)
);
create unique index recording_reservations_recording_id_idx
    on recording_reservations(recording_id);
create index recording_reservations_active_idx
    on recording_reservations(state, starts_at, ends_at)
    where state = 'reserved';
create index recording_reservations_tenant_created_idx
    on recording_reservations(tenant_id, created_at desc, id desc);

create table recording_pipelines (
    recording_id uuid primary key references recordings(id),
    tenant_id uuid not null references tenants(id),
    reservation_id uuid not null unique references recording_reservations(id),
    capture_epoch bigint not null default 0 check (capture_epoch >= 0),
    state text not null check (state in (
        'requested', 'reserved', 'capture_leased', 'capturing_segmented',
        'capture_complete', 'render_queued', 'rendering', 'verifying',
        'committed', 'retryable_failure', 'terminal_failure', 'deleted'
    )),
    stop_operation_id uuid,
    stop_requested_at timestamptz,
    capture_completed_at timestamptz,
    committed_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    constraint recording_pipelines_stop_pair_check check ((stop_operation_id is null) = (stop_requested_at is null))
);
create index recording_pipelines_tenant_state_idx
    on recording_pipelines(tenant_id, state, updated_at desc);
create unique index recording_pipelines_stop_operation_id_idx
    on recording_pipelines(stop_operation_id)
    where stop_operation_id is not null;

create table recording_jobs (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    episode_id uuid not null references episodes(id),
    recording_id uuid not null references recordings(id),
    kind text not null check (kind in ('capture', 'transcription', 'render')),
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
    result_metadata jsonb not null default '{}'::jsonb,
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
create index recording_jobs_active_lease_owner_idx
    on recording_jobs(lease_owner) where state = 'leased';
create index recording_jobs_dead_letter_idx
    on recording_jobs(tenant_id, terminal_at desc, id)
    where state = 'terminal_failure';
create unique index recording_jobs_recording_kind_idx
    on recording_jobs(recording_id, kind);

create table recording_job_failure_history (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    manual_retry_count integer not null check (manual_retry_count between 1 and 5),
    attempt_count integer not null check (attempt_count >= 0),
    fencing_generation bigint not null check (fencing_generation >= 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    retried_at timestamptz not null default now(),
    primary key (job_id, manual_retry_count)
);

create table recording_job_attempt_authorities (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    claim_request_id uuid not null unique,
    kind text not null check (kind in ('capture', 'transcription', 'render')),
    lease_owner text not null check (octet_length(lease_owner) between 1 and 256),
    lease_token text not null check (octet_length(lease_token) between 1 and 256),
    lease_expires_at timestamptz not null,
    envelope_bytes bytea not null check (octet_length(envelope_bytes) between 1 and 65536),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    issued_at timestamptz not null default now(),
    primary key (job_id, attempt_count, fencing_generation)
);
create index recording_job_attempt_authorities_job_idx
    on recording_job_attempt_authorities(job_id, issued_at desc);

create function reject_recording_job_attempt_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording job attempt authorities are append-only';
end;
$$;

create trigger recording_job_attempt_authorities_immutable
before update or delete on recording_job_attempt_authorities
for each row execute function reject_recording_job_attempt_authority_mutation();

create trigger recording_job_attempt_authorities_no_truncate
before truncate on recording_job_attempt_authorities
for each statement execute function reject_recording_job_attempt_authority_mutation();

create table recording_capture_plans (
    plan_handle uuid not null,
    revision bigint not null check (revision > 0),
    job_id uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    episode_control_revision bigint not null check (episode_control_revision >= 0),
    provider_incarnation bigint not null check (provider_incarnation >= 0),
    provider_sequence bigint not null check (provider_sequence >= 0),
    plan_schema_version text not null check (plan_schema_version = 'capture_plan.v1'),
    plan_bytes bytea not null check (octet_length(plan_bytes) between 1 and 262144),
    plan_fingerprint bytea not null check (octet_length(plan_fingerprint) = 32),
    effective_deadline_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (plan_handle, revision),
    unique (plan_handle, plan_fingerprint),
    foreign key (job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
        on delete restrict
);
create index recording_capture_plans_attempt_idx
    on recording_capture_plans(job_id, attempt_count, fencing_generation, revision desc);

create table recording_capture_retired_publications (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    publication_id text not null check (octet_length(publication_id) between 1 and 512),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, publication_id)
);

create function reject_recording_capture_plan_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture plans are append-only';
end;
$$;

create trigger recording_capture_plans_immutable
before update or delete on recording_capture_plans
for each row execute function reject_recording_capture_plan_mutation();

create trigger recording_capture_plans_no_truncate
before truncate on recording_capture_plans
for each statement execute function reject_recording_capture_plan_mutation();

alter table recording_job_attempt_authorities
    add constraint recording_job_attempt_authorities_capture_epoch_key
        unique (job_id, attempt_count, fencing_generation, capture_epoch);

create table recording_capture_connections (
    signaling_handle uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    provider_connection_reference text check (
        provider_connection_reference is null
        or octet_length(provider_connection_reference) between 1 and 512
    ),
    state text not null default 'pending'
        check (state in ('pending', 'connecting', 'connected', 'disconnected', 'closed')),
    latest_plan_revision bigint not null default 0 check (latest_plan_revision >= 0),
    negotiation_id text check (
        negotiation_id is null or octet_length(negotiation_id) between 1 and 512
    ),
    negotiation_requirement text not null default 'not_required'
        check (negotiation_requirement in ('not_required', 'answer_needed', 'offer_needed')),
    negotiation_plan_revision bigint check (
        negotiation_plan_revision is null or negotiation_plan_revision > 0
    ),
    next_sequence bigint not null default 1 check (next_sequence > 0),
    active_command_id bigint,
    active_execution_token uuid,
    active_execution_expires_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (signaling_handle, capture_epoch),
    foreign key (job_id, attempt_count, fencing_generation, capture_epoch)
        references recording_job_attempt_authorities (
            job_id, attempt_count, fencing_generation, capture_epoch
        ) on delete restrict,
    constraint recording_capture_connections_negotiation_check check (
        (
            negotiation_requirement = 'not_required'
            and negotiation_id is null
            and negotiation_plan_revision is null
        ) or (
            negotiation_requirement in ('answer_needed', 'offer_needed')
            and negotiation_id is not null
            and negotiation_plan_revision is not null
        )
    ),
    constraint recording_capture_connections_active_execution_check check (
        (
            active_command_id is null
            and active_execution_token is null
            and active_execution_expires_at is null
        ) or (
            active_command_id is not null
            and active_execution_token is not null
            and active_execution_expires_at is not null
        )
    )
);
create unique index recording_capture_connections_recording_epoch_idx
    on recording_capture_connections(recording_id, capture_epoch);

create table recording_capture_commands (
    id bigint generated always as identity primary key,
    signaling_handle uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    sequence bigint not null check (sequence > 0),
    recording_id uuid not null references recordings(id) on delete restrict,
    plan_revision bigint not null check (plan_revision > 0),
    operation_kind text not null check (operation_kind in (
        'create_capture_connection',
        'pull_capture_tracks',
        'renegotiate_capture_connection',
        'inspect_capture_connection',
        'close_capture_tracks',
        'close_capture_connection'
    )),
    idempotency_key text not null check (octet_length(idempotency_key) between 1 and 128),
    request_bytes bytea not null check (octet_length(request_bytes) between 1 and 2097152),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    state text not null default 'queued'
        check (state in ('queued', 'leased', 'completed', 'retryable', 'terminal', 'ambiguous')),
    execution_attempt integer not null default 0 check (execution_attempt >= 0),
    execution_token uuid,
    execution_expires_at timestamptz,
    not_before timestamptz not null default now(),
    result_bytes bytea check (result_bytes is null or octet_length(result_bytes) between 1 and 2097152),
    result_fingerprint bytea check (result_fingerprint is null or octet_length(result_fingerprint) = 32),
    provider_failure_class text check (
        provider_failure_class is null or provider_failure_class in (
            'unavailable', 'rate_limited', 'unauthorized', 'not_found', 'protocol'
        )
    ),
    provider_failure_code text check (
        provider_failure_code is null or octet_length(provider_failure_code) between 1 and 128
    ),
    provider_failure_retryable boolean,
    created_at timestamptz not null default now(),
    leased_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    foreign key (signaling_handle, capture_epoch)
        references recording_capture_connections(signaling_handle, capture_epoch) on delete restrict,
    constraint recording_capture_commands_sequence_key
        unique (signaling_handle, capture_epoch, sequence),
    constraint recording_capture_commands_idempotency_key
        unique (
            signaling_handle, capture_epoch, plan_revision,
            operation_kind, idempotency_key
        ),
    constraint recording_capture_commands_execution_check check (
        (
            state = 'leased'
            and execution_token is not null
            and execution_expires_at is not null
        ) or (
            state <> 'leased'
            and execution_token is null
            and execution_expires_at is null
        )
    ),
    constraint recording_capture_commands_result_check check (
        (
            state = 'completed'
            and result_bytes is not null
            and result_fingerprint is not null
        ) or (
            state <> 'completed'
            and result_bytes is null
            and result_fingerprint is null
        )
    ),
    constraint recording_capture_commands_failure_check check (
        (
            state in ('retryable', 'terminal')
            and provider_failure_class is not null
            and provider_failure_retryable is not null
        ) or (
            state not in ('retryable', 'terminal')
            and provider_failure_class is null
            and provider_failure_code is null
            and provider_failure_retryable is null
        )
    )
);
create index recording_capture_commands_ready_idx
    on recording_capture_commands(signaling_handle, capture_epoch, sequence, not_before)
    where state in ('queued', 'retryable', 'leased');

alter table recording_capture_connections
    add constraint recording_capture_connections_active_command_fkey
        foreign key (active_command_id) references recording_capture_commands(id) on delete restrict;

create table recording_capture_provider_rate_budget (
    id smallint primary key check (id = 1),
    next_call_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
insert into recording_capture_provider_rate_budget (id) values (1);

create function protect_recording_capture_connection_authority() returns trigger
language plpgsql as $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.tenant_id is distinct from new.tenant_id
        or old.space_id is distinct from new.space_id
        or old.episode_id is distinct from new.episode_id
        or old.recording_id is distinct from new.recording_id
        or old.job_id is distinct from new.job_id
        or old.attempt_count is distinct from new.attempt_count
        or old.fencing_generation is distinct from new.fencing_generation
        or old.envelope_digest is distinct from new.envelope_digest then
        raise exception 'recording capture connection authority is immutable';
    end if;
    new.updated_at = now();
    return new;
end;
$$;

create function protect_recording_capture_command() returns trigger
language plpgsql as $$
begin
    if old.signaling_handle is distinct from new.signaling_handle
        or old.capture_epoch is distinct from new.capture_epoch
        or old.sequence is distinct from new.sequence
        or old.recording_id is distinct from new.recording_id
        or old.plan_revision is distinct from new.plan_revision
        or old.operation_kind is distinct from new.operation_kind
        or old.idempotency_key is distinct from new.idempotency_key
        or old.request_bytes is distinct from new.request_bytes
        or old.request_fingerprint is distinct from new.request_fingerprint
        or old.created_at is distinct from new.created_at then
        raise exception 'recording capture command authority is immutable';
    end if;
    if old.state in ('completed', 'terminal', 'ambiguous') then
        raise exception 'terminal recording capture command is immutable';
    end if;
    if not (
        (old.state = 'queued' and new.state = 'leased')
        or (old.state = 'retryable' and new.state = 'leased')
        or (old.state = 'leased' and new.state = 'queued')
        or (old.state = 'leased' and new.state in ('completed', 'retryable', 'terminal', 'ambiguous'))
    ) then
        raise exception 'invalid recording capture command transition from % to %', old.state, new.state;
    end if;
    new.updated_at = now();
    return new;
end;
$$;

create function reject_recording_capture_queue_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture signaling authority cannot be deleted or truncated';
end;
$$;

create trigger recording_capture_connections_authority_immutable
before update on recording_capture_connections
for each row execute function protect_recording_capture_connection_authority();

create trigger recording_capture_connections_no_delete
before delete on recording_capture_connections
for each row execute function reject_recording_capture_queue_delete();

create trigger recording_capture_connections_no_truncate
before truncate on recording_capture_connections
for each statement execute function reject_recording_capture_queue_delete();

create trigger recording_capture_commands_authority_immutable
before update on recording_capture_commands
for each row execute function protect_recording_capture_command();

create trigger recording_capture_commands_no_delete
before delete on recording_capture_commands
for each row execute function reject_recording_capture_queue_delete();

create trigger recording_capture_commands_no_truncate
before truncate on recording_capture_commands
for each statement execute function reject_recording_capture_queue_delete();

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
    expires_at timestamptz,
    constraint recording_artifacts_expiry_check check (expires_at is null or expires_at > committed_at),
    created_at timestamptz not null default now()
);

create function reject_recording_object_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording object facts are immutable';
end;
$$;

create trigger recording_bundles_immutable
before update on recording_bundles
for each row execute function reject_recording_object_mutation();

create trigger recording_artifacts_immutable
before update on recording_artifacts
for each row execute function reject_recording_object_mutation();

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
    recording_id uuid,
    request_fingerprint bytea not null,
    request_payload jsonb not null,
    state text not null default 'prepared',
    outcome text,
    reason text,
    last_error_code text,
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
    constraint provider_operation_receipts_error_code_check check (last_error_code is null or octet_length(last_error_code) between 1 and 256),
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

create function notify_provider_publication_observation() returns trigger
language plpgsql as $$
declare
    episode_space_id uuid;
begin
    select space_id into episode_space_id
    from episodes
    where tenant_id = new.tenant_id and id = new.episode_id;

    if episode_space_id is not null then
        perform pg_notify(
            'chalk_media_publications',
            new.tenant_id::text || ':' || episode_space_id::text || ':' || new.episode_id::text
        );
    end if;
    return new;
end;
$$;

create trigger provider_publication_observation_notify
after insert on provider_operation_observations
for each row execute function notify_provider_publication_observation();

create table recording_data_keys (
    recording_id uuid not null references recordings(id) on delete restrict,
    capture_epoch bigint not null check (capture_epoch > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    key_handle uuid not null,
    environment text not null,
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    ciphertext_blob bytea not null check (octet_length(ciphertext_blob) > 0),
    created_at timestamptz not null default now(),
    primary key (recording_id, capture_epoch),
    unique (key_handle)
);
create index recording_data_keys_authority_idx
    on recording_data_keys(tenant_id, recording_id, capture_epoch);

create table recording_bundle_allocations (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    object_handle uuid not null,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    sequence_number bigint not null check (sequence_number >= 0),
    codec text not null,
    layer text,
    monotonic_start_millis bigint not null check (monotonic_start_millis >= 0),
    monotonic_end_millis bigint not null check (monotonic_end_millis >= monotonic_start_millis),
    media_start_millis bigint not null check (media_start_millis >= 0),
    media_end_millis bigint not null check (media_end_millis >= media_start_millis),
    object_key text not null,
    upload_token_hash bytea not null check (octet_length(upload_token_hash) = 32),
    expected_byte_size bigint not null check (expected_byte_size >= 0),
    expected_checksum bytea not null check (octet_length(expected_checksum) = 32),
    content_type text not null,
    expires_at timestamptz not null,
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    state text not null default 'allocated' check (state in ('reserved', 'allocated', 'committed')),
    object_version text,
    object_etag text,
    object_checksum bytea,
    manifest_digest bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (upload_token_hash),
    unique (object_key),
    unique (job_id, attempt_count, reservation_request_id),
    unique (recording_id, sequence_number),
    constraint recording_bundle_allocations_commit_facts_check check (
        (state in ('reserved', 'allocated') and object_version is null and object_etag is null and object_checksum is null and manifest_digest is null and committed_at is null)
        or (state = 'committed' and object_version is not null and object_etag is not null and octet_length(object_checksum) = 32 and octet_length(manifest_digest) = 32 and committed_at is not null)
    )
);
create index recording_bundle_allocations_authority_idx
    on recording_bundle_allocations(tenant_id, recording_id, capture_epoch, sequence_number);

alter table recording_bundles
    add column allocation_id uuid unique references recording_bundle_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text,
    add column capture_epoch bigint,
    add column envelope_digest bytea,
    add column encryption_context_digest bytea,
    add column manifest_digest bytea;

create function protect_recording_data_key_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording data keys are append-only';
end;
$$;

create trigger recording_data_keys_immutable
before update or delete on recording_data_keys
for each row execute function protect_recording_data_key_mutation();

create trigger recording_data_keys_no_truncate
before truncate on recording_data_keys
for each statement execute function protect_recording_data_key_mutation();

create function protect_recording_bundle_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.job_id <> new.job_id
        or old.object_handle <> new.object_handle
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.sequence_number <> new.sequence_number
        or old.object_key <> new.object_key
        or old.encryption_context_digest <> new.encryption_context_digest
        or old.created_at <> new.created_at then
        raise exception 'recording bundle allocation authority is immutable';
    end if;

    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'allocated' then
        if old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis
            or old.object_version is not null
            or old.object_etag is not null
            or old.object_checksum is not null
            or old.manifest_digest is not null
            or old.committed_at is not null then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'committed' then
        if old.upload_token_hash is distinct from new.upload_token_hash
            or old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    raise exception 'recording bundle allocation state transition is invalid';
end;
$$;

create trigger recording_bundle_allocations_authority_immutable
before update on recording_bundle_allocations
for each row execute function protect_recording_bundle_allocation_mutation();

create function reject_recording_bundle_allocation_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording bundle allocations are append-only';
end;
$$;

create trigger recording_bundle_allocations_no_delete
before delete on recording_bundle_allocations
for each row execute function reject_recording_bundle_allocation_delete();

create trigger recording_bundle_allocations_no_truncate
before truncate on recording_bundle_allocations
for each statement execute function reject_recording_bundle_allocation_delete();


alter table recording_pipelines
    add column capture_ready_at timestamptz;

comment on column recording_pipelines.capture_ready_at is
    'Immutable recording clock origin established by the first authoritative capture-ready callback.';



create table recording_presentation_baselines (
    presentation_handle uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    schema_version text not null check (schema_version = 'recording_presentation.v1'),
    profile_version text not null check (octet_length(profile_version) between 1 and 128),
    profile jsonb not null check (
        jsonb_typeof(profile) = 'object'
        and profile ->> 'version' = profile_version
        and octet_length(profile::text) between 2 and 32768
    ),
    space_name text not null check (octet_length(space_name) between 1 and 256),
    episode_control_revision bigint not null check (episode_control_revision >= 0),
    episode_folded_state jsonb not null check (jsonb_typeof(episode_folded_state) = 'object'),
    participant_facts jsonb not null check (jsonb_typeof(participant_facts) = 'array'),
    chat_head_sequence bigint not null check (chat_head_sequence >= 0),
    chat_retained_floor_sequence bigint,
    whiteboard_scene_id uuid,
    whiteboard_revision bigint check (whiteboard_revision is null or whiteboard_revision >= 0),
    whiteboard_snapshot jsonb,
    baseline_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (recording_id),
    unique (tenant_id, space_id, episode_id, recording_id),
    check ((whiteboard_scene_id is null) = (whiteboard_revision is null)),
    check ((whiteboard_scene_id is null) = (whiteboard_snapshot is null)),
    check (whiteboard_snapshot is null or jsonb_typeof(whiteboard_snapshot) = 'object'),
    check (chat_retained_floor_sequence is null or chat_retained_floor_sequence between 1 and chat_head_sequence + 1)
);

create table recording_presentation_sources (
    presentation_handle uuid primary key references recording_presentation_baselines(presentation_handle) on delete restrict,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    capture_ready_at timestamptz not null,
    episode_control_start_revision bigint not null check (episode_control_start_revision >= 0),
    episode_control_events jsonb not null check (jsonb_typeof(episode_control_events) = 'array'),
    episode_control_end_revision bigint not null check (episode_control_end_revision >= episode_control_start_revision),
    participant_facts jsonb not null check (jsonb_typeof(participant_facts) = 'array'),
    chat_start_sequence bigint not null check (chat_start_sequence >= 0),
    chat_retained_floor_sequence bigint,
    initial_chat_messages jsonb not null check (jsonb_typeof(initial_chat_messages) = 'array'),
    whiteboard_start_revision bigint not null check (whiteboard_start_revision >= 0),
    whiteboard_events jsonb not null check (jsonb_typeof(whiteboard_events) = 'array'),
    whiteboard_end_revision bigint not null check (whiteboard_end_revision >= whiteboard_start_revision),
    capture_plan_start_revision bigint not null check (capture_plan_start_revision >= 0),
    created_at timestamptz not null default now(),
    unique (recording_id, capture_epoch),
    unique (tenant_id, space_id, episode_id, recording_id, presentation_handle),
    foreign key (tenant_id, space_id, episode_id, recording_id)
        references recording_presentation_baselines(tenant_id, space_id, episode_id, recording_id)
        on delete restrict,
    check (chat_retained_floor_sequence is null or chat_retained_floor_sequence between 1 and chat_start_sequence + 1),
    check (jsonb_array_length(initial_chat_messages) <= 100)
);

create table recording_presentations (
    presentation_handle uuid primary key references recording_presentation_sources(presentation_handle) on delete restrict,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    schema_version text not null check (schema_version = 'recording_presentation.v1'),
    profile_version text not null check (octet_length(profile_version) between 1 and 128),
    duration_millis bigint not null check (duration_millis >= 0),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    presentation_object_key text not null check (octet_length(presentation_object_key) between 1 and 1024),
    presentation_object_version text not null check (octet_length(presentation_object_version) <= 1024),
    presentation_object_etag text not null check (octet_length(presentation_object_etag) between 1 and 512),
    presentation_content_type text not null check (presentation_content_type = 'application/json'),
    presentation_byte_size bigint not null check (presentation_byte_size between 1 and 67108864),
    asset_manifest_object_key text not null check (octet_length(asset_manifest_object_key) between 1 and 1024),
    asset_manifest_object_version text not null check (octet_length(asset_manifest_object_version) <= 1024),
    asset_manifest_object_etag text not null check (octet_length(asset_manifest_object_etag) between 1 and 512),
    asset_manifest_content_type text not null check (asset_manifest_content_type = 'application/json'),
    asset_manifest_byte_size bigint not null check (asset_manifest_byte_size between 1 and 1048576),
    asset_manifest_sha256 bytea not null check (octet_length(asset_manifest_sha256) = 32),
    frozen_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (recording_id),
    unique (tenant_id, recording_id, presentation_handle),
    foreign key (tenant_id, space_id, episode_id, recording_id, presentation_handle)
        references recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle)
        on delete restrict
);

create table recording_presentation_assets (
    presentation_handle uuid not null,
    tenant_id uuid not null,
    recording_id uuid not null,
    ordinal smallint not null check (ordinal between 0 and 255),
    asset_id text not null check (octet_length(asset_id) between 1 and 512),
    asset_kind text not null check (asset_kind in ('logo', 'avatar', 'chat_attachment', 'whiteboard_state', 'whiteboard_file', 'font')),
    object_key text not null check (octet_length(object_key) between 1 and 1024),
    object_version text not null check (octet_length(object_version) <= 1024),
    object_etag text not null check (octet_length(object_etag) between 1 and 512),
    content_type text not null check (octet_length(content_type) between 1 and 255),
    byte_size bigint not null check (byte_size > 0),
    sha256 bytea not null check (octet_length(sha256) = 32),
    created_at timestamptz not null default now(),
    primary key (presentation_handle, ordinal),
    unique (presentation_handle, asset_id),
    foreign key (tenant_id, recording_id, presentation_handle)
        references recording_presentations(tenant_id, recording_id, presentation_handle)
        on delete restrict
);

create table recording_presentation_reactions (
    reaction_id uuid primary key,
    presentation_handle uuid not null,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    recording_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null check (participant_generation > 0),
    display_name text not null check (octet_length(display_name) between 1 and 256),
    reaction text not null check (reaction in ('👍', '❤️', '😂', '😮', '😢', '🎉')),
    occurred_at timestamptz not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    foreign key (tenant_id, space_id, episode_id, recording_id, presentation_handle)
        references recording_presentation_sources(tenant_id, space_id, episode_id, recording_id, presentation_handle)
        on delete restrict,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete restrict,
    check (expires_at > occurred_at)
);
create index recording_presentation_reactions_timeline_idx
    on recording_presentation_reactions(presentation_handle, occurred_at, reaction_id);

-- +goose StatementBegin
create function reject_recording_presentation_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording presentation authority is append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_presentation_baselines_immutable
before update or delete on recording_presentation_baselines
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_sources_immutable
before update or delete on recording_presentation_sources
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentations_immutable
before update or delete on recording_presentations
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_assets_immutable
before update or delete on recording_presentation_assets
for each row execute function reject_recording_presentation_mutation();
create trigger recording_presentation_reactions_immutable
before update or delete on recording_presentation_reactions
for each row execute function reject_recording_presentation_mutation();



create table recording_render_inputs (
    render_input_handle uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    key_handle uuid not null,
    object_handle uuid not null unique,
    presentation_handle uuid not null references recording_presentations(presentation_handle) on delete restrict,
    presentation_schema_version text not null check (presentation_schema_version = 'recording_presentation.v1'),
    presentation_profile_version text not null check (octet_length(presentation_profile_version) between 1 and 128),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    presentation_duration_millis bigint not null check (presentation_duration_millis > 0),
    capture_ready_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (render_job_id, attempt_count, fencing_generation),
    foreign key (render_job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
        on delete restrict
);
create index recording_render_inputs_recording_idx
    on recording_render_inputs(tenant_id, recording_id, capture_epoch);

create table recording_render_object_allocations (
    id uuid primary key,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    object_handle uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    purpose text not null check (purpose in ('recording_video', 'transcription_manifest', 'transcription_audio')),
    state text not null check (state in ('reserved', 'allocated', 'committed')),
    object_key text not null unique,
    expected_content_type text,
    expected_byte_size bigint,
    expected_sha256 bytea,
    expected_duration_millis bigint,
    upload_token_hash bytea,
    upload_expires_at timestamptz,
    object_version text,
    object_etag text,
    object_content_type text,
    object_byte_size bigint,
    object_sha256 bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (object_handle, reservation_request_id),
	unique (recording_id, allocation_version),
    constraint recording_render_allocations_expected_facts_check check (
        (state = 'reserved' and expected_content_type is null and expected_byte_size is null and expected_sha256 is null and expected_duration_millis is null and upload_token_hash is null and upload_expires_at is null)
        or (state in ('allocated', 'committed') and expected_content_type is not null and expected_byte_size > 0 and octet_length(expected_sha256) = 32 and octet_length(upload_token_hash) = 32 and upload_expires_at is not null)
    ),
    constraint recording_render_allocations_purpose_facts_check check (
		(purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 14400000)))
		or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))
		or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))
    ),
    constraint recording_render_allocations_committed_facts_check check (
        (state <> 'committed' and object_version is null and object_etag is null and object_content_type is null and object_byte_size is null and object_sha256 is null and committed_at is null)
		or (state = 'committed' and length(object_version) between 0 and 256 and length(object_etag) between 1 and 256 and object_content_type = expected_content_type and object_byte_size = expected_byte_size and object_sha256 = expected_sha256 and committed_at is not null)
    )
);
create index recording_render_allocations_authority_idx
    on recording_render_object_allocations(render_job_id, attempt_count, fencing_generation, purpose, state);
create index recording_render_allocations_token_idx
    on recording_render_object_allocations(upload_token_hash)
    where upload_token_hash is not null;

create table recording_render_commits (
    render_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    video_allocation_id uuid not null references recording_render_object_allocations(id) on delete restrict,
    ffprobe_facts_digest bytea not null check (octet_length(ffprobe_facts_digest) = 32),
	transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    transcription_job_ids uuid[] not null default '{}',
    committed_at timestamptz not null default now(),
    unique (recording_id)
);

create table recording_transcription_preparation_commits (
    transcription_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    committed_at timestamptz not null default now()
);

-- +goose StatementBegin
create function protect_recording_render_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.render_job_id <> new.render_job_id
        or old.render_input_handle <> new.render_input_handle
        or old.object_handle <> new.object_handle
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.purpose <> new.purpose
        or old.object_key <> new.object_key
        or old.created_at <> new.created_at then
        raise exception 'recording render allocation authority is immutable';
    end if;
    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'allocated'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.object_version is null and new.object_version is null then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'committed'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.upload_token_hash = new.upload_token_hash
        and old.upload_expires_at = new.upload_expires_at then
        return new;
    end if;
    raise exception 'recording render allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_allocations_authority_immutable
before update on recording_render_object_allocations
for each row execute function protect_recording_render_allocation_mutation();

-- +goose StatementBegin
create function reject_recording_render_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording render authority is append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_inputs_immutable
before update or delete on recording_render_inputs
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_immutable
before update or delete on recording_render_commits
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_delete
before delete on recording_render_object_allocations
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_inputs_no_truncate
before truncate on recording_render_inputs
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_no_truncate
before truncate on recording_render_commits
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_truncate
before truncate on recording_render_object_allocations
for each statement execute function reject_recording_render_authority_mutation();



alter table recording_transcription_sources
    add column generation bigint not null default 1,
    add column commit_digest bytea,
    add column presentation_sha256 bytea,
    add column manifest_allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column manifest_object_version text,
    add column manifest_etag text,
    add column status text not null default 'ready',
    add column expires_at timestamptz,
    add column lease_transcript_id uuid references transcriptions(id) on delete restrict,
    add column lease_expires_at timestamptz,
    add column cleanup_due_at timestamptz,
    add column deleted_at timestamptz,
    add column updated_at timestamptz not null default now();

update recording_transcription_sources
set commit_digest = manifest_sha256,
    expires_at = committed_at + interval '24 hours'
where commit_digest is null or expires_at is null;

alter table recording_transcription_sources
    alter column commit_digest set not null,
    alter column expires_at set not null,
    add constraint recording_transcription_sources_generation_check check (generation > 0),
    add constraint recording_transcription_sources_commit_digest_check check (octet_length(commit_digest) = 32),
    add constraint recording_transcription_sources_presentation_sha256_check check (presentation_sha256 is null or octet_length(presentation_sha256) = 32),
    add constraint recording_transcription_sources_manifest_object_version_check check (manifest_object_version is null or length(manifest_object_version) between 1 and 256),
    add constraint recording_transcription_sources_manifest_etag_check check (manifest_etag is null or length(manifest_etag) between 1 and 256),
    add constraint recording_transcription_sources_status_check check (status in ('ready', 'leased', 'cleanup_pending', 'deleting', 'deleted')),
    add constraint recording_transcription_sources_expiry_check check (expires_at > committed_at and expires_at <= committed_at + interval '30 days'),
    add constraint recording_transcription_sources_lease_check check (
        (lease_transcript_id is null and lease_expires_at is null)
        or (
            lease_transcript_id is not null
            and lease_expires_at is not null
            and lease_expires_at <= expires_at + interval '2 hours'
        )
    ),
    add constraint recording_transcription_sources_status_lease_check check (
        (status = 'ready' and lease_transcript_id is null and lease_expires_at is null)
        or (status = 'leased' and lease_transcript_id is not null and lease_expires_at is not null)
        or (status in ('cleanup_pending', 'deleting', 'deleted') and lease_transcript_id is null and lease_expires_at is null)
    ),
    add constraint recording_transcription_sources_cleanup_check check (
        (status in ('ready', 'leased') and cleanup_due_at is null and deleted_at is null)
        or (status in ('cleanup_pending', 'deleting') and cleanup_due_at is not null and deleted_at is null)
        or (status = 'deleted' and cleanup_due_at is not null and deleted_at is not null)
    );

create unique index recording_transcription_sources_recording_generation_uidx
    on recording_transcription_sources(recording_id, generation);
create index recording_transcription_sources_expiry_idx
    on recording_transcription_sources(expires_at, recording_id)
    where status = 'ready';
create index recording_transcription_sources_lease_expiry_idx
    on recording_transcription_sources(lease_expires_at, recording_id)
    where status = 'leased';
create index recording_transcription_sources_cleanup_idx
    on recording_transcription_sources(cleanup_due_at, recording_id)
    where status in ('cleanup_pending', 'deleting');

alter table transcriptions add column source_expires_at timestamptz;

update transcriptions transcript
set source_expires_at = source.expires_at
from recording_transcription_sources source
where source.recording_id = transcript.recording_id
  and transcript.source_expires_at is null;

alter table recording_transcription_source_chunks
    add column track_id text,
    add column participant_generation bigint,
    add column display_name_snapshot text,
    add column overlap boolean not null default false,
    add column source_start_ms bigint,
    add column source_end_ms bigint,
    add column allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text;

update recording_transcription_source_chunks
set source_start_ms = 0,
    source_end_ms = end_ms - start_ms
where source_start_ms is null or source_end_ms is null;

alter table recording_transcription_source_chunks
    alter column source_start_ms set not null,
    alter column source_end_ms set not null,
    add constraint recording_transcription_source_chunks_track_id_check check (track_id is null or length(track_id) between 1 and 256),
    add constraint recording_transcription_source_chunks_participant_generation_check check (participant_generation is null or participant_generation > 0),
    add constraint recording_transcription_source_chunks_display_name_check check (display_name_snapshot is null or length(display_name_snapshot) between 1 and 256),
    add constraint recording_transcription_source_chunks_display_name_authority_check check (
        display_name_snapshot is null or (identity_kind = 'participant' and track_class = 'microphone')
    ),
    add constraint recording_transcription_source_chunks_source_time_check check (
        source_start_ms >= 0
        and source_end_ms > source_start_ms
        and source_end_ms - source_start_ms = end_ms - start_ms
    ),
    add constraint recording_transcription_source_chunks_object_version_check check (object_version is null or length(object_version) between 1 and 256),
    add constraint recording_transcription_source_chunks_object_etag_check check (object_etag is null or length(object_etag) between 1 and 256);

alter table transcription_cleanup_jobs
    add column recording_id uuid references recordings(id) on delete restrict;

update transcription_cleanup_jobs cleanup
set recording_id = transcriptions.recording_id
from transcriptions
where transcriptions.id = cleanup.transcript_id
  and cleanup.recording_id is null;

alter table transcription_cleanup_jobs
    alter column recording_id set not null,
    alter column transcript_id drop not null,
    drop constraint transcription_cleanup_jobs_transcript_id_object_key_key,
    drop constraint transcription_cleanup_jobs_kind_check,
    add constraint transcription_cleanup_jobs_kind_check check (
        object_kind in ('final_artifact', 'temp_result', 'source_manifest', 'source_chunk', 'recording_source')
    ),
    add constraint transcription_cleanup_jobs_owner_check check (
        (object_kind in ('final_artifact', 'temp_result') and transcript_id is not null)
        or (object_kind in ('source_manifest', 'source_chunk', 'recording_source'))
    );

create unique index transcription_cleanup_jobs_recording_object_uidx
    on transcription_cleanup_jobs(recording_id, object_key);



alter table recording_pool_health
    add column demand_revision text not null default 'legacy'
    check (octet_length(demand_revision) between 1 and 128);

create table recording_fleet_nodes (
    environment text not null check (environment ~ '^[a-z][a-z0-9-]{0,31}$'),
    role text not null check (role in ('capture', 'render')),
    provider_id text not null check (octet_length(provider_id) between 1 and 128),
    node_name text not null check (octet_length(node_name) between 1 and 255),
    region text not null check (region ~ '^[a-z][a-z0-9-]{0,31}$'),
    release_id text not null check (octet_length(release_id) between 1 and 128),
    image_digest text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
    boot_generation bigint not null check (boot_generation > 0),
    inventory_digest text not null check (inventory_digest ~ '^[0-9a-f]{64}$'),
    worker_id uuid,
    state text not null check (state in ('requested', 'active', 'draining', 'revoked')),
    ready boolean not null default false,
    admission_open boolean not null default false,
    ready_capacity integer not null default 0 check (ready_capacity >= 0),
    observed_at timestamptz,
    resources_latest jsonb,
    peak_rss_bytes bigint not null default 0 check (peak_rss_bytes >= 0),
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (environment, role, provider_id),
    unique (worker_id),
    constraint recording_fleet_nodes_environment_provider_key unique (environment, provider_id),
    constraint recording_fleet_nodes_worker_state_check check (
        state = 'revoked'
        or (state = 'requested') = (worker_id is null)
    ),
    check (not admission_open or (state = 'active' and ready and ready_capacity > 0)),
    check ((state = 'revoked') = (revoked_at is not null)),
    check (state <> 'revoked' or (not ready and not admission_open and ready_capacity = 0))
);

create index recording_fleet_nodes_role_state_idx
    on recording_fleet_nodes(environment, role, state, provider_id);

create table recording_preparations (
    tenant_id uuid not null,
    space_id uuid not null,
    starts_at timestamptz not null,
    state text not null check (state in ('scheduled', 'consumed', 'canceled', 'expired')),
    revision bigint not null check (revision > 0),
    request_revision bigint not null check (request_revision >= 0),
    request_kind text not null check (request_kind in ('prepare', 'cancel')),
    consumed_recording_id uuid references recordings(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id),
    foreign key (tenant_id, space_id) references spaces(tenant_id, id) on delete cascade,
    check ((state = 'consumed') = (consumed_recording_id is not null))
);

create index recording_preparations_due_idx on recording_preparations(starts_at, tenant_id, space_id)
    where state = 'scheduled';

create function recording_enqueue_terminal_capture_source_cleanup(source_recording_id uuid, stopped_at timestamptz)
returns void
language sql
as $$
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), objects.tenant_id, source_recording_id, null,
        objects.object_key, 'recording_source', stopped_at +
            (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')
    from (
        select allocations.tenant_id, allocations.object_key
        from recording_bundle_allocations allocations
        where allocations.recording_id = source_recording_id
          and allocations.state in ('allocated', 'committed')
        union
        select presentations.tenant_id, presentations.presentation_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select presentations.tenant_id, presentations.asset_manifest_object_key
        from recording_presentations presentations
        where presentations.recording_id = source_recording_id
        union
        select assets.tenant_id, assets.object_key
        from recording_presentations presentations
        join recording_presentation_assets assets
          on assets.presentation_handle = presentations.presentation_handle
        where presentations.recording_id = source_recording_id
    ) objects
    join recordings on recordings.id = source_recording_id
    join episodes on episodes.id = recordings.episode_id
    on conflict (recording_id, object_key) do nothing;
$$;

create function recording_terminal_capture_source_cleanup_trigger()
returns trigger
language plpgsql
as $$
begin
    perform recording_enqueue_terminal_capture_source_cleanup(new.recording_id, coalesce(new.terminal_at, new.updated_at));
    return new;
end;
$$;

create trigger recording_terminal_capture_source_cleanup
after update of state on recording_jobs
for each row
when (new.kind = 'capture' and new.state = 'terminal_failure' and old.state is distinct from new.state)
execute function recording_terminal_capture_source_cleanup_trigger();

create function recording_backfill_terminal_capture_source_cleanup()
returns void
language plpgsql
as $$
declare
    terminal_capture record;
begin
    for terminal_capture in
        select jobs.recording_id, coalesce(jobs.terminal_at, jobs.updated_at) as terminal_at
        from recording_jobs jobs
        where jobs.kind = 'capture'
          and jobs.state = 'terminal_failure'
          and exists (
              select 1 from recording_bundle_allocations allocations
              where allocations.recording_id = jobs.recording_id
                and allocations.state in ('allocated', 'committed')
          )
    loop
        perform recording_enqueue_terminal_capture_source_cleanup(
            terminal_capture.recording_id, terminal_capture.terminal_at
        );
    end loop;
end;
$$;

create table recording_completion_recoveries (
    job_id uuid primary key references recording_jobs(id) on delete restrict,
    request_id uuid not null unique,
    database_user text not null default current_user,
    operator text not null check (octet_length(operator) between 1 and 256),
    reason text not null check (octet_length(reason) between 1 and 1024),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    source_expires_at timestamptz not null,
    requested_at timestamptz not null default now()
);

create function reject_recording_completion_recovery_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording completion recoveries are append-only';
end;
$$;

create trigger recording_completion_recoveries_immutable
before update or delete on recording_completion_recoveries
for each row execute function reject_recording_completion_recovery_mutation();
create trigger recording_completion_recoveries_no_truncate
before truncate on recording_completion_recoveries
for each statement execute function reject_recording_completion_recovery_mutation();

-- Participant attendance survives Episode journal retention.
alter table participants
    add column first_joined_at timestamptz,
    add column last_left_reason text check (last_left_reason in ('left', 'episode_ended'));
create index participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

ALTER TABLE tenants
    ADD COLUMN created_by_service_id text,
    ADD COLUMN external_id text,
    ADD CONSTRAINT tenants_service_id_check CHECK (
        created_by_service_id IS NULL OR (length(created_by_service_id) BETWEEN 1 AND 128 AND btrim(created_by_service_id) = created_by_service_id)
    ),
    ADD CONSTRAINT tenants_external_id_check CHECK (
        external_id IS NULL OR (created_by_service_id IS NOT NULL AND length(external_id) BETWEEN 1 AND 512 AND btrim(external_id) = external_id)
    ),
    ADD CONSTRAINT tenants_service_external_id_key UNIQUE (created_by_service_id, external_id);

CREATE INDEX tenants_service_created_at_id_idx ON tenants(created_by_service_id, created_at DESC, id DESC);

alter table sync_chat_messages add column reaction_revision bigint not null default 0;

create table sync_chat_message_reactions (
    tenant_id uuid not null,
    space_id uuid not null,
    message_id uuid not null,
    participant_id uuid not null,
    emoji text not null,
    primary key (tenant_id, space_id, message_id, participant_id, emoji),
    foreign key (tenant_id, space_id, message_id)
        references sync_chat_messages(tenant_id, space_id, message_id) on delete cascade,
    check (emoji in ('👍', '❤️', '😂', '😮', '🎉', '👏', '😀', '😅', '🙏', '🔥', '✅', '👀', '💯', '🤔', '😢', '🙌', '🚀', '👌', '😍', '🤝', '💡', '⭐', '😎', '🥳'))
);

create function sync_admission_expiry_due(request_expires_at timestamptz, arrival_state text, as_of timestamptz)
returns boolean
language sql immutable parallel safe
as $$
    select request_expires_at <= as_of
        or coalesce(arrival_state in ('unavailable', 'rejected', 'left'), false);
$$;

create function guard_canonical_public_admission_decision()
returns trigger
language plpgsql
as $$
declare
    canonical_state text;
begin
    select case when status = 'admitted' then 'approved' else status end
      into canonical_state
      from sync_admission_requests
      where tenant_id = new.tenant_id and space_id = new.space_id
        and admission_request_id = new.request_handle;
    if found and new.state <> canonical_state then
        raise exception 'canonical admission decisions are owned by Sync'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

create trigger space_public_admission_requests_canonical_decision
before update of state on space_public_admission_requests
for each row when (old.state is distinct from new.state)
execute function guard_canonical_public_admission_decision();

CREATE FUNCTION recording_capture_stop_confirmed(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id AND recording.tenant_id = pipeline.tenant_id
        JOIN sync_external_operations operation ON operation.tenant_id = job.tenant_id
            AND operation.episode_id = job.episode_id AND operation.recording_id = job.recording_id
        WHERE pipeline.recording_id = target_recording_id AND recording.status = 'stopped'
          AND operation.payload ->> 'stopOperationId' = recording.stop_external_operation_id::text
          AND operation.payload -> 'captureEpoch' = to_jsonb(pipeline.capture_epoch)
          AND operation.operation_name = 'recording_capture_stopped' AND operation.status = 'applied'
    );
$$;

CREATE FUNCTION recording_capture_salvage_deadline(target_recording_id uuid)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
    SELECT pipeline.stop_requested_at + recording_deferred_retention_seconds(episode.config_snapshot) * interval '1 second'
    FROM recording_pipelines pipeline
    JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
    JOIN episodes episode ON episode.id = job.episode_id
    WHERE pipeline.recording_id = target_recording_id
      AND NOT recording_capture_stop_confirmed(target_recording_id);
$$;

CREATE FUNCTION recording_capture_completion_available(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id
            AND recording.tenant_id = pipeline.tenant_id
        WHERE pipeline.recording_id = target_recording_id
          AND pipeline.stop_requested_at IS NOT NULL
          AND pipeline.capture_ready_at IS NOT NULL
          AND (
              recording_capture_stop_confirmed(target_recording_id) OR (
                  recording_capture_salvage_deadline(target_recording_id) > clock_timestamp()
                  AND EXISTS (SELECT 1 FROM recording_bundles bundle WHERE bundle.recording_id = pipeline.recording_id)
                  AND EXISTS (SELECT 1 FROM recording_data_keys key WHERE key.recording_id = pipeline.recording_id
                              AND key.capture_epoch = pipeline.capture_epoch)
              )
          )
    );
$$;

-- Absence of a seat row means the legacy protocol. No historical rows change.
-- Rollout: migrate, upgrade every Sync consumer, then API and client SDKs.
-- Previous API/Sync binaries remain runnable; runtime rollback keeps this schema.
-- Absence of a seat row means the legacy protocol. No historical rows change.
-- The Wave 1 baseline recreated this FK without its July constraint name.
-- Resolve its columns and target without renaming a deployed constraint.
-- +goose StatementBegin
do $$
declare
    generation_constraint name;
begin
    select constraint_row.conname into strict generation_constraint
    from pg_constraint constraint_row
    where constraint_row.contype = 'f'
      and constraint_row.conrelid = 'sync_lifecycle_intents'::regclass
      and constraint_row.confrelid = 'participants'::regclass
      and (
          select array_agg(attribute.attname::text order by key.ordinality)
          from unnest(constraint_row.conkey) with ordinality as key(attnum, ordinality)
          join pg_attribute attribute
            on attribute.attrelid = constraint_row.conrelid and attribute.attnum = key.attnum
      ) = array['tenant_id', 'space_id', 'episode_id', 'participant_id', 'participant_generation'];

    execute format(
        'alter table sync_lifecycle_intents alter constraint %I deferrable initially deferred',
        generation_constraint
    );
end;
$$;
-- +goose StatementEnd

create table participant_join_seats (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    generation bigint not null check (generation > 0),
    state text not null check (state in ('pending', 'joined', 'left', 'cancelled', 'expired')),
    expires_at timestamptz not null,
    updated_at timestamptz not null default now(),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

-- The existing lifecycle queue delivers pending-seat expiry at next_attempt_at.
-- One authority owns the state machine for API cancellation/retry and Sync hello:
-- pending -> joined (completed entry), cancelled (HTTP), expired (lease).
-- cancelled/expired -> pending (retry); joined -> left (normal departure trigger).
-- +goose StatementBegin
create function transition_participant_join_seat(
    seat_tenant uuid, seat_space uuid, seat_episode uuid, seat_participant uuid,
    seat_generation bigint, action text, expected_connection text default null
) returns text language plpgsql as $$
declare
    seat participant_join_seats%rowtype;
    intent sync_lifecycle_intents%rowtype;
    terminal_state text;
begin
    if action not in ('confirm', 'cancel', 'expire', 'retry') then
        raise exception 'invalid participant join transition';
    end if;
    perform 1 from sync_episode_control
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
    for update;
    perform 1 from episodes
    where tenant_id = seat_tenant and space_id = seat_space and id = seat_episode
    for update;
    perform 1 from participants
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and id = seat_participant for update;
    select * into seat from participant_join_seats
    where tenant_id = seat_tenant and space_id = seat_space and episode_id = seat_episode
      and participant_id = seat_participant for update;
    if not found then return 'legacy'; end if;
    if seat.generation != seat_generation then return 'stale'; end if;
    if action='retry' and not exists (select 1 from episodes
        where tenant_id=seat_tenant and space_id=seat_space and id=seat_episode and status='active') then
        return 'episode_ended';
    end if;

    if action='retry' and seat.state='pending' and seat.expires_at > now()
       and exists (select 1 from participants where id=seat_participant
         and status='joining' and first_joined_at is null) then
        -- Each explicit attempt owns a new generation, even if cleanup was lost.
        update participants set generation=generation+1, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set generation=generation+1,
            expires_at=now()+interval '2 minutes', updated_at=now() where participant_id=seat_participant;
        update sync_lifecycle_intents set participant_generation=seat_generation+1,
            next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending';
        return 'pending';
    end if;

    if seat.state = 'pending' then
        if action = 'cancel' then
            -- A late failure from an older attempt cannot cancel a newer grant.
            if not exists (select 1 from participants where id = seat_participant
                and media_connection_id = expected_connection) then return 'stale'; end if;
            terminal_state := 'cancelled';
        elsif seat.expires_at <= now() then
            terminal_state := 'expired';
        elsif action = 'confirm' then
            update participant_join_seats set state='joined', updated_at=now()
            where participant_id=seat_participant;
            return 'joined';
        else
            return 'pending';
        end if;

        -- Previous Sync binaries may already have applied the legacy join.
        if not exists (select 1 from participants where id = seat_participant
            and generation = seat_generation and status = 'joining') then return 'joined'; end if;
        update sync_lifecycle_intents
        set status='superseded', terminal_reason='participant_already_terminal', completed_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='pending'
        returning * into intent;
        if not found then return seat.state; end if;
        if intent.journey_id is not null then
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
                trace_id, span_id, attributes
            ) values (
                gen_random_uuid(), intent.journey_id, 1, now(), 'participant.join_' || terminal_state,
                'terminal', 'cancelled', 'server', case when terminal_state='expired' then 'sync' else 'api' end,
                'visible', intent.parent_journey_event_id, intent.producing_trace_id, intent.producing_span_id,
                jsonb_build_object('participant_id', seat_participant, 'reason', terminal_state)
            );
        end if;
        update participant_join_seats set state=terminal_state, updated_at=now()
        where participant_id=seat_participant;
        update participants set status='left', left_at=now(), updated_at=now() where id=seat_participant;
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes-2048,
            lifecycle_reserved_events=lifecycle_reserved_events-2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes-32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents-1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes-16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode;
        seat.state := terminal_state;
    end if;

    if action='retry' and seat.state in ('cancelled','expired') then
        update sync_episode_control set
            snapshot_reserved_bytes=snapshot_reserved_bytes+2048,
            lifecycle_reserved_events=lifecycle_reserved_events+2,
            lifecycle_reserved_bytes=lifecycle_reserved_bytes+32768,
            lifecycle_reserved_intents=lifecycle_reserved_intents+1,
            lifecycle_reserved_intent_bytes=lifecycle_reserved_intent_bytes+16384,
            updated_at=now()
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and snapshot_bytes+snapshot_reserved_bytes+2048 <= 1048576
          and lifecycle_event_count+lifecycle_reserved_events+2 <= 2048
          and lifecycle_event_bytes+lifecycle_reserved_bytes+32768 <= 33554432
          and lifecycle_intent_count+lifecycle_reserved_intents+1 <= 2048
          and lifecycle_intent_bytes+lifecycle_reserved_intent_bytes+16384 <= 33554432
          and (select count(*) from participants where tenant_id=seat_tenant and space_id=seat_space
            and episode_id=seat_episode and status in ('joining','active','leaving')) < 500;
        if not found then return 'capacity_exceeded'; end if;
        update participants set status='joining', generation=generation+1, left_at=null, media_connection_id=null,
            media_connection_generation=null, updated_at=now() where id=seat_participant;
        update participant_join_seats set state='pending', generation=generation+1, expires_at=now()+interval '2 minutes', updated_at=now()
        where participant_id=seat_participant;
        update sync_lifecycle_intents set status='pending', participant_generation=seat_generation+1, terminal_reason=null, completed_at=null,
            attempt_count=0, last_error_code=null, next_attempt_at=now()+interval '2 minutes'
        where tenant_id=seat_tenant and space_id=seat_space and episode_id=seat_episode
          and participant_id=seat_participant and participant_generation=seat_generation
          and intent_name='participant_joined' and status='superseded'
          and terminal_reason='participant_already_terminal';
        return 'pending';
    end if;
    return seat.state;
end;
$$;
-- +goose StatementEnd

-- Normal leave and Episode end also close the seat, including older binaries.
-- +goose StatementBegin
create function complete_participant_join_seat() returns trigger language plpgsql as $$
begin
    if new.status='left' then
        update participant_join_seats
        set state=case when state='joined' or new.first_joined_at is not null then 'left' else 'cancelled' end, updated_at=now()
        where participant_id=new.id and generation=new.generation and state in ('pending','joined');
    end if;
    return new;
end;
$$;
create trigger participant_join_seat_departure after update of status on participants
    for each row execute function complete_participant_join_seat();
-- +goose StatementEnd

alter table participant_join_seats add column entry_token_id text
    check (octet_length(entry_token_id) between 1 and 128);

alter table participant_join_seats
    add column issued_entry_generation bigint not null default 0
        check (issued_entry_generation between 0 and 9007199254740991),
    add column confirmed_entry_generation bigint not null default 0
        check (confirmed_entry_generation between 0 and issued_entry_generation),
    add column issued_entry_expires_at timestamptz not null default now() + interval '120 seconds';

create table sync_entry_rollout (
    singleton boolean primary key default true check (singleton),
    enforced boolean not null default false,
    enforced_at timestamptz,
    release_id text,
    check (enforced = (enforced_at is not null and release_id is not null))
);
insert into sync_entry_rollout(singleton) values (true);

-- Every writer takes this row lock before entry/Leave mutations. Enforcement
-- waits for earlier transactions; subsequent old transactions fail closed.
-- +goose StatementBegin
create function require_sync_entry_writer() returns trigger language plpgsql as $$
declare enabled boolean;
begin
    select enforced into strict enabled from sync_entry_rollout where singleton for share;
    if enabled and current_setting('chalk.entry_writer', true) is distinct from '1' then
        -- A still-current compatibility socket may request Leave. Only the new
        -- consumer can claim/finalize it; old provider dispatch remains fenced.
        if tg_table_name='sync_external_operations' and tg_op='INSERT' then
            if not exists (select 1 from participant_join_seats
                           where participant_id=new.target_participant_id
                             and generation=new.target_participant_generation
                             and confirmed_entry_generation > 0) then
                return new;
            end if;
        end if;
        raise exception 'Sync entry writer upgrade required' using errcode='55000';
    end if;
    return new;
end;
$$;
-- +goose StatementEnd
create trigger sync_entry_participant_writer before update of status on participants
    for each row when (new.status is distinct from old.status and
      (new.status='active' or (new.status='left' and old.first_joined_at is not null)))
    execute function require_sync_entry_writer();
create trigger sync_entry_leave_writer before insert or update on sync_external_operations
    for each row when (new.operation_name='participant_leave') execute function require_sync_entry_writer();
create trigger sync_entry_event_writer before insert on sync_control_events
    for each row execute function require_sync_entry_writer();

-- +goose StatementBegin
create function enforce_sync_entry_ownership(target_release text) returns void language plpgsql as $$
begin
    perform 1 from sync_entry_rollout where singleton for update;
    if (select enforced from sync_entry_rollout where singleton) then return; end if;
    if target_release is null or length(target_release)=0 then
        raise exception 'entry enforcement requires a release identity';
    end if;
    -- A provider call outlives its claiming transaction. Drain it while all
    -- sockets still use compatibility semantics, before issuing owned entries.
    if exists (select 1 from sync_external_operations where operation_name='participant_leave'
               and status='pending' and attempt_count > 0) then
        raise exception 'entry enforcement requires claimed Leaves to finish' using errcode='55000';
    end if;
    update sync_entry_rollout set enforced=true,enforced_at=clock_timestamp(),release_id=target_release
      where singleton;
end;
$$;
-- +goose StatementEnd

create table automatic_transcript_tenant_policy_backup (
    tenant_id uuid primary key,
    transcription_ceiling text not null,
    transcription_default_mode text not null,
    provider_policy_version text not null,
    source_window_seconds bigint not null,
    updated_at timestamptz not null
);

create table automatic_transcript_space_policy_backup (
    space_id uuid primary key,
    tenant_id uuid not null,
    transcription_policy text not null,
    updated_at timestamptz not null
);

create table episode_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    expires_at timestamptz not null,
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete cascade
);

create table sync_presence_runtime (
    singleton boolean primary key default true check (singleton),
    recover_after timestamptz not null
);
insert into sync_presence_runtime(singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

create table participant_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    generation bigint not null,
    expires_at timestamptz not null,
    primary key (tenant_id, space_id, episode_id, participant_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);
create index participant_presence_leases_expiry_idx on participant_presence_leases(expires_at);
