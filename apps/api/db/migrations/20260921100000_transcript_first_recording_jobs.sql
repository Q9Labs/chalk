-- +goose Up
-- Audio preparation is an independently fenced recorder job. A finished MP4
-- remains an explicit export, so transcript work never requires composition.
-- Space-scoped artifact history must seek within the Space rather than scan a
-- tenant's unrelated recording history to fill a page.
create index recordings_tenant_space_created_at_id_idx
    on recordings(tenant_id, space_id, created_at desc, id desc);

alter table recording_jobs
    drop constraint recording_jobs_kind_check1,
    add constraint recording_jobs_kind_check1
        check (kind in ('capture', 'transcription', 'render'));

alter table recording_job_attempt_authorities
    drop constraint recording_job_attempt_authorities_kind_check,
    add constraint recording_job_attempt_authorities_kind_check
        check (kind in ('capture', 'transcription', 'render'));

alter table transcription_cleanup_jobs
    drop constraint transcription_cleanup_jobs_kind_check,
    drop constraint transcription_cleanup_jobs_owner_check,
    add constraint transcription_cleanup_jobs_kind_check check (
        object_kind in ('final_artifact', 'temp_result', 'source_manifest', 'source_chunk', 'recording_source')
    ),
    add constraint transcription_cleanup_jobs_owner_check check (
        (object_kind in ('final_artifact', 'temp_result') and transcript_id is not null)
        or (object_kind in ('source_manifest', 'source_chunk', 'recording_source'))
    );

alter table tenant_artifact_policies
    drop constraint tenant_artifact_policies_source_window_check,
    add constraint tenant_artifact_policies_source_window_check check (
        (transcription_ceiling = 'disabled' and source_window_seconds = 0)
        or (transcription_ceiling in ('on_demand', 'automatic') and source_window_seconds between 1 and 2592000)
    );

-- This affects only rows created after the migration. Existing tenant and
-- Space policies remain untouched; their already-frozen Episode snapshots
-- stay authoritative.
alter table tenant_artifact_policies
    alter column recording_retention_seconds set default 2592000;

-- A zero recording retention was valid before deferred Export but did not
-- govern rendered MP4 lifetime. Keep those immutable legacy snapshots intact
-- while giving their newly deferred source and MP4 a capture-anchored 30-day
-- operational window. Explicit positive snapshot values remain exact.
-- +goose StatementBegin
create function recording_deferred_retention_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select coalesce(
        nullif((config_snapshot -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint, 0),
        2592000
    );
$$;
-- +goose StatementEnd

-- Transcription uses its immutable source window, never extending beyond the
-- recording source window that also fences deferred Export.
-- +goose StatementBegin
create function recording_transcription_source_window_seconds(config_snapshot jsonb)
returns bigint
language sql
immutable
strict
as $$
    select least(
        recording_deferred_retention_seconds(config_snapshot),
        coalesce((config_snapshot -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint, 0)
    );
$$;
-- +goose StatementEnd

alter table recording_transcription_sources
    drop constraint recording_transcription_sources_expiry_check,
    add constraint recording_transcription_sources_expiry_check check (
        expires_at > committed_at
        and expires_at <= committed_at + interval '30 days'
    );

alter table recording_artifacts
    add column expires_at timestamptz,
    add constraint recording_artifacts_expiry_check check (
        expires_at is null or expires_at > committed_at
    );

-- A source-only preparation must acknowledge an empty microphone set as
-- durably as a populated one, otherwise a retry cannot distinguish a
-- completed no-audio attempt from a lost response.
create table recording_transcription_preparation_commits (
    transcription_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    committed_at timestamptz not null default now()
);

-- +goose StatementBegin
create or replace function validate_episode_config_snapshot(value jsonb)
returns boolean
language sql
immutable
strict
as $$
    select jsonb_typeof(value) = 'object'
        and jsonb_typeof(value -> 'roles') = 'object'
        and not exists (
            select 1
            from jsonb_each(value -> 'roles') role_entry
            where jsonb_typeof(role_entry.value) <> 'array'
                or not valid_capabilities(array(select jsonb_array_elements_text(role_entry.value)))
        )
        and jsonb_typeof(value -> 'admission_policy') = 'object'
        and value -> 'admission_policy' ->> 'mode' in ('open', 'knock', 'members_only')
        and (value ->> 'default_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'maximum_episode_duration_seconds')::integer between 60 and 604800
        and (value ->> 'default_episode_duration_seconds')::integer <=
            (value ->> 'maximum_episode_duration_seconds')::integer
        and (value ->> 'linger_window_seconds')::integer >= 0
        and (
            not (value ? 'artifact_policy')
            or (
                jsonb_typeof(value -> 'artifact_policy') = 'object'
                and value -> 'artifact_policy' ->> 'schema_version' = 'episode_config.v2'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording') = 'object'
                and value -> 'artifact_policy' -> 'recording' ->> 'mode' in ('disabled', 'manual', 'automatic')
                and value -> 'artifact_policy' -> 'recording' ->> 'profile' = 'composite_720p_v1'
                and jsonb_typeof(value -> 'artifact_policy' -> 'recording' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'recording' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription') = 'object'
                and value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('disabled', 'on_demand', 'automatic')
                and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'retention_seconds') = 'number'
                and (value -> 'artifact_policy' -> 'transcription' ->> 'retention_seconds')::bigint between 0 and 9223372036
                and (
                    (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' = 'disabled'
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint = 0
                    )
                    or (
                        value -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('on_demand', 'automatic')
                        and jsonb_typeof(value -> 'artifact_policy' -> 'transcription' -> 'source_window_seconds') = 'number'
                        and (value -> 'artifact_policy' -> 'transcription' ->> 'source_window_seconds')::bigint between 1 and 2592000
                        and value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version' is not null
                        and btrim(value -> 'artifact_policy' -> 'transcription' ->> 'provider_policy_version') <> ''
                    )
                )
            )
        )
$$;
-- +goose StatementEnd

-- +goose Down
-- This migration permits 30-day source windows and introduces durable job and
-- cleanup states. Once applied, existing rows can rely on those invariants, so
-- automatic rollback would either fail or discard durable lifecycle evidence.
-- +goose StatementBegin
do $$
begin
    raise exception '20260921100000_transcript_first_recording_jobs is irreversible';
end;
$$;
-- +goose StatementEnd
