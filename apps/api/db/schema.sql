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
    cors_allowed_origins text[] not null default '{}',
    constraint tenants_cors_allowed_origins_count_check
        check (cardinality(cors_allowed_origins) <= 32),
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
    tenant_access_id uuid not null references memberships(id) deferrable initially deferred,
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
create unique index participants_dashboard_account_episode_idx
    on participants(tenant_id, episode_id, account_id)
    where account_id is not null;
create index participants_dashboard_account_space_idx
    on participants(tenant_id, space_id, account_id, created_at desc)
    where account_id is not null;

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

create table space_public_invites (
    tenant_id uuid not null,
    space_id uuid not null,
    handle bytea not null,
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
            and event_encoded_bytes between 2 and 262144
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
    constraint audit_logs_actor_type_check
        check (actor_type in ('user', 'api_key', 'system', 'operator')),
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

create table status_monitor_results (
    result_key text primary key,
    run_id text not null,
    monitor_key text not null,
    status text not null,
    checked_at timestamptz not null,
    event_at timestamptz not null,
    latency_ms bigint not null,
    http_status integer,
    error_code text,
    error_message text,
    response_excerpt text,
    reported_source text not null,
    reported_emitter_id text not null,
    metadata jsonb not null default '{}'::jsonb,
    details jsonb not null default '{}'::jsonb,
    received_at timestamptz not null default now(),
    constraint status_monitor_results_result_key_check check (octet_length(result_key) between 1 and 256),
    constraint status_monitor_results_run_id_check check (octet_length(run_id) between 1 and 128),
    constraint status_monitor_results_monitor_key_check check (octet_length(monitor_key) between 1 and 128),
    constraint status_monitor_results_status_check check (status in ('healthy', 'failed')),
    constraint status_monitor_results_latency_check check (latency_ms between 0 and 120000),
    constraint status_monitor_results_http_status_check check (http_status is null or http_status between 100 and 599),
    constraint status_monitor_results_error_code_check check (error_code is null or octet_length(error_code) <= 512),
    constraint status_monitor_results_error_message_check check (error_message is null or octet_length(error_message) <= 512),
    constraint status_monitor_results_response_excerpt_check check (response_excerpt is null or octet_length(response_excerpt) <= 512),
    constraint status_monitor_results_source_check check (octet_length(reported_source) between 1 and 128),
    constraint status_monitor_results_emitter_check check (octet_length(reported_emitter_id) between 1 and 128),
    constraint status_monitor_results_metadata_check check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
    constraint status_monitor_results_details_check check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 16384)
);

create index status_monitor_results_monitor_checked_idx
    on status_monitor_results(monitor_key, checked_at desc, result_key);

create table status_monitor_current (
    monitor_key text primary key,
    result_key text not null references status_monitor_results(result_key) on delete restrict,
    run_id text not null,
    status text not null,
    checked_at timestamptz not null,
    last_changed_at timestamptz not null,
    received_at timestamptz not null,
    constraint status_monitor_current_monitor_key_check check (octet_length(monitor_key) between 1 and 128),
    constraint status_monitor_current_run_id_check check (octet_length(run_id) between 1 and 128),
    constraint status_monitor_current_status_check check (status in ('healthy', 'failed'))
);
create table diagnostic_environment_ownership (
    id smallint primary key check (id = 1),
    environment text not null check (environment in ('localhost', 'development', 'staging', 'production')),
    claimed_at timestamptz not null default now()
);

-- Episode diagnostics are deliberately separate from the bounded Journey ledger.
-- Every child carries tenant_id and diagnostic_id so a row cannot be moved across
-- tenant boundaries by an otherwise valid UUID.
create table episode_diagnostics (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null,
    episode_id uuid not null,
    environment text not null check (environment in ('localhost', 'development', 'staging', 'production')),
    state text not null default 'live' check (state in ('live', 'ended', 'complete', 'expired')),
    episode_started_at timestamptz not null,
    episode_ended_at timestamptz,
    epilogue_completed_at timestamptz,
    expires_at timestamptz,
    run_end_cursor bigint,
    committed_cursor bigint not null default 0,
    config_snapshot jsonb not null default '{}'::jsonb,
    retention_claim_token uuid,
    retention_claimed_until timestamptz,
    retention_attempts integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint episode_diagnostics_tenant_id_id_key unique (tenant_id, id),
    constraint episode_diagnostics_tenant_id_episode_id_key unique (tenant_id, episode_id),
    constraint episode_diagnostics_episode_fkey
        foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete restrict,
    constraint episode_diagnostics_cursor_check check (
        committed_cursor >= 0
        and (run_end_cursor is null or run_end_cursor >= 0)
    ),
    constraint episode_diagnostics_snapshot_check check (jsonb_typeof(config_snapshot) = 'object'),
    constraint episode_diagnostics_retention_check check (
        retention_attempts >= 0
        and (
            (retention_claim_token is null and retention_claimed_until is null)
            or (retention_claim_token is not null and retention_claimed_until is not null)
        )
    ),
    constraint episode_diagnostics_state_dates_check check (
        (state = 'live' and episode_ended_at is null and epilogue_completed_at is null)
        or (state = 'ended' and episode_ended_at is not null and epilogue_completed_at is null)
        or (state in ('complete', 'expired') and episode_ended_at is not null and epilogue_completed_at is not null)
    ),
    constraint episode_diagnostics_expiry_check check (
        (state in ('live', 'ended') and expires_at is null)
        or (state = 'complete' and expires_at is not null)
        or state = 'expired'
    )
);

create index episode_diagnostics_tenant_created_idx
    on episode_diagnostics(tenant_id, created_at desc, id desc);
create index episode_diagnostics_reconciliation_idx
    on episode_diagnostics(tenant_id, episode_started_at, episode_id)
    where state in ('live', 'ended');
create index episode_diagnostics_retention_claim_idx
    on episode_diagnostics(expires_at, retention_claimed_until, tenant_id, id)
    where state = 'complete';

create table episode_diagnostic_cursor_heads (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    committed_cursor bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id),
    constraint episode_diagnostic_cursor_heads_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint episode_diagnostic_cursor_heads_cursor_check check (committed_cursor >= 0)
);

create table diagnostic_branches (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    id uuid not null,
    kind text not null check (kind in ('cleanup', 'recording', 'transcription', 'artifact', 'webhook')),
    state text not null default 'pending'
        check (state in ('pending', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
    lease_ends_at timestamptz not null,
    started_at timestamptz,
    terminal_at timestamptz,
    terminal_cursor bigint,
    attempts integer not null default 0,
    fan_in_children jsonb not null default '[]'::jsonb,
    late_observations integer not null default 0,
    unknown_reason text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, id),
    constraint diagnostic_branches_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_branches_cursor_check check (terminal_cursor is null or terminal_cursor > 0),
    constraint diagnostic_branches_attempt_check check (attempts >= 0 and late_observations >= 0),
    constraint diagnostic_branches_children_check check (jsonb_typeof(fan_in_children) = 'array'),
    constraint diagnostic_branches_unknown_reason_check check (
        unknown_reason is null or unknown_reason in (
            'not_retained', 'not_observable', 'redacted', 'provider_opaque', 'expired',
            'not_available', 'invalid', 'diagnostics_disabled', 'permission_denied', 'unknown'
        )
    ),
    constraint diagnostic_branches_terminal_state_check check (
        (state in ('pending', 'running') and terminal_at is null and terminal_cursor is null)
        or (state in ('succeeded', 'failed', 'cancelled', 'timed_out') and terminal_at is not null)
    )
);

create index diagnostic_branches_deadline_idx
    on diagnostic_branches(lease_ends_at, tenant_id, diagnostic_id, id)
    where state in ('pending', 'running');
create index diagnostic_branches_diagnostic_state_idx
    on diagnostic_branches(tenant_id, diagnostic_id, state, created_at, id);

create table diagnostic_operations (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    id uuid not null,
    parent_id uuid,
    branch_id uuid,
    participant_id uuid,
    producer_operation_ref text,
    parent_producer_operation_ref text,
    kind text not null,
    expectation_version integer not null default 1,
    state text not null default 'running'
        check (state in ('running', 'retrying', 'succeeded', 'failed', 'stalled', 'cancelled', 'timed_out')),
    retry_group_id uuid,
    retry_group_ref text,
    attempt integer not null default 1,
    started_at timestamptz not null,
    deadline_at timestamptz,
    grace_ends_at timestamptz,
    ended_at timestamptz,
    error_class text,
    source text not null check (source in ('ui', 'sdk', 'api', 'sync', 'rtc', 'provider', 'worker')),
    release_id text,
    source_commit text,
    request_id text,
    command_id text,
    provider_id text,
    journey_id text,
    trace_id text,
    span_id text,
    clock_uncertainty text,
    visibility_gaps jsonb not null default '[]'::jsonb,
    first_evidence_cursor bigint not null default 0,
    last_evidence_cursor bigint,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, id),
    constraint diagnostic_operations_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_operations_parent_fkey
        foreign key (tenant_id, diagnostic_id, parent_id)
        references diagnostic_operations(tenant_id, diagnostic_id, id)
        on delete restrict
        deferrable initially deferred,
    constraint diagnostic_operations_branch_fkey
        foreign key (tenant_id, diagnostic_id, branch_id)
        references diagnostic_branches(tenant_id, diagnostic_id, id)
        on delete restrict
        deferrable initially deferred,
    constraint diagnostic_operations_participant_check check (participant_id is null or participant_id <> '00000000-0000-0000-0000-000000000000'),
    constraint diagnostic_operations_producer_ref_check check (
        producer_operation_ref is null or producer_operation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$'
    ),
    constraint diagnostic_operations_parent_producer_ref_check check (
        parent_producer_operation_ref is null or parent_producer_operation_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$'
    ),
    constraint diagnostic_operations_kind_check check (kind ~ '^[a-z][a-z0-9_.-]{0,95}$'),
    constraint diagnostic_operations_expectation_check check (expectation_version between 1 and 255),
    constraint diagnostic_operations_attempt_check check (attempt > 0),
    constraint diagnostic_operations_first_evidence_cursor_check check (first_evidence_cursor >= 0),
    constraint diagnostic_operations_deadline_check check (
        (deadline_at is null or deadline_at >= started_at)
        and (grace_ends_at is null or deadline_at is not null and grace_ends_at >= deadline_at)
        and (ended_at is null or ended_at >= started_at)
    ),
    constraint diagnostic_operations_terminal_state_check check (
        (state in ('running', 'retrying', 'stalled') and ended_at is null)
        or (state in ('succeeded', 'failed', 'cancelled', 'timed_out') and ended_at is not null)
    ),
    constraint diagnostic_operations_visibility_gaps_check check (jsonb_typeof(visibility_gaps) = 'array'),
    constraint diagnostic_operations_cursor_check check (last_evidence_cursor is null or last_evidence_cursor > 0),
    constraint diagnostic_operations_trace_check check (
        (trace_id is null or trace_id ~ '^[0-9a-f]{32}$')
        and (span_id is null or span_id ~ '^[0-9a-f]{16}$')
    )
);

create unique index diagnostic_operations_producer_ref_idx
    on diagnostic_operations(tenant_id, diagnostic_id, producer_operation_ref)
    where producer_operation_ref is not null;
create index diagnostic_operations_deadline_idx
    on diagnostic_operations(deadline_at, tenant_id, diagnostic_id, id)
    where state in ('running', 'retrying');
create index diagnostic_operations_diagnostic_started_idx
    on diagnostic_operations(tenant_id, diagnostic_id, started_at, id);
create index diagnostic_operations_evidence_page_idx
    on diagnostic_operations(tenant_id, diagnostic_id, first_evidence_cursor, id);
create index diagnostic_operations_participant_idx
    on diagnostic_operations(tenant_id, diagnostic_id, participant_id, id)
    where participant_id is not null;
create index diagnostic_operations_trace_idx
    on diagnostic_operations(tenant_id, trace_id, span_id)
    where trace_id is not null and span_id is not null;

create table diagnostic_checkpoints (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    operation_id uuid not null,
    checkpoint_key text not null,
    class text not null check (class in ('required', 'conditional', 'best_effort')),
    display_order integer not null default 0,
    deadline_at timestamptz,
    state text not null default 'pending'
        check (state in ('pending', 'observed', 'missed', 'not_observable', 'late_observed')),
    evidence_cursor bigint,
    unknown_reason text,
    predicate text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, operation_id, checkpoint_key),
    constraint diagnostic_checkpoints_operation_fkey
        foreign key (tenant_id, diagnostic_id, operation_id)
        references diagnostic_operations(tenant_id, diagnostic_id, id)
        on delete cascade,
    constraint diagnostic_checkpoints_key_check check (checkpoint_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$'),
    constraint diagnostic_checkpoints_display_order_check check (display_order >= 0),
    constraint diagnostic_checkpoints_cursor_check check (evidence_cursor is null or evidence_cursor > 0),
    constraint diagnostic_checkpoints_unknown_reason_check check (
        unknown_reason is null or unknown_reason in (
            'not_retained', 'not_observable', 'redacted', 'provider_opaque', 'expired',
            'not_available', 'invalid', 'diagnostics_disabled', 'permission_denied', 'unknown'
        )
    )
);

create index diagnostic_checkpoints_deadline_idx
    on diagnostic_checkpoints(deadline_at, tenant_id, diagnostic_id, operation_id, checkpoint_key)
    where state = 'pending';

create table diagnostic_issues (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    id uuid not null,
    operation_id uuid,
    kind text not null,
    severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
    state text not null default 'open' check (state in ('open', 'resolved')),
    summary text not null,
    affected_kind text,
    affected_id_class text,
    affected_id_value text,
    affected_id_copyable boolean,
    last_confirmed_checkpoint text,
    missing_checkpoint text,
    first_observed_at timestamptz not null,
    last_observed_at timestamptz,
    resolved_at timestamptz,
    retry_state text,
    unknown_reason text,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, id),
    constraint diagnostic_issues_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_issues_operation_fkey
        foreign key (tenant_id, diagnostic_id, operation_id)
        references diagnostic_operations(tenant_id, diagnostic_id, id)
        on delete cascade
        deferrable initially deferred,
    constraint diagnostic_issues_kind_check check (kind ~ '^[a-z][a-z0-9_.-]{0,95}$'),
    constraint diagnostic_issues_summary_check check (char_length(summary) between 1 and 512),
    constraint diagnostic_issues_affected_check check (
        (affected_kind is null and affected_id_class is null and affected_id_value is null and affected_id_copyable is null)
        or (
            affected_kind ~ '^[a-z][a-z0-9_.-]{0,63}$'
            and affected_id_class ~ '^[a-z][a-z0-9_.-]{0,63}$'
            and (affected_id_value is null or affected_id_value ~ '^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$')
            and affected_id_copyable is not null
        )
    ),
    constraint diagnostic_issues_dates_check check (
        (last_observed_at is null or last_observed_at >= first_observed_at)
        and (resolved_at is null or resolved_at >= first_observed_at)
    ),
    constraint diagnostic_issues_state_dates_check check (
        (state = 'open' and resolved_at is null)
        or (state = 'resolved' and resolved_at is not null)
    ),
    constraint diagnostic_issues_unknown_reason_check check (
        unknown_reason is null or unknown_reason in (
            'not_retained', 'not_observable', 'redacted', 'provider_opaque', 'expired',
            'not_available', 'invalid', 'diagnostics_disabled', 'permission_denied', 'unknown'
        )
    )
);

create index diagnostic_issues_state_idx
    on diagnostic_issues(tenant_id, diagnostic_id, state, severity, first_observed_at, id);
create index diagnostic_issues_operation_idx
    on diagnostic_issues(tenant_id, diagnostic_id, operation_id, state)
    where operation_id is not null;

create table diagnostic_events (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    cursor bigint not null,
    event_id text not null,
    event_fingerprint text not null,
    event_version smallint not null default 1,
    operation_id uuid,
    producer_operation_ref text,
    parent_producer_operation_ref text,
    participant_id uuid,
    source text not null check (source in ('ui', 'sdk', 'api', 'sync', 'rtc', 'provider', 'worker')),
    name text not null,
    phase text not null,
    state text not null check (state in ('started', 'observed', 'succeeded', 'failed', 'cancelled', 'timed_out', 'not_observable', 'late_observed')),
    expectation_name text,
    expectation_version integer,
    checkpoint_key text,
    checkpoint_class text,
    deadline_at timestamptz,
    journey_id text,
    trace_id text,
    span_id text,
    request_id text,
    command_id text,
    provider_id text,
    retry_group_ref text,
    attempt integer,
    release_id text,
    source_commit text,
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    producer_sequence bigint not null,
    safe_attributes jsonb not null default '{}'::jsonb,
    primary key (tenant_id, diagnostic_id, cursor),
    constraint diagnostic_events_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_events_operation_fkey
        foreign key (tenant_id, diagnostic_id, operation_id)
        references diagnostic_operations(tenant_id, diagnostic_id, id)
        on delete set null (operation_id)
        deferrable initially deferred,
    constraint diagnostic_events_event_id_key unique (tenant_id, diagnostic_id, event_id),
    constraint diagnostic_events_cursor_check check (cursor > 0),
    constraint diagnostic_events_event_id_check check (event_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$'),
    constraint diagnostic_events_fingerprint_check check (event_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    constraint diagnostic_events_version_check check (event_version = 1),
    constraint diagnostic_events_name_check check (name ~ '^[a-z][a-z0-9_.-]{0,95}$'),
    constraint diagnostic_events_phase_check check (phase ~ '^[a-z][a-z0-9_.-]{0,47}$'),
    constraint diagnostic_events_expectation_check check (
        (expectation_name is null and expectation_version is null and checkpoint_key is null and checkpoint_class is null)
        or (
            expectation_name is not null
            and expectation_version between 1 and 255
            and checkpoint_key is not null
            and checkpoint_class in ('required', 'conditional', 'best_effort')
        )
    ),
    constraint diagnostic_events_attempt_check check (attempt is null or attempt between 0 and 1000000),
    constraint diagnostic_events_sequence_check check (producer_sequence >= 0),
    constraint diagnostic_events_attributes_check check (
        jsonb_typeof(safe_attributes) = 'object' and octet_length(safe_attributes::text) <= 2048
    ),
    constraint diagnostic_events_trace_check check (
        (trace_id is null or trace_id ~ '^[0-9a-f]{32}$')
        and (span_id is null or span_id ~ '^[0-9a-f]{16}$')
    )
);

create index diagnostic_events_received_at_brin_idx
    on diagnostic_events using brin (received_at);
create index diagnostic_events_producer_sequence_idx
    on diagnostic_events(tenant_id, diagnostic_id, source, producer_sequence, cursor);
create index diagnostic_events_operation_idx
    on diagnostic_events(tenant_id, diagnostic_id, operation_id, cursor)
    where operation_id is not null;
create index diagnostic_events_trace_idx
    on diagnostic_events(tenant_id, trace_id, span_id, cursor)
    where trace_id is not null and span_id is not null;
create index diagnostic_events_journey_idx
    on diagnostic_events(tenant_id, journey_id, cursor)
    where journey_id is not null;
create index diagnostic_events_name_state_idx
    on diagnostic_events(tenant_id, diagnostic_id, name, state, cursor);

-- Participant summaries are maintained once per accepted event. Snapshot and
-- export reads use this bounded projection instead of rescanning the ledger.
create table diagnostic_participant_projections (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    participant_id uuid not null,
    joined_at timestamptz,
    left_at timestamptz,
    latest_lifecycle_cursor bigint not null default 0,
    latest_lifecycle_name text not null default '',
    latest_lifecycle_state text not null default '',
    operation_count bigint not null default 0,
    issue_count bigint not null default 0,
    first_observed_at timestamptz not null,
    last_observed_at timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, participant_id),
    constraint diagnostic_participant_projections_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_participant_projections_cursor_check check (latest_lifecycle_cursor >= 0),
    constraint diagnostic_participant_projections_counts_check check (operation_count >= 0 and issue_count >= 0)
);

create index diagnostic_participant_projections_read_idx
    on diagnostic_participant_projections(tenant_id, diagnostic_id, participant_id);

create table diagnostic_references (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    reference_id uuid not null,
    id_class text not null,
    raw_value text,
    hmac_version text,
    value_hmac text,
    copyable boolean not null default false,
    unknown_reason text,
    event_cursor bigint,
    operation_id uuid,
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, reference_id),
    constraint diagnostic_references_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_references_event_fkey
        foreign key (tenant_id, diagnostic_id, event_cursor)
        references diagnostic_events(tenant_id, diagnostic_id, cursor)
        on delete set null (event_cursor)
        deferrable initially deferred,
    constraint diagnostic_references_operation_fkey
        foreign key (tenant_id, diagnostic_id, operation_id)
        references diagnostic_operations(tenant_id, diagnostic_id, id)
        on delete set null (operation_id)
        deferrable initially deferred,
    constraint diagnostic_references_class_check check (id_class ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)*$'),
    constraint diagnostic_references_value_check check (
        (raw_value is not null and value_hmac is null and hmac_version is null)
        or (raw_value is null and value_hmac is not null and hmac_version is not null)
    ),
    constraint diagnostic_references_copyable_check check (
        (copyable and raw_value is not null) or not copyable
    ),
    constraint diagnostic_references_unknown_reason_check check (
        unknown_reason is null or unknown_reason in (
            'not_retained', 'not_observable', 'redacted', 'provider_opaque', 'expired',
            'not_available', 'invalid', 'diagnostics_disabled', 'permission_denied', 'unknown'
        )
    )
);

create unique index diagnostic_references_raw_key
    on diagnostic_references(tenant_id, diagnostic_id, id_class, raw_value)
    where raw_value is not null;
create unique index diagnostic_references_hmac_key
    on diagnostic_references(tenant_id, id_class, hmac_version, value_hmac)
    where value_hmac is not null;
create index diagnostic_references_event_idx
    on diagnostic_references(tenant_id, diagnostic_id, event_cursor)
    where event_cursor is not null;

create table diagnostic_projector_offsets (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    projected_cursor bigint not null default 0,
    lease_token uuid,
    lease_owner text,
    lease_until timestamptz,
    failure_count integer not null default 0,
    last_error_class text,
    last_error_at timestamptz,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id),
    constraint diagnostic_projector_offsets_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_projector_offsets_cursor_check check (projected_cursor >= 0),
    constraint diagnostic_projector_offsets_failure_check check (failure_count >= 0),
    constraint diagnostic_projector_offsets_lease_check check (
        (lease_token is null and lease_owner is null and lease_until is null)
        or (lease_token is not null and lease_owner is not null and lease_until is not null)
    )
);

create index diagnostic_projector_offsets_claim_idx
    on diagnostic_projector_offsets(lease_until, updated_at, tenant_id, diagnostic_id);

create table diagnostic_projection_changes (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    cursor bigint not null,
    ordinal integer not null,
    kind text not null check (kind in (
        'event_appended', 'operation_updated', 'issue_updated', 'branch_updated', 'snapshot', 'gap'
    )),
    entity_type text,
    entity_id text,
    payload jsonb not null,
    schema_version text not null default 'DiagnosticStreamDelta/v1',
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, cursor),
    constraint diagnostic_projection_changes_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_projection_changes_cursor_check check (cursor > 0 and ordinal >= 0),
    constraint diagnostic_projection_changes_ordinal_check check (ordinal = 0),
    constraint diagnostic_projection_changes_entity_check check (
        (entity_type is null and entity_id is null)
        or (
            entity_type ~ '^[a-z][a-z0-9_.-]{0,63}$'
            and entity_id is not null
            and entity_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@+/=-]{0,127}$'
        )
    ),
    constraint diagnostic_projection_changes_payload_check check (
        jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
    ),
    constraint diagnostic_projection_changes_schema_check check (schema_version = 'DiagnosticStreamDelta/v1')
);

create index diagnostic_projection_changes_cursor_idx
    on diagnostic_projection_changes(tenant_id, diagnostic_id, cursor, ordinal);

create table diagnostic_projector_dead_letters (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    id uuid not null,
    event_cursor bigint not null,
    event_id text,
    error_class text not null,
    error_reason text not null,
    attempt_count integer not null default 1,
    state text not null default 'pending' check (state in ('pending', 'replayed', 'discarded')),
    replayed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, id),
    constraint diagnostic_projector_dead_letters_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_projector_dead_letters_event_cursor_check check (event_cursor > 0),
    constraint diagnostic_projector_dead_letters_attempt_check check (attempt_count > 0),
    constraint diagnostic_projector_dead_letters_error_check check (
        char_length(error_class) between 1 and 96 and char_length(error_reason) between 1 and 512
    ),
    constraint diagnostic_projector_dead_letters_replayed_check check (
        (state = 'replayed' and replayed_at is not null) or (state <> 'replayed' and replayed_at is null)
    )
);

create unique index diagnostic_projector_dead_letters_event_key
    on diagnostic_projector_dead_letters(tenant_id, diagnostic_id, event_cursor)
    where state = 'pending';
create index diagnostic_projector_dead_letters_pending_idx
    on diagnostic_projector_dead_letters(tenant_id, diagnostic_id, created_at, id)
    where state = 'pending';

create table diagnostic_export_jobs (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    id uuid not null,
    state text not null default 'queued'
        check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
    cursor_from bigint not null,
    cursor_to bigint,
    lease_token uuid,
    lease_owner text,
    lease_ends_at timestamptz not null,
    operator_subject_hash text not null,
    journey_id uuid,
    trace_id text,
    span_id text,
    download_expires_at timestamptz,
    manifest jsonb,
    processed_events bigint not null default 0,
    total_events bigint,
    current_cursor bigint,
    error_reason text,
    object_key text,
    artifact_payload bytea,
    artifact_content_type text,
    artifact_checksum text,
    artifact_size bigint,
    cancelled_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, id),
    constraint diagnostic_export_jobs_diagnostic_fkey
        foreign key (tenant_id, diagnostic_id)
        references episode_diagnostics(tenant_id, id)
        on delete cascade,
    constraint diagnostic_export_jobs_cursor_check check (
        cursor_from >= 0 and (cursor_to is null or cursor_to >= cursor_from)
    ),
    constraint diagnostic_export_jobs_progress_check check (
        processed_events >= 0
        and (total_events is null or total_events >= 0)
        and (current_cursor is null or current_cursor >= cursor_from)
    ),
    constraint diagnostic_export_jobs_lease_check check (
        (state = 'running' and lease_token is not null and lease_owner is not null)
        or (state <> 'running' and lease_token is null and lease_owner is null)
    ),
    constraint diagnostic_export_jobs_terminal_check check (
        (state in ('queued', 'running') and completed_at is null and cancelled_at is null)
        or (state in ('succeeded', 'failed', 'expired') and completed_at is not null and cancelled_at is null)
        or (state = 'cancelled' and cancelled_at is not null and completed_at is not null)
    ),
    constraint diagnostic_export_jobs_manifest_check check (
        manifest is null or jsonb_typeof(manifest) = 'object'
    ),
    constraint diagnostic_export_jobs_trace_check check (
        (trace_id is null or trace_id ~ '^[0-9a-f]{32}$')
        and (span_id is null or span_id ~ '^[0-9a-f]{16}$')
    ),
    constraint diagnostic_export_jobs_operator_hash_check check (operator_subject_hash ~ '^[0-9a-f]{64}$'),
    constraint diagnostic_export_jobs_artifact_check check (
        artifact_size is null
        or (
            artifact_size >= 0
            and (
                (artifact_payload is not null and artifact_size = octet_length(artifact_payload))
                or (artifact_payload is null and state = 'succeeded')
            )
        )
    ),
    constraint diagnostic_export_jobs_artifact_payload_limit check (
        artifact_payload is null or octet_length(artifact_payload) <= 33554432
    )
);

create index diagnostic_export_jobs_claim_idx
    on diagnostic_export_jobs(state, lease_ends_at, created_at, tenant_id, diagnostic_id, id)
    where state in ('queued', 'running');
create index diagnostic_export_jobs_diagnostic_idx
    on diagnostic_export_jobs(tenant_id, diagnostic_id, created_at desc, id desc);

-- Export payloads are streamed through gzip and persisted as independently
-- bounded chunks. A worker can resume/reclaim a lease without materializing a
-- million-event bundle in one bytea value.
create table diagnostic_export_artifact_chunks (
    tenant_id uuid not null,
    diagnostic_id uuid not null,
    job_id uuid not null,
    part_index integer not null,
    payload bytea not null,
    checksum text not null,
    byte_size bigint not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, diagnostic_id, job_id, part_index),
    constraint diagnostic_export_chunks_job_fkey
        foreign key (tenant_id, diagnostic_id, job_id)
        references diagnostic_export_jobs(tenant_id, diagnostic_id, id)
        on delete cascade,
    constraint diagnostic_export_chunks_index_check check (part_index >= 0),
    constraint diagnostic_export_chunks_size_check check (
        byte_size = octet_length(payload)
        and byte_size > 0
        and byte_size <= 8388608
    ),
    constraint diagnostic_export_chunks_checksum_check check (checksum ~ '^[0-9a-f]{64}$')
);

create index diagnostic_export_chunks_job_idx
    on diagnostic_export_artifact_chunks(tenant_id, diagnostic_id, job_id, part_index);

create table feedback_reports (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    category text not null check (category in ('bug', 'feature_request', 'other')),
    source text not null check (source in ('embedded', 'chalk_web', 'chalk_mobile', 'dashboard')),
    message text not null check (octet_length(message) between 1 and 8000),
    submitter_kind text not null check (submitter_kind in ('account', 'participant')),
    submitter_id text not null check (char_length(submitter_id) between 1 and 256),
    user_id uuid references users(id) on delete restrict,
    space_id uuid,
    episode_id uuid,
    participant_id uuid,
    environment text,
    audience text,
    diagnostic_reference text,
    journey_id uuid,
    root_journey_id uuid,
    trace_id text,
    span_id text,
    request_id text,
    command_id text,
    submission_journey_id uuid,
    submission_trace_id text,
    submission_span_id text,
    idempotency_key text not null check (char_length(idempotency_key) between 16 and 128 and idempotency_key ~ '^[A-Za-z0-9_-]+$'),
    request_digest bytea not null check (octet_length(request_digest) = 32),
    evidence_object_key text not null,
    evidence_content_type text not null default 'application/json',
    evidence_size bigint not null check (evidence_size > 0 and evidence_size <= 131072),
    evidence_sha256 bytea not null check (octet_length(evidence_sha256) = 32),
    evidence_schema_version text not null check (evidence_schema_version = 'FeedbackEvidence/v1'),
    screenshot_object_key text,
    screenshot_content_type text,
    screenshot_size bigint,
    screenshot_sha256 bytea,
    screenshot_width integer,
    screenshot_height integer,
    screenshot_captured_at timestamptz,
    screenshot_failure_code text,
    created_at timestamptz not null default now(),
    submitted_at timestamptz not null default now(),
    constraint feedback_reports_screenshot_metadata_check check (
        (screenshot_object_key is null and screenshot_content_type is null and screenshot_size is null and screenshot_sha256 is null and screenshot_width is null and screenshot_height is null and screenshot_captured_at is null)
        or (screenshot_object_key is not null and screenshot_content_type in ('image/jpeg', 'image/png', 'image/webp') and screenshot_size > 0 and screenshot_size <= 460800 and screenshot_sha256 is not null and octet_length(screenshot_sha256) = 32 and screenshot_width between 1 and 1920 and screenshot_height between 1 and 1080 and screenshot_captured_at is not null)
    ),
    constraint feedback_reports_screenshot_failure_code_check check (screenshot_failure_code is null or screenshot_failure_code in ('capture_failed', 'unsupported', 'tainted', 'secure_surface', 'too_large')),
    constraint feedback_reports_trace_id_check check (trace_id is null or trace_id ~ '^[0-9a-f]{32}$'),
    constraint feedback_reports_span_id_check check (span_id is null or span_id ~ '^[0-9a-f]{16}$'),
    constraint feedback_reports_submission_trace_id_check check (submission_trace_id is null or submission_trace_id ~ '^[0-9a-f]{32}$'),
    constraint feedback_reports_submission_span_id_check check (submission_span_id is null or submission_span_id ~ '^[0-9a-f]{16}$')
);

create unique index feedback_reports_submitter_idempotency_idx
    on feedback_reports(tenant_id, submitter_kind, submitter_id, idempotency_key);
create index feedback_reports_operator_created_idx
    on feedback_reports(created_at desc, id desc);
create index feedback_reports_tenant_created_idx
    on feedback_reports(tenant_id, created_at desc, id desc);
create index feedback_reports_category_source_idx
    on feedback_reports(category, source, created_at desc, id desc);
