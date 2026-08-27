-- +goose Up
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

-- +goose StatementBegin
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
-- +goose StatementEnd

-- +goose StatementBegin
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
-- +goose StatementEnd

-- +goose StatementBegin
create function reject_recording_capture_queue_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture signaling authority cannot be deleted or truncated';
end;
$$;
-- +goose StatementEnd

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

-- +goose Down
drop trigger if exists recording_capture_commands_no_truncate on recording_capture_commands;
drop trigger if exists recording_capture_commands_no_delete on recording_capture_commands;
drop trigger if exists recording_capture_commands_authority_immutable on recording_capture_commands;
drop trigger if exists recording_capture_connections_no_truncate on recording_capture_connections;
drop trigger if exists recording_capture_connections_no_delete on recording_capture_connections;
drop trigger if exists recording_capture_connections_authority_immutable on recording_capture_connections;
drop function if exists reject_recording_capture_queue_delete();
drop function if exists protect_recording_capture_command();
drop function if exists protect_recording_capture_connection_authority();

drop table if exists recording_capture_provider_rate_budget;
alter table recording_capture_connections
    drop constraint if exists recording_capture_connections_active_command_fkey;
drop table if exists recording_capture_commands;
drop table if exists recording_capture_connections;

alter table recording_job_attempt_authorities
    drop constraint if exists recording_job_attempt_authorities_capture_epoch_key;
