-- +goose Up
create table recording_data_keys (
    recording_id uuid not null references recordings(id) on delete restrict,
    capture_epoch bigint not null check (capture_epoch > 0),
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    key_handle uuid not null,
    environment text not null,
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    ciphertext_blob bytea not null check (octet_length(ciphertext_blob) > 0),
    created_at timestamptz not null default now(),
    primary key (recording_id, capture_epoch),
    unique (key_handle)
);
create index recording_data_keys_authority_idx
    on recording_data_keys(tenant_id, recording_id, capture_epoch);

create table recording_bundle_allocations (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    recording_id uuid not null references recordings(id) on delete restrict,
    job_id uuid not null references recording_jobs(id) on delete restrict,
    object_handle uuid not null,
    reservation_request_id uuid not null,
    allocation_version bigint not null check (allocation_version > 0),
    attempt_count integer not null check (attempt_count > 0),
    fencing_generation bigint not null check (fencing_generation > 0),
    capture_epoch bigint not null check (capture_epoch > 0),
    envelope_digest bytea not null check (octet_length(envelope_digest) = 32),
    sequence_number bigint not null check (sequence_number >= 0),
    codec text not null,
    layer text,
    monotonic_start_millis bigint not null check (monotonic_start_millis >= 0),
    monotonic_end_millis bigint not null check (monotonic_end_millis >= monotonic_start_millis),
    media_start_millis bigint not null check (media_start_millis >= 0),
    media_end_millis bigint not null check (media_end_millis >= media_start_millis),
    object_key text not null,
    upload_token_hash bytea not null check (octet_length(upload_token_hash) = 32),
    expected_byte_size bigint not null check (expected_byte_size >= 0),
    expected_checksum bytea not null check (octet_length(expected_checksum) = 32),
    content_type text not null,
    expires_at timestamptz not null,
    encryption_context_digest bytea not null check (octet_length(encryption_context_digest) = 32),
    state text not null default 'allocated' check (state in ('reserved', 'allocated', 'committed')),
    object_version text,
    object_etag text,
    object_checksum bytea,
    manifest_digest bytea,
    committed_at timestamptz,
    created_at timestamptz not null default now(),
    unique (upload_token_hash),
    unique (object_key),
    unique (job_id, attempt_count, reservation_request_id),
    unique (recording_id, sequence_number),
    constraint recording_bundle_allocations_commit_facts_check check (
        (state in ('reserved', 'allocated') and object_version is null and object_etag is null and object_checksum is null and manifest_digest is null and committed_at is null)
        or (state = 'committed' and object_version is not null and object_etag is not null and octet_length(object_checksum) = 32 and octet_length(manifest_digest) = 32 and committed_at is not null)
    )
);
create index recording_bundle_allocations_authority_idx
    on recording_bundle_allocations(tenant_id, recording_id, capture_epoch, sequence_number);

alter table recording_bundles
    add column allocation_id uuid unique references recording_bundle_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text,
    add column capture_epoch bigint,
    add column envelope_digest bytea,
    add column encryption_context_digest bytea,
    add column manifest_digest bytea;

-- +goose StatementBegin
create function protect_recording_data_key_mutation() returns trigger
language plpgsql as $$
begin
    raise exception 'recording data keys are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_data_keys_immutable
before update or delete on recording_data_keys
for each row execute function protect_recording_data_key_mutation();

create trigger recording_data_keys_no_truncate
before truncate on recording_data_keys
for each statement execute function protect_recording_data_key_mutation();

-- +goose StatementBegin
create function protect_recording_bundle_allocation_mutation() returns trigger
language plpgsql as $$
begin
    if old.id <> new.id
        or old.tenant_id <> new.tenant_id
        or old.episode_id <> new.episode_id
        or old.recording_id <> new.recording_id
        or old.job_id <> new.job_id
        or old.object_handle <> new.object_handle
        or old.reservation_request_id <> new.reservation_request_id
        or old.allocation_version <> new.allocation_version
        or old.attempt_count <> new.attempt_count
        or old.fencing_generation <> new.fencing_generation
        or old.capture_epoch <> new.capture_epoch
        or old.envelope_digest <> new.envelope_digest
        or old.sequence_number <> new.sequence_number
        or old.object_key <> new.object_key
        or old.encryption_context_digest <> new.encryption_context_digest
        or old.created_at <> new.created_at then
        raise exception 'recording bundle allocation authority is immutable';
    end if;

    if old.state = 'reserved' and new.state = 'allocated' then
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'allocated' then
        if old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis
            or old.object_version is not null
            or old.object_etag is not null
            or old.object_checksum is not null
            or old.manifest_digest is not null
            or old.committed_at is not null then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    if old.state = 'allocated' and new.state = 'committed' then
        if old.upload_token_hash is distinct from new.upload_token_hash
            or old.expected_byte_size is distinct from new.expected_byte_size
            or old.expected_checksum is distinct from new.expected_checksum
            or old.content_type is distinct from new.content_type
            or old.expires_at is distinct from new.expires_at
            or old.codec is distinct from new.codec
            or old.layer is distinct from new.layer
            or old.monotonic_start_millis is distinct from new.monotonic_start_millis
            or old.monotonic_end_millis is distinct from new.monotonic_end_millis
            or old.media_start_millis is distinct from new.media_start_millis
            or old.media_end_millis is distinct from new.media_end_millis then
            raise exception 'recording bundle allocation upload facts are immutable';
        end if;
        return new;
    end if;

    raise exception 'recording bundle allocation state transition is invalid';
end;
$$;
-- +goose StatementEnd

create trigger recording_bundle_allocations_authority_immutable
before update on recording_bundle_allocations
for each row execute function protect_recording_bundle_allocation_mutation();

-- +goose StatementBegin
create function reject_recording_bundle_allocation_delete() returns trigger
language plpgsql as $$
begin
    raise exception 'recording bundle allocations are append-only';
end;
$$;
-- +goose StatementEnd

create trigger recording_bundle_allocations_no_delete
before delete on recording_bundle_allocations
for each row execute function reject_recording_bundle_allocation_delete();

create trigger recording_bundle_allocations_no_truncate
before truncate on recording_bundle_allocations
for each statement execute function reject_recording_bundle_allocation_delete();

-- +goose Down
drop trigger if exists recording_bundle_allocations_no_truncate on recording_bundle_allocations;
drop trigger if exists recording_bundle_allocations_no_delete on recording_bundle_allocations;
drop function if exists reject_recording_bundle_allocation_delete();
drop trigger if exists recording_bundle_allocations_authority_immutable on recording_bundle_allocations;
drop function if exists protect_recording_bundle_allocation_mutation();
drop trigger if exists recording_data_keys_no_truncate on recording_data_keys;
drop trigger if exists recording_data_keys_immutable on recording_data_keys;
drop function if exists protect_recording_data_key_mutation();
alter table recording_bundles
    drop column if exists manifest_digest,
    drop column if exists encryption_context_digest,
    drop column if exists envelope_digest,
    drop column if exists capture_epoch,
    drop column if exists object_etag,
    drop column if exists object_version,
    drop column if exists allocation_id;
drop table if exists recording_bundle_allocations;
drop table if exists recording_data_keys;
