-- name: GetTenantRecording :one
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    failure_code,
    failed_at,
    deleted_at,
    deleted_by,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
    and status <> 'deleted';

-- name: ListTenantRecordings :many
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    failure_code,
    failed_at,
    deleted_at,
    deleted_by,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and status <> 'deleted'
    and (
        sqlc.narg(episode_id)::uuid is null
        or episode_id = sqlc.narg(episode_id)::uuid
    )
    and (
        sqlc.narg(space_id)::uuid is null
        or space_id = sqlc.narg(space_id)::uuid
    )
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: ListTenantSpaceRecordings :many
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    failure_code,
    failed_at,
    deleted_at,
    deleted_by,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and status <> 'deleted'
    and (
        sqlc.narg(episode_id)::uuid is null
        or episode_id = sqlc.narg(episode_id)::uuid
    )
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: LockTenantRecordingForDelete :one
select *
from recordings
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id)
for update;

-- name: LockRecordingPipelineForDelete :one
select *
from recording_pipelines
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
for update;

-- name: CountActiveRecordingJobsForDelete :one
select count(*)::integer
from recording_jobs jobs
where jobs.tenant_id = sqlc.arg(tenant_id)
  and jobs.recording_id = sqlc.arg(recording_id)
  and state in ('pending', 'leased', 'retryable_failure');

-- name: CountActiveArtifactJobsForDelete :one
select count(*)::integer
from artifact_jobs jobs
where jobs.tenant_id = sqlc.arg(tenant_id)
  and jobs.recording_id = sqlc.arg(recording_id)
  and state in ('pending', 'leased', 'retryable');

-- name: ListTenantRecordingDeleteObjectKeys :many
with keys as (
    select storage_key as object_key, false as shared
    from recordings recordings
    where recordings.tenant_id = sqlc.arg(tenant_id) and recordings.id = sqlc.arg(recording_id) and storage_key is not null
    union all
    select object_key, false
    from recording_artifacts objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select object_key, false
    from recording_bundles objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select object_key, false
    from recording_bundle_allocations objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select presentation_object_key, false
    from recording_presentations objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select asset_manifest_object_key, false
    from recording_presentations objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select object_key, false
    from recording_render_object_allocations objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select manifest_key, false
    from recording_transcription_sources objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select storage_key, false
    from recording_transcription_source_chunks objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
    union all
    select artifact_key, false
    from transcriptions objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id) and artifact_key is not null
    union all
    select source_manifest_key, false
    from transcriptions objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id) and source_manifest_key is not null
    union all
    select objects.storage_key, false
    from transcript_chunks objects
    join transcriptions owner on owner.id = objects.transcript_id
    where objects.tenant_id = sqlc.arg(tenant_id) and owner.recording_id = sqlc.arg(recording_id)
    union all
    select objects.result_key, false
    from transcript_chunks objects
    join transcriptions owner on owner.id = objects.transcript_id
    where objects.tenant_id = sqlc.arg(tenant_id) and owner.recording_id = sqlc.arg(recording_id)
    union all
    select objects.result_key, false
    from transcription_chunk_results objects
    join transcript_chunks chunks on chunks.id = objects.chunk_id
    join transcriptions owner on owner.id = chunks.transcript_id
    where chunks.tenant_id = sqlc.arg(tenant_id) and owner.recording_id = sqlc.arg(recording_id)
    union all
    select object_key, true
    from recording_presentation_assets objects
    where objects.tenant_id = sqlc.arg(tenant_id) and objects.recording_id = sqlc.arg(recording_id)
)
select object_key, bool_and(shared) as shared
from keys
where object_key <> ''
group by object_key
order by object_key;

-- name: TombstoneRecordingTranscripts :many
update transcriptions
set status = 'deleted',
    deleted_at = coalesce(deleted_at, now()),
    metadata = null,
    artifact_key = null,
    artifact_sha256 = null,
    artifact_size = null,
    artifact_content_type = null,
    source_manifest_key = null,
    source_manifest_sha256 = null,
    source_manifest_size = null,
    source_manifest_content_type = null,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and status <> 'deleted'
returning *;

-- name: MarkRecordingTranscriptionSourceDeleted :exec
update recording_transcription_sources
set status = 'deleted',
    lease_transcript_id = null,
    lease_expires_at = null,
    cleanup_due_at = now(),
    deleted_at = coalesce(deleted_at, now()),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and status <> 'deleted';

-- name: TombstoneTenantRecording :one
update recordings
set status = 'deleted',
    storage_key = null,
    storage_content_type = null,
    storage_size = null,
    storage_checksum = null,
    duration_millis = null,
    completed_at = null,
    metadata = null,
    failure_code = null,
    failed_at = null,
    deleted_at = now(),
    deleted_by = sqlc.arg(deleted_by),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id)
  and status <> 'deleted'
returning *;
