-- +goose Up
create table recording_capacity (
    id smallint primary key check (id = 1),
    reserved_meetings integer not null default 0 check (reserved_meetings between 0 and 20),
    reserved_participants integer not null default 0 check (reserved_participants between 0 and 100),
    reserved_input_bitrate_bps bigint not null default 0 check (reserved_input_bitrate_bps >= 0),
    updated_at timestamptz not null default now()
);

insert into recording_capacity (id) values (1);

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
    room_id uuid not null references rooms(id),
    session_id uuid not null references room_sessions(id),
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
    session_id uuid not null references room_sessions(id),
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

-- +goose Down
drop trigger if exists recording_artifacts_immutable on recording_artifacts;
drop trigger if exists recording_bundles_immutable on recording_bundles;
drop function if exists reject_recording_object_mutation();
drop table recording_artifacts;
drop table recording_bundles;
drop table recording_jobs;
drop table recording_pipelines;
drop table recording_reservations;
drop table recording_pool_health;
drop table recording_capacity;
