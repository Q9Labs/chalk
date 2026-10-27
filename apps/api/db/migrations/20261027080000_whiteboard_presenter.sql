-- +goose Up
alter table sync_whiteboard_scenes add column presenting_participant_id uuid;

-- +goose Down
alter table sync_whiteboard_scenes drop column presenting_participant_id;
