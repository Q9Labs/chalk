-- +goose Up
-- The Space/Episode bridge recreated recording_reservations while its legacy
-- table still held the original inline CHECK name, so PostgreSQL added "1".
-- Widen CHECKs atomically; old releases can still write their shorter recordings.
alter table recording_reservations drop constraint recording_reservations_max_duration_seconds_check1;
alter table recording_reservations add constraint recording_reservations_max_duration_seconds_check1 check (max_duration_seconds between 1 and 14400);
alter table recording_render_object_allocations drop constraint recording_render_allocations_purpose_facts_check;
alter table recording_render_object_allocations add constraint recording_render_allocations_purpose_facts_check check (
        (purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 14400000)))
        or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))
        or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))
);

-- +goose Down
-- Restore the same CHECK names and bounds. PostgreSQL validates existing rows
-- before commit, so longer reservations or artifacts abort this transaction.
alter table recording_reservations drop constraint recording_reservations_max_duration_seconds_check1;
alter table recording_reservations add constraint recording_reservations_max_duration_seconds_check1 check (max_duration_seconds between 1 and 7200);
alter table recording_render_object_allocations drop constraint recording_render_allocations_purpose_facts_check;
alter table recording_render_object_allocations add constraint recording_render_allocations_purpose_facts_check check (
        (purpose = 'recording_video' and (state = 'reserved' or (expected_content_type = 'video/mp4' and expected_byte_size <= 34359738368 and expected_duration_millis between 1 and 7200000)))
        or (purpose = 'transcription_manifest' and (state = 'reserved' or (expected_content_type = 'application/json' and expected_byte_size <= 1048576 and expected_duration_millis is null)))
        or (purpose = 'transcription_audio' and (state = 'reserved' or (expected_content_type = 'audio/flac' and expected_byte_size <= 524288000 and expected_duration_millis between 1 and 900000)))
);
