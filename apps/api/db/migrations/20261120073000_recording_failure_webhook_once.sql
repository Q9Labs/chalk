-- +goose Up
alter table recording_pipelines add column failure_webhook_enqueued boolean not null default false;

update recording_pipelines pipelines
set failure_webhook_enqueued = true
from webhook_events events
where events.event_name = 'recording.failed' and events.resource_type = 'recording'
    and events.tenant_id = pipelines.tenant_id and events.resource_id = pipelines.recording_id;

-- +goose StatementBegin
create function enqueue_recording_failure_webhook_once() returns trigger language plpgsql as $$
begin
    -- The capture can outlive webhook retention. Keep the enqueue fact with
    -- the Recording, not the event that the webhook worker will prune.
    update recording_pipelines
    set failure_webhook_enqueued = true
    where recording_id = new.resource_id and tenant_id = new.tenant_id
        and not failure_webhook_enqueued;
    if found then
        return new;
    end if;
    return null;
end;
$$;
-- +goose StatementEnd

create trigger webhook_events_recording_failure_once
    before insert on webhook_events
    for each row when (new.event_name = 'recording.failed')
    execute function enqueue_recording_failure_webhook_once();

-- +goose Down
drop trigger webhook_events_recording_failure_once on webhook_events;
drop function enqueue_recording_failure_webhook_once();
alter table recording_pipelines drop column failure_webhook_enqueued;
