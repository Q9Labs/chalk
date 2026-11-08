-- +goose Up
-- recording_jobs keeps only the latest error and clears it when a retry succeeds, so a job that
-- failed once and then succeeded could not explain itself. Each reported attempt failure now keeps
-- its own row. Only new code reads or writes the table, so the previous release keeps running on
-- the upgraded schema.
create table recording_job_attempt_failures (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    kind text not null check (kind in ('capture', 'transcription', 'render')),
    error_code text not null check (octet_length(error_code) <= 128),
    error_detail text not null check (octet_length(error_detail) <= 2048),
    lease_owner text not null check (octet_length(lease_owner) between 1 and 256),
    failed_at timestamptz not null default now(),
    primary key (job_id, attempt_count, fencing_generation)
);

-- +goose Down
drop table recording_job_attempt_failures;
