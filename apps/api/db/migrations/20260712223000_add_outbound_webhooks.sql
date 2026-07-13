-- +goose Up
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
create index webhook_endpoints_previous_secret_expiry_idx
    on webhook_endpoints(previous_secret_expires_at, tenant_id, id)
    where previous_secret_expires_at is not null;
create index webhook_endpoints_deleted_retention_idx
    on webhook_endpoints(deleted_at, tenant_id, id)
    where deleted_at is not null;

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
create index webhook_deliveries_tenant_state_idx
    on webhook_deliveries(tenant_id, state, created_at, id);
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

-- +goose Down
drop table webhook_idempotency_records;
drop table webhook_delivery_attempts;
drop table webhook_deliveries;
drop table webhook_events;
alter table webhook_endpoints
    drop constraint webhook_endpoints_current_revision_fkey;
drop table webhook_endpoint_revisions;
drop table webhook_endpoints;
drop table webhook_tenant_state;

alter table sync_lifecycle_intents
    drop constraint sync_lifecycle_intents_span_id_check,
    drop constraint sync_lifecycle_intents_trace_id_check,
    drop column producing_span_id,
    drop column producing_trace_id,
    drop column parent_journey_event_id,
    drop column journey_id;
