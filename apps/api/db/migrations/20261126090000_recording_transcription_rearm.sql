-- +goose Up
create table recording_transcription_source_renewals (
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    fencing_generation bigint not null check (fencing_generation > 0),
    database_user text not null default current_user,
    operator text not null check (octet_length(operator) between 1 and 256),
    reason text not null check (octet_length(reason) between 1 and 1024),
    source_expires_at timestamptz not null,
    requested_at timestamptz not null default now(),
    primary key (job_id, fencing_generation),
    unique (recording_id, job_id, fencing_generation),
    check (source_expires_at > requested_at)
);
create index recording_transcription_source_renewals_recording_idx
    on recording_transcription_source_renewals(recording_id, source_expires_at);

-- The immutable Episode snapshot sets the first source window. An operator
-- renewal is a later durable fact for the same recording, so every claim,
-- authorization, admission and expiry path reads this one authority.
-- +goose StatementBegin
create function recording_transcription_source_expires_at(
    p_recording_id uuid,
    p_capture_completed_at timestamptz,
    p_config_snapshot jsonb
)
returns timestamptz
language sql
stable
strict
as $$
    select greatest(
        p_capture_completed_at +
            (recording_transcription_source_window_seconds(p_config_snapshot) * interval '1 second'),
        coalesce((
            select max(renewals.source_expires_at)
            from recording_transcription_source_renewals renewals
            join recording_jobs jobs on jobs.id = renewals.job_id
            where renewals.recording_id = p_recording_id
              and jobs.recording_id = p_recording_id
              and jobs.kind = 'transcription'
        ), p_capture_completed_at +
            (recording_transcription_source_window_seconds(p_config_snapshot) * interval '1 second'))
    );
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function reject_recording_transcription_source_renewal_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording transcription source renewals are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_transcription_source_renewals_immutable
before update or delete on recording_transcription_source_renewals
for each row execute function reject_recording_transcription_source_renewal_mutation();
create trigger recording_transcription_source_renewals_no_truncate
before truncate on recording_transcription_source_renewals
for each statement execute function reject_recording_transcription_source_renewal_mutation();

-- +goose Down
-- Renewal grants are audit facts and must survive runtime rollback.
-- +goose StatementBegin
do $$ begin raise exception 'recording transcription source renewal audit cannot be removed'; end $$;
-- +goose StatementEnd
