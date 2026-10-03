-- +goose Up
create table recording_completion_recoveries (
    job_id uuid primary key references recording_jobs(id) on delete restrict,
    request_id uuid not null unique,
    database_user text not null default current_user,
    operator text not null check (octet_length(operator) between 1 and 256),
    reason text not null check (octet_length(reason) between 1 and 1024),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    error_code text,
    error_detail text,
    failed_at timestamptz not null,
    source_expires_at timestamptz not null,
    requested_at timestamptz not null default now()
);

-- +goose StatementBegin
create function reject_recording_completion_recovery_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording completion recoveries are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_completion_recoveries_immutable
before update or delete on recording_completion_recoveries
for each row execute function reject_recording_completion_recovery_mutation();
create trigger recording_completion_recoveries_no_truncate
before truncate on recording_completion_recoveries
for each statement execute function reject_recording_completion_recovery_mutation();

-- +goose Down
-- Recovery grants and their failure history must survive runtime rollback.
-- +goose StatementBegin
do $$ begin raise exception 'recording completion recovery audit cannot be removed'; end $$;
-- +goose StatementEnd
