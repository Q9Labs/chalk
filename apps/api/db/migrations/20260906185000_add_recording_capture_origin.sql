-- +goose Up
alter table recording_pipelines
    add column capture_ready_at timestamptz;

comment on column recording_pipelines.capture_ready_at is
    'Immutable recording clock origin established by the first authoritative capture-ready callback.';

-- +goose Down
alter table recording_pipelines
    drop column capture_ready_at;
