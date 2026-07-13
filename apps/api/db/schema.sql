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
    session_id uuid references room_sessions(id),
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
            'room.created',
            'room.updated',
            'room.archived',
            'room.restored',
            'session.started',
            'session.ended',
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
        'room.created',
        'room.updated',
        'room.archived',
        'room.restored',
        'session.started',
        'session.ended',
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
        'room', 'session', 'participant', 'recording', 'transcript', 'webhook_endpoint'
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
