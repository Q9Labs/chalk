-- +goose Up
create table recording_capture_stop_publications (
    recording_id uuid primary key references recording_pipelines(recording_id) on delete cascade,
    stop_operation_id uuid not null,
    capture_epoch bigint not null check (capture_epoch > 0),
    producing_trace_id text,
    producing_span_id text,
    created_at timestamptz not null default clock_timestamp(),
    next_attempt_at timestamptz not null default clock_timestamp(),
    attempt_count bigint not null default 0 check (attempt_count >= 0),
    last_error_code text,
    resolved_at timestamptz
);

create index recording_capture_stop_publications_due
    on recording_capture_stop_publications(next_attempt_at, recording_id) where resolved_at is null;

-- +goose StatementBegin
create function recording_try_publish_capture_stop(target_recording_id uuid, observed_at timestamptz)
returns void language plpgsql volatile as $$
declare
    obligation recording_capture_stop_publications%rowtype;
begin
    select * into obligation from recording_capture_stop_publications
    where recording_id = target_recording_id and resolved_at is null for update;
    if not found then return; end if;

    -- Completed media, not a live recorder lease, authorizes this retry. A
    -- replaced stop/epoch or an already queued callback retires the obligation.
    if not exists (
        select 1 from recording_pipelines pipeline
        join sync_recordings recording on recording.tenant_id = pipeline.tenant_id
            and recording.recording_id = pipeline.recording_id
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id
            and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
        where pipeline.recording_id = obligation.recording_id and pipeline.capture_completed_at is not null
            and pipeline.stop_operation_id = obligation.stop_operation_id and pipeline.capture_epoch = obligation.capture_epoch
            and recording.status = 'stopping' and recording.stop_external_operation_id = obligation.stop_operation_id
            and not exists (
                select 1 from sync_external_operations operation
                where operation.tenant_id = recording.tenant_id and operation.episode_id = recording.episode_id
                    and operation.operation_name = 'recording_capture_stopped' and operation.recording_id = recording.recording_id
                    and operation.status in ('pending', 'applied')
                    and operation.payload ->> 'stopOperationId' = obligation.stop_operation_id::text
                    and operation.payload ->> 'captureEpoch' = obligation.capture_epoch::text
            )
    ) then
        update recording_capture_stop_publications set resolved_at = observed_at, last_error_code = null
        where recording_id = target_recording_id;
        return;
    end if;

    -- Sync records the intent before dispatching the stop to the API. Media
    -- can finish before Sync commits that source operation's applied result.
    if exists (
        select 1 from sync_external_operations source
        join recording_pipelines pipeline on pipeline.tenant_id = source.tenant_id
            and pipeline.recording_id = source.recording_id
        where pipeline.recording_id = target_recording_id
            and source.external_operation_id = obligation.stop_operation_id and source.status = 'pending'
    ) then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = 'source_pending',
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end if;

    -- Retry counters saturate at bigint max; publication has no attempt budget.
    -- Only the outbox insert is a subtransaction. Its failure cannot undo the
    -- completed capture, released reservation, or durable retry obligation.
    begin
        insert into sync_external_operations (
            tenant_id, space_id, episode_id, external_operation_id, request_key,
            request_fingerprint, operation_name, recording_id, payload, fence_active,
            journey_id, parent_journey_event_id, producing_trace_id, producing_span_id
        )
        select recording.tenant_id, recording.space_id, recording.episode_id, gen_random_uuid(),
            'capture_complete_recovery_' || recording.recording_id::text || '_' || obligation.capture_epoch::text,
            sha256(convert_to(payload.value::text, 'UTF8')), 'recording_capture_stopped', recording.recording_id,
            payload.value, false, source.journey_id, source.parent_journey_event_id,
            obligation.producing_trace_id, obligation.producing_span_id
        from sync_recordings recording
        join sync_external_operations source on source.tenant_id = recording.tenant_id
            and source.space_id = recording.space_id and source.episode_id = recording.episode_id
            and source.recording_id = recording.recording_id and source.external_operation_id = obligation.stop_operation_id
            and source.operation_name = 'stop_recording' and source.status = 'applied'
        cross join lateral (
            select jsonb_build_object('recordingId', recording.recording_id::text,
                'stopOperationId', obligation.stop_operation_id::text, 'captureEpoch', obligation.capture_epoch) as value
        ) payload
        where recording.recording_id = obligation.recording_id and recording.status = 'stopping'
            and recording.stop_external_operation_id = obligation.stop_operation_id
        on conflict (tenant_id, episode_id, operation_name, request_key) do nothing;
    exception when query_canceled or others then
        update recording_capture_stop_publications
        set attempt_count = least(attempt_count, 9223372036854775806) + 1, last_error_code = SQLSTATE,
            next_attempt_at = observed_at + least(300, 5 * power(2, least(attempt_count, 6))::integer) * interval '1 second'
        where recording_id = target_recording_id;
        return;
    end;
    update recording_capture_stop_publications
    set attempt_count = least(attempt_count, 9223372036854775806) + 1, resolved_at = observed_at, last_error_code = null
    where recording_id = target_recording_id;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create or replace function recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text)
returns boolean language plpgsql volatile as $$
begin
    insert into recording_capture_stop_publications(recording_id, stop_operation_id, capture_epoch, producing_trace_id, producing_span_id)
    select pipeline.recording_id, pipeline.stop_operation_id, pipeline.capture_epoch, trace_id, span_id
    from recording_pipelines pipeline
    join sync_external_operations source on source.tenant_id = pipeline.tenant_id
        and source.recording_id = pipeline.recording_id and source.external_operation_id = pipeline.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status in ('pending', 'applied')
    where pipeline.recording_id = source_recording_id and pipeline.capture_completed_at is not null
        and pipeline.capture_epoch > 0
    on conflict (recording_id) do nothing;
    perform recording_try_publish_capture_stop(source_recording_id, clock_timestamp());
    return true;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function recording_drain_capture_stop_publications(observed_at timestamptz, batch_size integer)
returns integer language plpgsql volatile as $$
declare
    obligation record;
    attempted integer := 0;
begin
    for obligation in
        select recording_id from recording_capture_stop_publications
        where resolved_at is null and next_attempt_at <= observed_at
        order by next_attempt_at, recording_id
        for update skip locked limit greatest(0, least(batch_size, 100))
    loop
        perform recording_try_publish_capture_stop(obligation.recording_id, observed_at);
        attempted := attempted + 1;
    end loop;
    return attempted;
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- Restored below; completed media remains the previous release's repair source.
-- +goose StatementBegin
create or replace function recording_publish_completed_capture_stop(source_recording_id uuid, trace_id text, span_id text)
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
exception when query_canceled or others then
    -- Keep the failure stage across the API boundary without exposing SQL details.
    raise exception using errcode = 'PC001', message = 'capture stopped publication failed';
end;
$$;
-- +goose StatementEnd
drop function recording_drain_capture_stop_publications(timestamptz, integer);
drop function recording_try_publish_capture_stop(uuid, timestamptz);
drop table recording_capture_stop_publications;
