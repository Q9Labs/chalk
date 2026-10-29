-- +goose Up
-- +goose StatementBegin
-- Publication runs after completion has locked the capture job. A volatile
-- function gets a fresh snapshot, including a worker callback that committed
-- while completion waited for that lock.
create function recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text)
returns boolean
language plpgsql
volatile
as $$
begin
    insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active,
        journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
    )
    select recording.tenant_id, recording.space_id, recording.episode_id, gen_random_uuid(),
        'capture_complete_recovery_' || recording.recording_id::text || '_' || pipelines.capture_epoch::text,
        sha256(convert_to(payload.value::text, 'UTF8')), 'recording_capture_stopped', recording.recording_id,
        payload.value, false, source.journey_id, source.parent_journey_event_id, trace_id, span_id
    from recording_pipelines pipelines
    join sync_recordings recording on recording.tenant_id = pipelines.tenant_id
        and recording.recording_id = pipelines.recording_id
    join sync_external_operations source on source.tenant_id = recording.tenant_id
        and source.space_id = recording.space_id and source.episode_id = recording.episode_id
        and source.recording_id = recording.recording_id
        and source.external_operation_id = pipelines.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status = 'applied'
    cross join lateral (
        select jsonb_build_object('recordingId', recording.recording_id::text,
            'stopOperationId', pipelines.stop_operation_id::text,
            'captureEpoch', pipelines.capture_epoch) as value
    ) payload
    where pipelines.recording_id = source_recording_id
      and pipelines.capture_completed_at is not null
      and recording.status = 'stopping'
      and recording.stop_external_operation_id = pipelines.stop_operation_id
      and not exists (
          select 1 from sync_external_operations operation
          where operation.tenant_id = recording.tenant_id
            and operation.episode_id = recording.episode_id
            and operation.operation_name = 'recording_capture_stopped'
            and operation.recording_id = recording.recording_id
            and operation.status in ('pending', 'applied')
            and operation.payload ->> 'stopOperationId' = pipelines.stop_operation_id::text
            and operation.payload ->> 'captureEpoch' = pipelines.capture_epoch::text
      )
    -- Maintenance uses this same key, including when it races publication.
    on conflict (tenant_id, episode_id, operation_name, request_key) do nothing;
    return true;
end;
$$;
-- +goose StatementEnd

-- +goose Down
drop function recording_publish_completed_capture_stop(uuid, text, text);
