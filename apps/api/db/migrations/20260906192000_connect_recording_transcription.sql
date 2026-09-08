-- +goose Up
alter table recording_transcription_sources
    add column generation bigint not null default 1,
    add column commit_digest bytea,
    add column presentation_sha256 bytea,
    add column manifest_allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column manifest_object_version text,
    add column manifest_etag text,
    add column status text not null default 'ready',
    add column expires_at timestamptz,
    add column lease_transcript_id uuid references transcriptions(id) on delete restrict,
    add column lease_expires_at timestamptz,
    add column cleanup_due_at timestamptz,
    add column deleted_at timestamptz,
    add column updated_at timestamptz not null default now();

update recording_transcription_sources
set commit_digest = manifest_sha256,
    expires_at = committed_at + interval '24 hours'
where commit_digest is null or expires_at is null;

alter table recording_transcription_sources
    alter column commit_digest set not null,
    alter column expires_at set not null,
    add constraint recording_transcription_sources_generation_check check (generation > 0),
    add constraint recording_transcription_sources_commit_digest_check check (octet_length(commit_digest) = 32),
    add constraint recording_transcription_sources_presentation_sha256_check check (presentation_sha256 is null or octet_length(presentation_sha256) = 32),
    add constraint recording_transcription_sources_manifest_object_version_check check (manifest_object_version is null or length(manifest_object_version) between 1 and 256),
    add constraint recording_transcription_sources_manifest_etag_check check (manifest_etag is null or length(manifest_etag) between 1 and 256),
    add constraint recording_transcription_sources_status_check check (status in ('ready', 'leased', 'cleanup_pending', 'deleting', 'deleted')),
    add constraint recording_transcription_sources_expiry_check check (expires_at > committed_at and expires_at <= committed_at + interval '24 hours'),
    add constraint recording_transcription_sources_lease_check check (
        (lease_transcript_id is null and lease_expires_at is null)
        or (
            lease_transcript_id is not null
            and lease_expires_at is not null
            and lease_expires_at <= expires_at + interval '2 hours'
        )
    ),
    add constraint recording_transcription_sources_status_lease_check check (
        (status = 'ready' and lease_transcript_id is null and lease_expires_at is null)
        or (status = 'leased' and lease_transcript_id is not null and lease_expires_at is not null)
        or (status in ('cleanup_pending', 'deleting', 'deleted') and lease_transcript_id is null and lease_expires_at is null)
    ),
    add constraint recording_transcription_sources_cleanup_check check (
        (status in ('ready', 'leased') and cleanup_due_at is null and deleted_at is null)
        or (status in ('cleanup_pending', 'deleting') and cleanup_due_at is not null and deleted_at is null)
        or (status = 'deleted' and cleanup_due_at is not null and deleted_at is not null)
    );

create unique index recording_transcription_sources_recording_generation_uidx
    on recording_transcription_sources(recording_id, generation);
create index recording_transcription_sources_expiry_idx
    on recording_transcription_sources(expires_at, recording_id)
    where status = 'ready';
create index recording_transcription_sources_lease_expiry_idx
    on recording_transcription_sources(lease_expires_at, recording_id)
    where status = 'leased';
create index recording_transcription_sources_cleanup_idx
    on recording_transcription_sources(cleanup_due_at, recording_id)
    where status in ('cleanup_pending', 'deleting');

alter table transcriptions add column source_expires_at timestamptz;

update transcriptions transcript
set source_expires_at = source.expires_at
from recording_transcription_sources source
where source.recording_id = transcript.recording_id
  and transcript.source_expires_at is null;

alter table recording_transcription_source_chunks
    add column track_id text,
    add column participant_generation bigint,
    add column display_name_snapshot text,
    add column overlap boolean not null default false,
    add column source_start_ms bigint,
    add column source_end_ms bigint,
    add column allocation_id uuid references recording_render_object_allocations(id) on delete restrict,
    add column object_version text,
    add column object_etag text;

update recording_transcription_source_chunks
set source_start_ms = 0,
    source_end_ms = end_ms - start_ms
where source_start_ms is null or source_end_ms is null;

alter table recording_transcription_source_chunks
    alter column source_start_ms set not null,
    alter column source_end_ms set not null,
    add constraint recording_transcription_source_chunks_track_id_check check (track_id is null or length(track_id) between 1 and 256),
    add constraint recording_transcription_source_chunks_participant_generation_check check (participant_generation is null or participant_generation > 0),
    add constraint recording_transcription_source_chunks_display_name_check check (display_name_snapshot is null or length(display_name_snapshot) between 1 and 256),
    add constraint recording_transcription_source_chunks_display_name_authority_check check (
        display_name_snapshot is null or (identity_kind = 'participant' and track_class = 'microphone')
    ),
    add constraint recording_transcription_source_chunks_source_time_check check (
        source_start_ms >= 0
        and source_end_ms > source_start_ms
        and source_end_ms - source_start_ms = end_ms - start_ms
    ),
    add constraint recording_transcription_source_chunks_object_version_check check (object_version is null or length(object_version) between 1 and 256),
    add constraint recording_transcription_source_chunks_object_etag_check check (object_etag is null or length(object_etag) between 1 and 256);

alter table transcription_cleanup_jobs
    add column recording_id uuid references recordings(id) on delete restrict;

update transcription_cleanup_jobs cleanup
set recording_id = transcriptions.recording_id
from transcriptions
where transcriptions.id = cleanup.transcript_id
  and cleanup.recording_id is null;

alter table transcription_cleanup_jobs
    alter column recording_id set not null,
    alter column transcript_id drop not null,
    drop constraint transcription_cleanup_jobs_transcript_id_object_key_key,
    drop constraint transcription_cleanup_jobs_kind_check,
    add constraint transcription_cleanup_jobs_kind_check check (
        object_kind in ('final_artifact', 'temp_result', 'source_manifest', 'source_chunk')
    ),
    add constraint transcription_cleanup_jobs_owner_check check (
        (object_kind in ('final_artifact', 'temp_result') and transcript_id is not null)
        or (object_kind in ('source_manifest', 'source_chunk'))
    );

create unique index transcription_cleanup_jobs_recording_object_uidx
    on transcription_cleanup_jobs(recording_id, object_key);

-- +goose Down
drop index if exists transcription_cleanup_jobs_recording_object_uidx;

alter table transcription_cleanup_jobs
    drop constraint if exists transcription_cleanup_jobs_owner_check,
    drop constraint if exists transcription_cleanup_jobs_kind_check;

delete from transcription_cleanup_jobs where transcript_id is null;

alter table transcription_cleanup_jobs
    alter column transcript_id set not null,
    add constraint transcription_cleanup_jobs_kind_check check (object_kind in ('final_artifact', 'temp_chunk', 'temp_result')),
    add constraint transcription_cleanup_jobs_transcript_id_object_key_key unique (transcript_id, object_key),
    drop column recording_id;

alter table recording_transcription_source_chunks
    drop constraint if exists recording_transcription_source_chunks_object_etag_check,
    drop constraint if exists recording_transcription_source_chunks_object_version_check,
    drop constraint if exists recording_transcription_source_chunks_source_time_check,
    drop constraint if exists recording_transcription_source_chunks_display_name_authority_check,
    drop constraint if exists recording_transcription_source_chunks_display_name_check,
    drop constraint if exists recording_transcription_source_chunks_participant_generation_check,
    drop constraint if exists recording_transcription_source_chunks_track_id_check,
    drop column object_etag,
    drop column object_version,
    drop column allocation_id,
    drop column source_end_ms,
    drop column source_start_ms,
    drop column overlap,
    drop column display_name_snapshot,
    drop column participant_generation,
    drop column track_id;

alter table transcriptions drop column source_expires_at;

drop index if exists recording_transcription_sources_cleanup_idx;
drop index if exists recording_transcription_sources_lease_expiry_idx;
drop index if exists recording_transcription_sources_expiry_idx;
drop index if exists recording_transcription_sources_recording_generation_uidx;

alter table recording_transcription_sources
    drop constraint if exists recording_transcription_sources_cleanup_check,
    drop constraint if exists recording_transcription_sources_status_lease_check,
    drop constraint if exists recording_transcription_sources_lease_check,
    drop constraint if exists recording_transcription_sources_expiry_check,
    drop constraint if exists recording_transcription_sources_status_check,
    drop constraint if exists recording_transcription_sources_manifest_etag_check,
    drop constraint if exists recording_transcription_sources_manifest_object_version_check,
    drop constraint if exists recording_transcription_sources_presentation_sha256_check,
    drop constraint if exists recording_transcription_sources_commit_digest_check,
    drop constraint if exists recording_transcription_sources_generation_check,
    drop column updated_at,
    drop column deleted_at,
    drop column cleanup_due_at,
    drop column lease_expires_at,
    drop column lease_transcript_id,
    drop column expires_at,
    drop column status,
    drop column manifest_etag,
    drop column manifest_object_version,
    drop column manifest_allocation_id,
    drop column presentation_sha256,
    drop column commit_digest,
    drop column generation;
