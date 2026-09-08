-- name: GetRecordingCaptureBinding :one
select episodes.config_snapshot
from recordings
join episodes
  on episodes.id = recordings.episode_id
 and episodes.tenant_id = recordings.tenant_id
 and episodes.space_id = recordings.space_id
where recordings.id = sqlc.arg(recording_id)
  and recordings.tenant_id = sqlc.arg(tenant_id)
  and recordings.space_id = sqlc.arg(space_id)
  and recordings.episode_id = sqlc.arg(episode_id);
