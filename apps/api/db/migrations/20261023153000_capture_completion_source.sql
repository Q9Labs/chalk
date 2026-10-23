-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION recording_capture_stop_confirmed(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id AND recording.tenant_id = pipeline.tenant_id
        JOIN sync_external_operations operation ON operation.tenant_id = job.tenant_id
            AND operation.episode_id = job.episode_id AND operation.recording_id = job.recording_id
        WHERE pipeline.recording_id = target_recording_id AND recording.status = 'stopped'
          AND operation.payload ->> 'stopOperationId' = recording.stop_external_operation_id::text
          AND operation.payload -> 'captureEpoch' = to_jsonb(pipeline.capture_epoch)
          AND operation.operation_name = 'recording_capture_stopped' AND operation.status = 'applied'
    );
$$;

CREATE FUNCTION recording_capture_completion_available(target_recording_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM recording_pipelines pipeline
        JOIN recording_jobs job ON job.recording_id = pipeline.recording_id AND job.kind = 'capture'
        JOIN episodes episode ON episode.id = job.episode_id
        JOIN sync_recordings recording ON recording.recording_id = pipeline.recording_id
            AND recording.tenant_id = pipeline.tenant_id
        WHERE pipeline.recording_id = target_recording_id
          AND pipeline.stop_requested_at IS NOT NULL
          AND pipeline.capture_ready_at IS NOT NULL
          AND (
              recording_capture_stop_confirmed(target_recording_id) OR (
                  pipeline.stop_requested_at + recording_deferred_retention_seconds(episode.config_snapshot) * interval '1 second' > clock_timestamp()
                  AND EXISTS (SELECT 1 FROM recording_bundles bundle WHERE bundle.recording_id = pipeline.recording_id)
                  AND EXISTS (SELECT 1 FROM recording_data_keys key WHERE key.recording_id = pipeline.recording_id
                              AND key.capture_epoch = pipeline.capture_epoch)
              )
          )
    );
$$;
-- +goose StatementEnd

-- +goose Down
DROP FUNCTION recording_capture_completion_available(uuid);
DROP FUNCTION recording_capture_stop_confirmed(uuid);
