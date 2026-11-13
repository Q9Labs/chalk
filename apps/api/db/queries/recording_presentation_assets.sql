-- name: InsertRecordingPresentationAsset :one
insert into recording_presentation_assets (
    presentation_handle, tenant_id, recording_id, ordinal, asset_id, asset_kind,
    object_key, object_version, object_etag, content_type, byte_size, sha256
) values (
    sqlc.arg(presentation_handle), sqlc.arg(tenant_id), sqlc.arg(recording_id),
    sqlc.arg(ordinal), sqlc.arg(asset_id), sqlc.arg(asset_kind),
    sqlc.arg(object_key), sqlc.arg(object_version), sqlc.arg(object_etag),
    sqlc.arg(content_type), sqlc.arg(byte_size), sqlc.arg(sha256)
)
on conflict (presentation_handle, ordinal) do nothing
returning *;

-- name: GetRecordingPresentationForRender :one
select presentations.presentation_handle, presentations.schema_version,
    presentations.profile_version, presentations.duration_millis,
    presentations.presentation_sha256, sources.capture_ready_at,
    presentations.presentation_object_key, presentations.presentation_object_version,
    presentations.presentation_object_etag, presentations.presentation_content_type,
    presentations.presentation_byte_size,
    presentations.asset_manifest_object_key, presentations.asset_manifest_object_version,
    presentations.asset_manifest_object_etag, presentations.asset_manifest_content_type,
    presentations.asset_manifest_byte_size, presentations.asset_manifest_sha256
from recording_presentations presentations
join recording_presentation_sources sources using (presentation_handle)
where presentations.tenant_id = sqlc.arg(tenant_id)
  and presentations.space_id = sqlc.arg(space_id)
  and presentations.episode_id = sqlc.arg(episode_id)
  and presentations.recording_id = sqlc.arg(recording_id)
  and presentations.presentation_handle = sqlc.arg(presentation_handle)
  and presentations.capture_epoch = sqlc.arg(capture_epoch);

-- name: ListRecordingPresentationAssetsForRender :many
select ordinal, asset_id, asset_kind, object_key, object_version,
    object_etag, content_type, byte_size, sha256
from recording_presentation_assets
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and presentation_handle = sqlc.arg(presentation_handle)
order by ordinal;

-- name: InsertActiveRecordingPresentationReaction :one
insert into recording_presentation_reactions (
    reaction_id, presentation_handle, tenant_id, space_id, episode_id,
    recording_id, participant_id, participant_generation, display_name,
    reaction, occurred_at, expires_at
)
select sqlc.arg(reaction_id), sources.presentation_handle, sources.tenant_id,
    sources.space_id, sources.episode_id, sources.recording_id,
    sqlc.arg(participant_id), sqlc.arg(participant_generation),
    sqlc.arg(display_name), sqlc.arg(reaction), sqlc.arg(occurred_at),
    sqlc.arg(expires_at)
from recording_presentation_sources sources
join sync_recordings recordings
  on recordings.tenant_id = sources.tenant_id
 and recordings.space_id = sources.space_id
 and recordings.episode_id = sources.episode_id
 and recordings.recording_id = sources.recording_id
where sources.tenant_id = sqlc.arg(tenant_id)
  and sources.space_id = sqlc.arg(space_id)
  and sources.episode_id = sqlc.arg(episode_id)
  and recordings.status in ('recording', 'stopping')
  and sqlc.arg(occurred_at)::timestamptz >= sources.capture_ready_at
on conflict (reaction_id) do nothing
returning *;

-- name: ListRecordingPresentationReactions :many
select * from recording_presentation_reactions
where tenant_id = sqlc.arg(tenant_id)
  and recording_id = sqlc.arg(recording_id)
  and presentation_handle = sqlc.arg(presentation_handle)
  and occurred_at <= sqlc.arg(ended_at)
order by occurred_at, reaction_id;
