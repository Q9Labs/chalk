-- +goose Up
alter table recordings
    add column deleted_at timestamptz,
    add column deleted_by text check (deleted_by is null or octet_length(deleted_by) between 1 and 256);

alter table recordings
    add constraint recordings_deleted_state_check
    check ((status = 'deleted') = (deleted_at is not null) and (deleted_at is null) = (deleted_by is null)) not valid;

alter table recordings validate constraint recordings_deleted_state_check;

alter table webhook_endpoint_revisions drop constraint webhook_endpoint_revisions_event_types_check;
alter table webhook_endpoint_revisions add constraint webhook_endpoint_revisions_event_types_check check (
    cardinality(event_types) between 1 and 16
    and event_types <@ array[
        'space.created',
        'space.updated',
        'space.archived',
        'space.restored',
        'episode.started',
        'episode.ended',
        'participant.joined',
        'participant.left',
        'recording.started',
        'recording.completed',
        'recording.failed',
        'recording.deleted',
        'transcript.started',
        'transcript.completed',
        'transcript.failed',
        'transcript.deleted'
    ]::text[]
);

alter table webhook_events drop constraint webhook_events_name_check;
alter table webhook_events add constraint webhook_events_name_check check (event_name in (
    'space.created',
    'space.updated',
    'space.archived',
    'space.restored',
    'episode.started',
    'episode.ended',
    'participant.joined',
    'participant.left',
    'recording.started',
    'recording.completed',
    'recording.failed',
    'recording.deleted',
    'transcript.started',
    'transcript.completed',
    'transcript.failed',
    'transcript.deleted',
    'endpoint.test'
));

-- +goose Down
alter table webhook_endpoint_revisions drop constraint webhook_endpoint_revisions_event_types_check;
alter table webhook_endpoint_revisions add constraint webhook_endpoint_revisions_event_types_check check (
    cardinality(event_types) between 1 and 14
    and event_types <@ array[
        'space.created',
        'space.updated',
        'space.archived',
        'space.restored',
        'episode.started',
        'episode.ended',
        'participant.joined',
        'participant.left',
        'recording.started',
        'recording.completed',
        'recording.failed',
        'transcript.started',
        'transcript.completed',
        'transcript.failed'
    ]::text[]
);

alter table webhook_events drop constraint webhook_events_name_check;
alter table webhook_events add constraint webhook_events_name_check check (event_name in (
    'space.created',
    'space.updated',
    'space.archived',
    'space.restored',
    'episode.started',
    'episode.ended',
    'participant.joined',
    'participant.left',
    'recording.started',
    'recording.completed',
    'recording.failed',
    'transcript.started',
    'transcript.completed',
    'transcript.failed',
    'endpoint.test'
));

alter table recordings drop constraint recordings_deleted_state_check;
alter table recordings drop column deleted_at, drop column deleted_by;
