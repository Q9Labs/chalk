-- name: GetTranscriptTextMetadata :one
select spaces.name as space_title,
    coalesce(sources.capture_ready_at, recordings.created_at)::timestamptz as started_at,
    coalesce(presentations.duration_millis, recordings.duration_millis, 0)::bigint as duration_millis
from transcriptions
join recordings on recordings.tenant_id = transcriptions.tenant_id
    and recordings.id = transcriptions.recording_id
join spaces on spaces.tenant_id = transcriptions.tenant_id
    and spaces.id = transcriptions.space_id
left join recording_presentations presentations
    on presentations.tenant_id = recordings.tenant_id and presentations.recording_id = recordings.id
left join recording_presentation_sources sources
    on sources.tenant_id = presentations.tenant_id and sources.presentation_handle = presentations.presentation_handle
where transcriptions.tenant_id = sqlc.arg(tenant_id) and transcriptions.id = sqlc.arg(transcript_id);
