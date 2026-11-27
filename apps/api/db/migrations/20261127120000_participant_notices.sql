-- +goose Up
alter table participants
    add column notice text;

-- +goose Down
alter table participants
    drop column notice;
