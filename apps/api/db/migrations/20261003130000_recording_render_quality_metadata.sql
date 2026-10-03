-- +goose Up
alter table recording_jobs add column result_metadata jsonb not null default '{}'::jsonb;

-- +goose Down
alter table recording_jobs drop column result_metadata;
