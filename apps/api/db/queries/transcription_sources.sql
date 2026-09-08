-- name: GetRecordingTranscriptionPolicyForCommit :one
select
    case
        when episodes.config_snapshot #>> '{artifact_policy,transcription,mode}' in ('on_demand', 'automatic')
            then episodes.config_snapshot #>> '{artifact_policy,transcription,mode}'
        else 'disabled'
    end::text as transcription_mode,
    coalesce((episodes.config_snapshot #>> '{artifact_policy,transcription,source_window_seconds}')::bigint, 0)::bigint as source_window_seconds
from recordings
join episodes on episodes.tenant_id = recordings.tenant_id
    and episodes.id = recordings.episode_id
    and episodes.space_id = recordings.space_id
where recordings.tenant_id = sqlc.arg(tenant_id)
  and recordings.space_id = sqlc.arg(space_id)
  and recordings.episode_id = sqlc.arg(episode_id)
  and recordings.id = sqlc.arg(recording_id);

-- name: CreateRecordingTranscriptionSource :one
insert into recording_transcription_sources (
    recording_id, tenant_id, generation, commit_digest, presentation_sha256,
    manifest_key, manifest_allocation_id, manifest_object_version, manifest_etag, manifest_sha256,
    manifest_size, manifest_content_type, schema_version, status, committed_at,
    expires_at
) values (
    sqlc.arg(recording_id), sqlc.arg(tenant_id), sqlc.arg(generation),
    sqlc.arg(commit_digest), sqlc.arg(presentation_sha256), sqlc.arg(manifest_key),
    sqlc.arg(manifest_allocation_id),
    sqlc.narg(manifest_object_version), sqlc.narg(manifest_etag),
    sqlc.arg(manifest_sha256), sqlc.arg(manifest_size),
    sqlc.arg(manifest_content_type), 1, 'ready', sqlc.arg(committed_at),
    sqlc.arg(expires_at)
)
on conflict (recording_id) do nothing
returning *;

-- name: CreateRecordingTranscriptionSourceChunk :one
insert into recording_transcription_source_chunks (
    id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    source_start_ms, source_end_ms, participant_ref, participant_generation,
    track_id, track_epoch,
    identity_kind, track_class, display_name_snapshot, overlap, storage_key,
    allocation_id, object_version, object_etag, checksum, size, content_type
) values (
    sqlc.arg(id), sqlc.arg(recording_id), sqlc.arg(tenant_id),
    sqlc.arg(chunk_index), sqlc.arg(generation), sqlc.arg(start_ms),
    sqlc.arg(end_ms), sqlc.arg(source_start_ms), sqlc.arg(source_end_ms),
    sqlc.narg(participant_ref), sqlc.narg(participant_generation),
    sqlc.narg(track_id), sqlc.narg(track_epoch),
    sqlc.arg(identity_kind), sqlc.arg(track_class),
    sqlc.narg(display_name_snapshot), sqlc.arg(overlap), sqlc.arg(storage_key),
    sqlc.arg(allocation_id),
    sqlc.narg(object_version), sqlc.narg(object_etag), sqlc.arg(checksum),
    sqlc.arg(size), sqlc.arg(content_type)
)
returning *;

-- name: GetRecordingTranscriptionSource :one
select * from recording_transcription_sources
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id);

-- name: LockRecordingTranscriptionSource :one
select * from recording_transcription_sources
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id)
for update;

-- name: ListRecordingTranscriptionSourceChunks :many
select * from recording_transcription_source_chunks
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id)
order by generation, chunk_index;

-- name: GetRecordingTranscriptionSourceChunk :one
select * from recording_transcription_source_chunks
where id = sqlc.arg(id)
  and recording_id = sqlc.arg(recording_id)
  and tenant_id = sqlc.arg(tenant_id);

-- name: AcquireRecordingTranscriptionSourceLease :one
update recording_transcription_sources
set status = 'leased',
    lease_transcript_id = sqlc.arg(transcript_id),
    lease_expires_at = expires_at + interval '2 hours'
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id)
  and expires_at > sqlc.arg(now)::timestamptz
  and (
      (status = 'ready' and lease_transcript_id is null and lease_expires_at is null)
      or (
          status = 'leased'
          and lease_transcript_id = sqlc.arg(transcript_id)
          and lease_expires_at > sqlc.arg(now)::timestamptz
      )
  )
returning *;

-- name: MarkRecordingTranscriptionSourceExpired :one
update recording_transcription_sources
set status = 'cleanup_pending', lease_transcript_id = null,
    lease_expires_at = null, cleanup_due_at = sqlc.arg(now), updated_at = now()
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id)
  and status = 'ready' and expires_at <= sqlc.arg(now)::timestamptz
returning *;

-- name: ReleaseRecordingTranscriptionSource :one
update recording_transcription_sources
set status = 'cleanup_pending', lease_transcript_id = null,
    lease_expires_at = null, cleanup_due_at = sqlc.arg(now), updated_at = now()
where recording_id = sqlc.arg(recording_id) and tenant_id = sqlc.arg(tenant_id)
  and (
      (status = 'leased' and lease_transcript_id = sqlc.arg(transcript_id))
      or status = 'cleanup_pending'
  )
returning *;

-- name: MarkDueRecordingTranscriptionSourcesForCleanup :many
with due_sources as (
    update recording_transcription_sources source
    set status = 'cleanup_pending', lease_transcript_id = null,
        lease_expires_at = null, cleanup_due_at = coalesce(source.cleanup_due_at, sqlc.arg(now)),
        updated_at = now()
    where (source.status = 'ready' and source.expires_at <= sqlc.arg(now)::timestamptz)
       or (
           source.status = 'leased'
           and (
               source.lease_expires_at <= sqlc.arg(now)::timestamptz
               or exists (
                   select 1 from transcriptions transcript
                   where transcript.id = source.lease_transcript_id
                     and transcript.status in ('complete', 'terminal_failure', 'deleted')
               )
           )
       )
    returning source.*
), cancelled_jobs as (
    update artifact_jobs jobs
    set state = 'cancelled', error_code = 'transcription_source_expired',
        error_detail = 'transcription source lease reached its hard deadline',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where jobs.recording_id in (select recording_id from due_sources)
      and jobs.artifact_kind = 'transcription_chunk'
      and jobs.state in ('pending', 'retryable', 'leased')
    returning jobs.transcript_id
), failed_transcripts as (
    update transcriptions transcript
    set status = 'terminal_failure', updated_at = now()
    where transcript.id in (select transcript_id from cancelled_jobs)
      and transcript.status not in ('complete', 'terminal_failure', 'deleted')
    returning transcript.id
)
select * from due_sources;

-- name: ListRecordingTranscriptionSourcesNeedingCleanup :many
select * from recording_transcription_sources
where status = 'cleanup_pending' and cleanup_due_at <= sqlc.arg(now)::timestamptz
order by cleanup_due_at, recording_id
for update skip locked
limit sqlc.arg(page_size)::integer;

-- name: MarkRecordingTranscriptionSourceDeletedIfClean :one
update recording_transcription_sources source
set status = 'deleted', deleted_at = sqlc.arg(now), updated_at = now()
where source.recording_id = sqlc.arg(recording_id)
  and source.status in ('cleanup_pending', 'deleting')
  and not exists (
      select 1 from transcription_cleanup_jobs cleanup
      where cleanup.recording_id = source.recording_id
        and cleanup.object_kind in ('source_manifest', 'source_chunk')
        and cleanup.state <> 'completed'
  )
returning source.*;
