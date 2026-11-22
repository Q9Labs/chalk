-- +goose Up
create table screen_annotation_settings (
    singleton boolean primary key default true check (singleton),
    enabled boolean not null
);

-- +goose Down
drop table screen_annotation_settings;
