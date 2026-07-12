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

create table rooms (
    id uuid primary key,
    name text not null,
    tenant_id uuid not null references tenants(id),
    status text not null,
    slug text not null,
    -- cf_sfu, cf_rtk, mediasoup
    media_plane text not null,
    metadata jsonb,
    -- recurring_policy is null for non-recurring rooms.
    -- Example:
    -- {
    --   "timezone": "Asia/Dubai",
    --   "dtstart": "2026-07-01T09:00:00",
    --   "rrule": "FREQ=WEEKLY;BYDAY=MO,WE"
    -- }
    recurring_policy jsonb,
    created_by_user_id uuid references users(id),
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, slug)
);
create index rooms_tenant_created_at_id_idx on rooms(tenant_id, created_at desc, id desc);

create table room_sessions (
    id uuid primary key,
    status text not null check (status in ('active', 'ending', 'ended')),
    metadata jsonb,
    room_id uuid not null references rooms(id),
    tenant_id uuid not null references tenants(id),
    created_by_user_id uuid references users(id),
    started_at timestamptz,
    ended_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, room_id, id)
);
create index room_sessions_tenant_room_created_at_id_idx on room_sessions(tenant_id, room_id, created_at desc, id desc);
create index room_sessions_sync_ended_cleanup_idx
    on room_sessions(ended_at, tenant_id, id)
    where status = 'ended';

create table session_create_requests (
    tenant_id uuid not null,
    room_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    session_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, room_id, request_key),
    foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
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
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
    user_id uuid references users(id),
    generation bigint not null check (generation > 0),
    status text not null check (status in ('joining', 'active', 'leaving', 'left')),
    joined_at timestamptz,
    left_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, room_id, session_id, id),
    foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete restrict
);
create index participants_sync_active_session_capacity_idx
    on participants(tenant_id, room_id, session_id)
    where status in ('joining', 'active', 'leaving');

create table sync_session_control (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
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
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id),
    unique (tenant_id, room_id, session_id),
    foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
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
        )
    )
);

create table sync_lifecycle_intents (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    lifecycle_intent_id uuid primary key,
    request_key text not null check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    intent_name text not null,
    participant_session_id uuid,
    participant_session_generation bigint,
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
    unique (tenant_id, room_id, session_id, lifecycle_intent_id),
    unique (tenant_id, session_id, intent_name, request_key),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (tenant_id, room_id, session_id, participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict,
    check (
        (
            intent_name in ('participant_joined', 'participant_left')
            and participant_session_id is not null
            and participant_session_generation > 0
        )
        or (
            intent_name = 'session_ended'
            and participant_session_id is null
            and participant_session_generation is null
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
                'superseded_by_session_end',
                'participant_already_terminal',
                'participant_generation_replaced'
            )
            and applied_event_id is null
            and applied_revision is null
            and completed_at is not null
        )
    )
);
create unique index sync_lifecycle_intents_session_end_key
    on sync_lifecycle_intents(tenant_id, session_id)
    where intent_name = 'session_ended';
create unique index sync_lifecycle_intents_participant_transition_key
    on sync_lifecycle_intents(
        tenant_id,
        session_id,
        intent_name,
        participant_session_id,
        participant_session_generation
    )
    where intent_name in ('participant_joined', 'participant_left');
create index sync_lifecycle_intents_pending_attempt_idx
    on sync_lifecycle_intents(next_attempt_at, attempt_count, created_at, lifecycle_intent_id)
    where status = 'pending';
create index sync_lifecycle_intents_session_pending_idx
    on sync_lifecycle_intents(tenant_id, session_id)
    where status = 'pending';

create table sync_control_events (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    event_id uuid not null unique,
    base_revision bigint not null,
    revision bigint not null,
    event_name text not null,
    payload jsonb not null,
    actor_participant_session_id uuid,
    actor_generation bigint,
    command_id text,
    lifecycle_intent_id uuid,
    event_schema_version integer not null check (event_schema_version > 0),
    resulting_state_digest bytea not null check (octet_length(resulting_state_digest) = 32),
    encoded_bytes integer not null check (encoded_bytes between 1 and 32768),
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, revision),
    unique (tenant_id, session_id, lifecycle_intent_id, event_id, revision),
    unique (
        tenant_id,
        session_id,
        actor_participant_session_id,
        actor_generation,
        command_id,
        event_id,
        revision
    ),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (tenant_id, room_id, session_id, actor_participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict,
    check (base_revision >= 0 and revision = base_revision + 1),
    check (
        (
            command_id ~ '^[A-Za-z0-9_-]{16,64}$'
            and lifecycle_intent_id is null
            and actor_participant_session_id is not null
            and actor_generation > 0
        )
        or (
            command_id is null
            and lifecycle_intent_id is not null
            and actor_participant_session_id is null
            and actor_generation is null
        )
    )
);
create unique index sync_control_events_command_origin_key
    on sync_control_events(
        tenant_id,
        session_id,
        actor_participant_session_id,
        command_id
    )
    where command_id is not null;
create unique index sync_control_events_lifecycle_origin_key
    on sync_control_events(tenant_id, session_id, lifecycle_intent_id)
    where lifecycle_intent_id is not null;

create table sync_command_receipts (
    tenant_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    submitted_generation bigint not null check (submitted_generation > 0),
    command_id text not null check (command_id ~ '^[A-Za-z0-9_-]{16,64}$'),
    request_fingerprint bytea not null check (octet_length(request_fingerprint) = 32),
    command_name text not null check (command_name in ('raise_hand', 'lower_hand')),
    outcome text not null,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, participant_session_id, command_id),
    foreign key (tenant_id, session_id)
        references sync_session_control(tenant_id, session_id)
        on delete restrict,
    foreign key (
        tenant_id,
        session_id,
        participant_session_id,
        submitted_generation,
        command_id,
        event_id,
        resulting_revision
    )
    references sync_control_events(
        tenant_id,
        session_id,
        actor_participant_session_id,
        actor_generation,
        command_id,
        event_id,
        revision
    )
    on delete restrict,
    check (
        (
            outcome = 'committed'
            and rejection_reason is null
            and event_id is not null
            and resulting_revision > 0
        )
        or (
            outcome = 'rejected'
            and rejection_reason in (
                'session_ended',
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
);

alter table sync_lifecycle_intents
    add foreign key (
        tenant_id,
        session_id,
        lifecycle_intent_id,
        applied_event_id,
        applied_revision
    )
    references sync_control_events(
        tenant_id,
        session_id,
        lifecycle_intent_id,
        event_id,
        revision
    )
    on delete restrict;

create table recordings (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
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
create index recordings_tenant_session_created_at_id_idx on recordings(tenant_id, session_id, created_at desc, id desc);

create table transcriptions (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    recording_id uuid not null references recordings(id),
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
    -- pending (should be rare ideally), processing, completed, failed
    status text not null,
    -- cf, openrouter, openai, groq
    provider text not null,
    model text not null,
    languages text[] not null,
    text text,
    metadata jsonb,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index transcriptions_tenant_created_at_id_idx on transcriptions(tenant_id, created_at desc, id desc);
create index transcriptions_tenant_recording_created_at_id_idx on transcriptions(tenant_id, recording_id, created_at desc, id desc);

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
