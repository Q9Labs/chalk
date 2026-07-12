-- name: UpsertRecordingTranscriptionSource :one
insert into recording_transcription_sources (
    recording_id, tenant_id, manifest_key, manifest_sha256, manifest_size,
    manifest_content_type, schema_version, committed_at
) values ($1, $2, $3, $4, $5, $6, $7, $8)
on conflict (recording_id) do update set
    tenant_id = excluded.tenant_id,
    manifest_key = excluded.manifest_key,
    manifest_sha256 = excluded.manifest_sha256,
    manifest_size = excluded.manifest_size,
    manifest_content_type = excluded.manifest_content_type,
    schema_version = excluded.schema_version,
    committed_at = excluded.committed_at
returning *;

-- name: ReplaceRecordingTranscriptionSourceChunk :one
insert into recording_transcription_source_chunks (
    id, recording_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key, checksum, size, content_type
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
on conflict (recording_id, generation, chunk_index) do update set
    id = excluded.id, tenant_id = excluded.tenant_id, start_ms = excluded.start_ms,
    end_ms = excluded.end_ms, participant_ref = excluded.participant_ref,
    track_epoch = excluded.track_epoch, identity_kind = excluded.identity_kind,
    track_class = excluded.track_class, storage_key = excluded.storage_key,
    checksum = excluded.checksum, size = excluded.size, content_type = excluded.content_type
returning *;

-- name: GetRecordingTranscriptionSource :one
select * from recording_transcription_sources where recording_id = $1 and tenant_id = $2;

-- name: ListRecordingTranscriptionSourceChunks :many
select * from recording_transcription_source_chunks
where recording_id = $1 and tenant_id = $2 order by generation, chunk_index;
