-- +goose Up
alter table participants
    add column description text;

-- +goose Down
alter table participants
    drop column description;
