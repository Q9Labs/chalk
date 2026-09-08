-- +goose Up
create table recording_render_inputs (
    render_input_handle uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    space_id uuid not null references spaces(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    key_handle uuid not null,
    object_handle uuid not null unique,
    presentation_handle uuid not null references recording_presentations(presentation_handle) on delete restrict,
    presentation_schema_version text not null check (presentation_schema_version = 'recording_presentation.v1'),
    presentation_profile_version text not null check (octet_length(presentation_profile_version) between 1 and 128),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    presentation_duration_millis bigint not null check (presentation_duration_millis > 0),
    capture_ready_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (render_job_id, attempt_count, fencing_generation),
    foreign key (render_job_id, attempt_count, fencing_generation)
        references recording_job_attempt_authorities(job_id, attempt_count, fencing_generation)
        on delete restrict
);
create index recording_render_inputs_recording_idx
    on recording_render_inputs(tenant_id, recording_id, capture_epoch);

create table recording_render_object_allocations (
    id uuid primary key,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    render_job_id uuid not null references recording_jobs(id) on delete restrict,
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    object_handle uuid not null,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    purpose text not null check (purpose in ('recording_video', 'transcription_manifest', 'transcription_audio')),
    state text not null check (state in ('reserved', 'allocated', 'committed')),
    object_key text not null unique,
    expected_content_type text,
    expected_byte_size bigint,
    expected_sha256 bytea,
    expected_duration_millis bigint,
    upload_token_hash bytea,
    upload_expires_at timestamptz,
    object_version text,
    object_etag text,
    object_content_type text,
    object_byte_size bigint,
    object_sha256 bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (object_handle, reservation_request_id),
	unique (recording_id, allocation_version),
    constraint recording_render_allocations_expected_facts_check check (
        (state = 'reserved' and expected_content_type is null and expected_byte_size is null and expected_sha256 is null and expected_duration_millis is null and upload_token_hash is null and upload_expires_at is null)
        or (state in ('allocated', 'committed') and expected_content_type is not null and expected_byte_size > 0 and octet_length(expected_sha256) = 32 and octet_length(upload_token_hash) = 32 and upload_expires_at is not null)
    ),
    constraint recording_render_allocations_purpose_facts_check check (
		(purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 7200000)))
		or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))
		or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))
    ),
    constraint recording_render_allocations_committed_facts_check check (
        (state <> 'committed' and object_version is null and object_etag is null and object_content_type is null and object_byte_size is null and object_sha256 is null and committed_at is null)
		or (state = 'committed' and length(object_version) between 0 and 256 and length(object_etag) between 1 and 256 and object_content_type = expected_content_type and object_byte_size = expected_byte_size and object_sha256 = expected_sha256 and committed_at is not null)
    )
);
create index recording_render_allocations_authority_idx
    on recording_render_object_allocations(render_job_id, attempt_count, fencing_generation, purpose, state);
create index recording_render_allocations_token_idx
    on recording_render_object_allocations(upload_token_hash)
    where upload_token_hash is not null;

create table recording_render_commits (
    render_job_id uuid primary key references recording_jobs(id) on delete restrict,
    tenant_id uuid not null references tenants(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    render_input_handle uuid not null references recording_render_inputs(render_input_handle) on delete restrict,
    commit_digest bytea not null check (octet_length(commit_digest) = 32),
    presentation_sha256 bytea not null check (octet_length(presentation_sha256) = 32),
    duration_millis bigint not null check (duration_millis > 0),
    video_allocation_id uuid not null references recording_render_object_allocations(id) on delete restrict,
    ffprobe_facts_digest bytea not null check (octet_length(ffprobe_facts_digest) = 32),
	transcription_source_id uuid references recording_transcription_sources(recording_id) on delete restrict,
    transcription_job_ids uuid[] not null default '{}',
    committed_at timestamptz not null default now(),
    unique (recording_id)
);

-- +goose StatementBegin
create function protect_recording_render_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.render_job_id <> new.render_job_id
        or old.render_input_handle <> new.render_input_handle
        or old.object_handle <> new.object_handle
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.purpose <> new.purpose
        or old.object_key <> new.object_key
        or old.created_at <> new.created_at then
        raise exception 'recording render allocation authority is immutable';
    end if;
    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'allocated'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.object_version is null and new.object_version is null then
        return new;
    end if;
    if old.state = 'allocated' and new.state = 'committed'
        and old.expected_content_type = new.expected_content_type
        and old.expected_byte_size = new.expected_byte_size
        and old.expected_sha256 = new.expected_sha256
        and old.expected_duration_millis is not distinct from new.expected_duration_millis
        and old.upload_token_hash = new.upload_token_hash
        and old.upload_expires_at = new.upload_expires_at then
        return new;
    end if;
    raise exception 'recording render allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_allocations_authority_immutable
before update on recording_render_object_allocations
for each row execute function protect_recording_render_allocation_mutation();

-- +goose StatementBegin
create function reject_recording_render_authority_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording render authority is append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_render_inputs_immutable
before update or delete on recording_render_inputs
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_immutable
before update or delete on recording_render_commits
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_delete
before delete on recording_render_object_allocations
for each row execute function reject_recording_render_authority_mutation();
create trigger recording_render_inputs_no_truncate
before truncate on recording_render_inputs
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_commits_no_truncate
before truncate on recording_render_commits
for each statement execute function reject_recording_render_authority_mutation();
create trigger recording_render_allocations_no_truncate
before truncate on recording_render_object_allocations
for each statement execute function reject_recording_render_authority_mutation();

-- +goose Down
drop trigger if exists recording_render_allocations_no_truncate on recording_render_object_allocations;
drop trigger if exists recording_render_commits_no_truncate on recording_render_commits;
drop trigger if exists recording_render_inputs_no_truncate on recording_render_inputs;
drop trigger if exists recording_render_allocations_no_delete on recording_render_object_allocations;
drop trigger if exists recording_render_commits_immutable on recording_render_commits;
drop trigger if exists recording_render_inputs_immutable on recording_render_inputs;
drop trigger if exists recording_render_allocations_authority_immutable on recording_render_object_allocations;
drop function if exists reject_recording_render_authority_mutation();
drop function if exists protect_recording_render_allocation_mutation();
drop table if exists recording_render_commits;
drop table if exists recording_render_object_allocations;
drop table if exists recording_render_inputs;
