-- name: ListEpisodeTalkTimeRecordings :many
-- Each Recording of the Episode with its transcript, if any. A Recording's
-- timeline starts when its capture became ready, falling back to the row's
-- creation time for Recordings that predate presentation sources.
select recordings.id as recording_id,
    recordings.status as recording_status,
    coalesce(sources.capture_ready_at, recordings.created_at)::timestamptz as started_at,
    coalesce(transcriptions.status, '')::text as transcription_status,
    transcriptions.artifact_key,
    transcriptions.artifact_size,
    transcriptions.artifact_content_type,
    transcriptions.deleted_at as transcription_deleted_at,
    case
        when episodes.config_snapshot #>> '{artifact_policy,transcription,mode}' in ('on_demand', 'automatic')
            then episodes.config_snapshot #>> '{artifact_policy,transcription,mode}'
        else 'disabled'
    end::text as transcription_mode
from recordings
join episodes on episodes.tenant_id = recordings.tenant_id
    and episodes.id = recordings.episode_id
left join transcriptions on transcriptions.tenant_id = recordings.tenant_id
    and transcriptions.recording_id = recordings.id
left join recording_presentations presentations
    on presentations.tenant_id = recordings.tenant_id and presentations.recording_id = recordings.id
left join recording_presentation_sources sources
    on sources.tenant_id = presentations.tenant_id and sources.presentation_handle = presentations.presentation_handle
where recordings.tenant_id = sqlc.arg(tenant_id)
  and recordings.space_id = sqlc.arg(space_id)
  and recordings.episode_id = sqlc.arg(episode_id)
order by started_at, recordings.id
limit sqlc.arg(row_limit)::integer;
