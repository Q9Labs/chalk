-- +goose Up
SET LOCAL lock_timeout = '5s';
create table recording_job_failure_history (
    job_id uuid not null references recording_jobs(id) on delete restrict,
    manual_retry_count integer not null check (manual_retry_count between 1 and 5),
    attempt_count integer not null check (attempt_count >= 0),
    fencing_generation bigint not null check (fencing_generation >= 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    retried_at timestamptz not null default now(),
    primary key (job_id, manual_retry_count)
);

-- +goose Down
SET LOCAL lock_timeout = '5s';
drop table recording_job_failure_history;
