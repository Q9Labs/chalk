-- +goose Up
alter table participants
    add column first_joined_at timestamptz,
    add column last_left_reason text check (last_left_reason in ('left', 'episode_ended'));

-- +goose Down
alter table participants drop column last_left_reason, drop column first_joined_at;
