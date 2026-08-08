-- +goose Up
-- Provider-operation receipts are intentionally separate from Sync's durable
-- intents. The receipt is committed before a provider call so a dispatching
-- row is evidence that an uncertain call must be reconciled, not replayed.
create table provider_operation_receipts (
    operation_id text not null,
    effect text not null,
    tenant_id uuid not null references tenants(id) on delete restrict,
    session_id uuid not null references room_sessions(id) on delete restrict,
    participant_session_id uuid,
    participant_session_generation bigint,
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
        'media.remove_participant', 'media.end_session',
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
        (participant_session_id is not null or participant_session_generation is null)
        and (participant_session_generation is null or participant_session_generation > 0)
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
            and participant_session_id is not null
            and publication_source is not null
            and recording_id is null
        )
        or (
            effect = 'media.remove_participant'
            and participant_session_id is not null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect = 'media.end_session'
            and participant_session_id is null
            and publication_source is null
            and recording_id is null
        )
        or (
            effect in ('recording.start', 'recording.stop')
            and participant_session_id is null
            and publication_source is null
            and recording_id is not null
        )
    )
);

create index provider_operation_receipts_session_idx
    on provider_operation_receipts(tenant_id, session_id, created_at desc, operation_id, effect);
create index provider_operation_receipts_reconciliation_idx
    on provider_operation_receipts(state, created_at, operation_id, effect)
    where state in ('prepared', 'dispatching');

create table provider_operation_observation_heads (
    tenant_id uuid not null references tenants(id) on delete restrict,
    session_id uuid not null references room_sessions(id) on delete restrict,
    incarnation bigint not null default 0,
    sequence bigint not null default 0,
    observation_fingerprint bytea not null default decode(repeat('00', 32), 'hex'),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id),
    constraint provider_operation_observation_heads_cursor_check check (
        incarnation >= 0 and sequence >= 0
    ),
    constraint provider_operation_observation_heads_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);

create table provider_operation_observations (
    tenant_id uuid not null references tenants(id) on delete restrict,
    session_id uuid not null references room_sessions(id) on delete restrict,
    incarnation bigint not null,
    sequence bigint not null,
    publications jsonb not null,
    observation_fingerprint bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, incarnation, sequence),
    constraint provider_operation_observations_cursor_check check (incarnation >= 0 and sequence >= 0),
    constraint provider_operation_observations_publications_check check (
        jsonb_typeof(publications) = 'array' and octet_length(publications::text) <= 16384
    ),
    constraint provider_operation_observations_fingerprint_check check (octet_length(observation_fingerprint) = 32)
);

create index provider_operation_observations_session_cursor_idx
    on provider_operation_observations(tenant_id, session_id, incarnation, sequence);

-- +goose Down
drop table provider_operation_observations;
drop table provider_operation_observation_heads;
drop table provider_operation_receipts;
