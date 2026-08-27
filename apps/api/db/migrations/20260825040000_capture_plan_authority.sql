-- +goose Up
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

-- +goose StatementBegin
create function reject_recording_capture_plan_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording capture plans are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_capture_plans_immutable
before update or delete on recording_capture_plans
for each row execute function reject_recording_capture_plan_mutation();

create trigger recording_capture_plans_no_truncate
before truncate on recording_capture_plans
for each statement execute function reject_recording_capture_plan_mutation();

-- +goose Down
drop trigger if exists recording_capture_plans_no_truncate on recording_capture_plans;
drop trigger if exists recording_capture_plans_immutable on recording_capture_plans;
drop function if exists reject_recording_capture_plan_mutation();
drop table if exists recording_capture_plans;
