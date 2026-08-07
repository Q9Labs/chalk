-- +goose Up

create table diagnostic_environment_ownership (
    id smallint primary key check (id = 1),
    environment text not null check (environment in ('localhost', 'development', 'staging')),
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
    environment text not null check (environment in ('localhost', 'development', 'staging')),
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

-- +goose Down
drop table if exists diagnostic_environment_ownership cascade;
drop table if exists diagnostic_export_artifact_chunks cascade;
drop table if exists diagnostic_export_jobs cascade;
drop table if exists diagnostic_projector_dead_letters cascade;
drop table if exists diagnostic_projection_changes cascade;
drop table if exists diagnostic_projector_offsets cascade;
drop table if exists diagnostic_references cascade;
drop table if exists diagnostic_events cascade;
drop table if exists diagnostic_issues cascade;
drop table if exists diagnostic_checkpoints cascade;
drop table if exists diagnostic_operations cascade;
drop table if exists diagnostic_branches cascade;
drop table if exists episode_diagnostic_cursor_heads cascade;
drop table if exists episode_diagnostics cascade;
