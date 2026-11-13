-- name: GetRecordingRenderCommit :one
select commits.*, artifacts.object_key, artifacts.content_type,
    artifacts.byte_size, artifacts.checksum, artifacts.duration_millis as artifact_duration_millis,
    artifacts.committed_at as artifact_committed_at, artifacts.created_at as artifact_created_at
from recording_render_commits commits
join recording_artifacts artifacts on artifacts.render_job_id = commits.render_job_id
join recording_render_inputs inputs on inputs.render_input_handle = commits.render_input_handle
where commits.render_job_id = sqlc.arg(render_job_id)
  and commits.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and commits.recording_id = sqlc.arg(recording_id)
  and commits.attempt_count = sqlc.arg(attempt_count)
  and commits.fencing_generation = sqlc.arg(fencing_generation)
  and commits.capture_epoch = sqlc.arg(capture_epoch)
  and commits.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle);

-- name: LockRecordingRenderCommitAuthority :one
select inputs.presentation_sha256, inputs.presentation_duration_millis,
    inputs.presentation_handle, inputs.presentation_schema_version,
    inputs.presentation_profile_version, inputs.capture_ready_at
from recording_render_inputs inputs
join recording_jobs jobs on jobs.id = inputs.render_job_id
join recording_pipelines pipelines on pipelines.recording_id = inputs.recording_id
join recordings on recordings.id = inputs.recording_id
join episodes on episodes.id = inputs.episode_id
where inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and jobs.kind = 'render'
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and pipelines.state = 'rendering'
  and pipelines.capture_completed_at +
      (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second') > clock_timestamp()
  and recordings.status in ('pending', 'processing')
for update of jobs, recordings;

-- name: LockRecordingTranscriptionPreparationAuthority :one
select inputs.presentation_sha256, inputs.presentation_duration_millis,
    inputs.presentation_handle, inputs.presentation_schema_version,
    inputs.presentation_profile_version, inputs.capture_ready_at
from recording_render_inputs inputs
join recording_jobs jobs on jobs.id = inputs.render_job_id
join recording_pipelines pipelines on pipelines.recording_id = inputs.recording_id
join recordings on recordings.id = inputs.recording_id
join episodes on episodes.id = inputs.episode_id
where inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and jobs.kind = 'transcription'
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and pipelines.capture_completed_at is not null
  and pipelines.state <> 'deleted'
  and pipelines.capture_completed_at +
      (recording_transcription_source_window_seconds(episodes.config_snapshot) * interval '1 second') > clock_timestamp()
  and recordings.status in ('pending', 'processing', 'completed')
for update of jobs, recordings;

-- name: GetRecordingTranscriptionPreparationCommit :one
select commits.transcription_source_id
from recording_transcription_preparation_commits commits
join recording_render_inputs inputs on inputs.render_input_handle = commits.render_input_handle
join recording_jobs jobs on jobs.id = commits.transcription_job_id
where commits.transcription_job_id = sqlc.arg(transcription_job_id)
  and commits.tenant_id = sqlc.arg(tenant_id)
  and commits.recording_id = sqlc.arg(recording_id)
  and commits.attempt_count = sqlc.arg(attempt_count)
  and commits.fencing_generation = sqlc.arg(fencing_generation)
  and commits.capture_epoch = sqlc.arg(capture_epoch)
  and commits.render_input_handle = sqlc.arg(render_input_handle)
  and commits.commit_digest = sqlc.arg(commit_digest)
  and commits.presentation_sha256 = sqlc.arg(presentation_sha256)
  and commits.duration_millis = sqlc.arg(duration_millis)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and jobs.kind = 'transcription';

-- name: CompleteRecordingTranscriptionPreparation :one
with preparation_commit as (
    insert into recording_transcription_preparation_commits (
        transcription_job_id, tenant_id, recording_id, attempt_count,
        fencing_generation, capture_epoch, render_input_handle, commit_digest,
        presentation_sha256, duration_millis, transcription_source_id, committed_at
    ) values (
        sqlc.arg(transcription_job_id), sqlc.arg(tenant_id), sqlc.arg(recording_id),
        sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch),
        sqlc.arg(render_input_handle), sqlc.arg(commit_digest), sqlc.arg(presentation_sha256),
        sqlc.arg(duration_millis), sqlc.narg(transcription_source_id), sqlc.arg(committed_at)
    )
    returning *
), completed_job as (
    update recording_jobs jobs
    set state = 'succeeded', lease_token = null, lease_owner = null,
        lease_expires_at = null, terminal_at = preparation_commit.committed_at,
        updated_at = preparation_commit.committed_at
    from preparation_commit
    where jobs.id = preparation_commit.transcription_job_id
      and jobs.kind = 'transcription'
      and jobs.state = 'leased'
      and jobs.attempt_count = preparation_commit.attempt_count
      and jobs.fencing_generation = preparation_commit.fencing_generation
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
    returning jobs.id
)
select preparation_commit.transcription_source_id
from preparation_commit
join completed_job on completed_job.id = preparation_commit.transcription_job_id;

-- name: CompleteRecordingRender :one
with render_commit as (
    insert into recording_render_commits (
        render_job_id, tenant_id, recording_id, attempt_count, fencing_generation,
        capture_epoch, render_input_handle, commit_digest, presentation_sha256,
        duration_millis, video_allocation_id, ffprobe_facts_digest,
        transcription_source_id, transcription_job_ids, committed_at
    )
    values (
        sqlc.arg(render_job_id), sqlc.arg(tenant_id), sqlc.arg(recording_id),
        sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch),
        sqlc.arg(render_input_handle), sqlc.arg(commit_digest), sqlc.arg(presentation_sha256),
        sqlc.arg(duration_millis), sqlc.arg(video_allocation_id), sqlc.arg(ffprobe_facts_digest),
        sqlc.narg(transcription_source_id), sqlc.arg(transcription_job_ids)::uuid[], sqlc.arg(committed_at)
    )
    returning *
), video as (
    select allocations.*
    from recording_render_object_allocations allocations
    join render_commit on render_commit.video_allocation_id = allocations.id
    where allocations.state = 'committed'
      and allocations.purpose = 'recording_video'
      and allocations.render_job_id = render_commit.render_job_id
      and allocations.attempt_count = render_commit.attempt_count
      and allocations.fencing_generation = render_commit.fencing_generation
      and allocations.capture_epoch = render_commit.capture_epoch
), artifact as (
    insert into recording_artifacts (
        recording_id, tenant_id, render_job_id, object_key, content_type,
        byte_size, checksum, duration_millis, committed_at, expires_at, created_at
    )
    select render_commit.recording_id, render_commit.tenant_id, render_commit.render_job_id,
        video.object_key, video.object_content_type, video.object_byte_size,
        video.object_sha256, render_commit.duration_millis,
        render_commit.committed_at,
        pipelines.capture_completed_at +
            (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
        render_commit.committed_at
    from render_commit
    join video on true
    join recording_pipelines pipelines on pipelines.recording_id = render_commit.recording_id
    join recordings on recordings.id = render_commit.recording_id
    join episodes on episodes.id = recordings.episode_id
    returning *
), artifact_cleanup as (
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), artifact.tenant_id, artifact.recording_id, null,
        artifact.object_key, 'recording_source', artifact.expires_at
    from artifact
    on conflict (recording_id, object_key) do update set
        due_at = least(transcription_cleanup_jobs.due_at, excluded.due_at),
        updated_at = now()
    returning id
), completed_job as (
    update recording_jobs jobs
    set result_metadata = jsonb_build_object('video_degradation', sqlc.arg(video_degradation)::jsonb),
        state = 'succeeded', lease_token = null, lease_owner = null,
        lease_expires_at = null, terminal_at = render_commit.committed_at,
        updated_at = render_commit.committed_at
    from render_commit
    where jobs.id = render_commit.render_job_id
      and jobs.state = 'leased'
      and jobs.attempt_count = render_commit.attempt_count
      and jobs.fencing_generation = render_commit.fencing_generation
    returning jobs.recording_id
), public_recording as (
    update recordings
    set status = 'completed', storage_provider = 'r2', storage_key = artifact.object_key,
        storage_content_type = artifact.content_type, storage_size = artifact.byte_size,
        storage_checksum = artifact.checksum, duration_millis = artifact.duration_millis,
        completed_at = artifact.committed_at, updated_at = artifact.committed_at
    from artifact join completed_job on completed_job.recording_id = artifact.recording_id
    where recordings.id = artifact.recording_id and recordings.tenant_id = artifact.tenant_id
    returning recordings.id
), completed_pipeline as (
    update recording_pipelines pipelines
    set state = 'committed', committed_at = render_commit.committed_at,
        updated_at = render_commit.committed_at
    from render_commit join public_recording on public_recording.id = render_commit.recording_id
    where pipelines.recording_id = render_commit.recording_id and pipelines.state = 'rendering'
    returning pipelines.recording_id
)
select artifact.*
from artifact
join completed_pipeline on completed_pipeline.recording_id = artifact.recording_id
cross join (select count(*) from artifact_cleanup) cleanup;
