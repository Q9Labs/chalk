-- name: ListRecordingRenderBackfillCandidates :many
select recordings.id as recording_id, recordings.tenant_id,
    (pipelines.capture_completed_at + recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')::timestamptz as source_expires_at,
    exists(select 1 from recording_jobs jobs where jobs.recording_id = recordings.id and jobs.kind = 'render')
        or recordings.status = 'completed' as already_queued,
    exists(select 1 from recording_bundles bundles where bundles.recording_id = recordings.id) as has_bundles,
    exists(select 1 from recording_data_keys keys where keys.recording_id = recordings.id and keys.capture_epoch = pipelines.capture_epoch) as has_key,
    exists(select 1 from recording_presentations presentations where presentations.recording_id = recordings.id) as has_presentation,
    array(
        select bundles.object_key from recording_bundles bundles where bundles.recording_id = recordings.id
        union
        select presentations.presentation_object_key from recording_presentations presentations where presentations.recording_id = recordings.id
        union
        select presentations.asset_manifest_object_key from recording_presentations presentations where presentations.recording_id = recordings.id
        union
        select assets.object_key from recording_presentation_assets assets
        join recording_presentations presentations using (presentation_handle)
        where presentations.recording_id = recordings.id
    )::text[] as object_keys
from recordings
join episodes on episodes.id = recordings.episode_id
join recording_pipelines pipelines on pipelines.recording_id = recordings.id
join recording_jobs capture on capture.recording_id = recordings.id and capture.kind = 'capture' and capture.state = 'succeeded'
where pipelines.capture_completed_at is not null and pipelines.state <> 'deleted'
    and (sqlc.narg(after_recording_id)::uuid is null or recordings.id > sqlc.narg(after_recording_id))
order by recordings.id
limit sqlc.arg(batch_size);
