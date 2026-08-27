-- +goose Up
alter table recording_pipelines
    add column capture_epoch bigint not null default 0,
    add constraint recording_pipelines_capture_epoch_check
        check (capture_epoch >= 0);

create table recording_job_attempt_authorities (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    claim_request_id uuid not null unique,
    kind text not null check (kind in ('capture', 'render')),
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

-- +goose StatementBegin
create function reject_recording_job_attempt_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording job attempt authorities are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_job_attempt_authorities_immutable
before update or delete on recording_job_attempt_authorities
for each row execute function reject_recording_job_attempt_authority_mutation();

create trigger recording_job_attempt_authorities_no_truncate
before truncate on recording_job_attempt_authorities
for each statement execute function reject_recording_job_attempt_authority_mutation();

-- +goose Down
drop trigger if exists recording_job_attempt_authorities_no_truncate on recording_job_attempt_authorities;
drop trigger if exists recording_job_attempt_authorities_immutable on recording_job_attempt_authorities;
drop function if exists reject_recording_job_attempt_authority_mutation();
drop table if exists recording_job_attempt_authorities;

alter table recording_pipelines
    drop constraint if exists recording_pipelines_capture_epoch_check,
    drop column if exists capture_epoch;
