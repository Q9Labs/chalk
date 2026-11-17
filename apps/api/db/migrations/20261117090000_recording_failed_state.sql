-- +goose Up
-- recordings.status already allows 'failed' in the public contract, but nothing wrote it:
-- a terminal pipeline left the Recording 'pending' forever. One trigger on the pipeline keeps
-- the public row honest on every path that reaches or leaves terminal_failure.
alter table recordings
    add column failure_code text check (failure_code is null or octet_length(failure_code) between 1 and 128),
    add column failed_at timestamptz;

alter table recordings
    add constraint recordings_failure_state_check
    check ((status = 'failed') = (failure_code is not null) and (failure_code is null) = (failed_at is null)) not valid;

-- Capture facts recorded when the capture completes. NULL means the capture predates the counters.
alter table recording_pipelines
    add column capture_media_bundle_count integer check (capture_media_bundle_count is null or capture_media_bundle_count >= 0),
    add column capture_gap_bundle_count integer check (capture_gap_bundle_count is null or capture_gap_bundle_count >= 0);

-- +goose StatementBegin
create function recording_sync_failed_status() returns trigger language plpgsql as $$
declare
    failed_code text;
begin
    if new.state = 'terminal_failure' then
        update recordings
        set status = 'failed', failed_at = now(), updated_at = now(),
            failure_code = coalesce(
                (select jobs.error_code from recording_jobs jobs
                 where jobs.recording_id = new.recording_id and jobs.state = 'terminal_failure'
                   and jobs.kind <> 'transcription' and jobs.error_code is not null
                 order by jobs.terminal_at desc nulls last, jobs.updated_at desc limit 1),
                case when old.state in ('requested', 'reserved') then 'capture_reservation_expired' end,
                'recording_failed')
        where id = new.recording_id and status in ('pending', 'processing')
        returning failure_code into failed_code;
        if failed_code is not null then
            -- The Episode's own timeline shows the failure next to the claim that started the work.
            insert into observability_journey_events (
                event_id, journey_id, sequence, occurred_at, name, phase, state,
                origin_kind, first_observed_layer, upstream_visibility, parent_event_id, attributes
            )
            select gen_random_uuid(), journey.journey_id,
                coalesce((select max(events.sequence) + 1 from observability_journey_events events
                          where events.journey_id = journey.journey_id), 0),
                now(), 'recording.failed', 'recording_failure', 'failed', 'server', 'api', 'visible',
                journey.parent_event_id,
                jsonb_build_object('recording_id', new.recording_id, 'failure_code', failed_code)
            from (
                select coalesce(start_operation.journey_id, new.recording_id) as journey_id,
                    start_operation.parent_journey_event_id as parent_event_id
                from recordings
                left join sync_recordings recording on recording.recording_id = recordings.id
                left join sync_external_operations start_operation
                    on start_operation.external_operation_id = recording.start_external_operation_id
                    and start_operation.recording_id = recordings.id and start_operation.operation_name = 'start_recording'
                where recordings.id = new.recording_id
            ) journey;
        end if;
    elsif old.state = 'terminal_failure' then
        -- A retry reopened the pipeline: the Recording is in flight again, not failed.
        update recordings
        set status = 'pending', failed_at = null, failure_code = null, updated_at = now()
        where id = new.recording_id and status = 'failed';
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger recording_pipelines_sync_failed_status
    after update of state on recording_pipelines
    for each row when (old.state is distinct from new.state)
    execute function recording_sync_failed_status();

-- Recordings that already ended in terminal failure now say so.
update recordings
set status = 'failed', failed_at = pipelines.updated_at,
    failure_code = coalesce(
        (select jobs.error_code from recording_jobs jobs
         where jobs.recording_id = recordings.id and jobs.state = 'terminal_failure'
           and jobs.kind <> 'transcription' and jobs.error_code is not null
         order by jobs.terminal_at desc nulls last, jobs.updated_at desc limit 1),
        'recording_failed')
from recording_pipelines pipelines
where pipelines.recording_id = recordings.id and pipelines.state = 'terminal_failure'
  and recordings.status in ('pending', 'processing');

-- A failed Recording that predates the code (a seed or hand-edited row) gets the generic one.
update recordings set failure_code = 'recording_failed', failed_at = coalesce(failed_at, updated_at)
where status = 'failed' and failure_code is null;

alter table recordings validate constraint recordings_failure_state_check;

-- +goose Down
drop trigger recording_pipelines_sync_failed_status on recording_pipelines;
drop function recording_sync_failed_status();
-- The previous release only knows pending and completed; failed rows go back to the old reading.
update recordings set status = 'pending', failure_code = null, failed_at = null where status = 'failed';
alter table recordings drop constraint recordings_failure_state_check;
alter table recordings drop column failure_code, drop column failed_at;
alter table recording_pipelines drop column capture_media_bundle_count, drop column capture_gap_bundle_count;
