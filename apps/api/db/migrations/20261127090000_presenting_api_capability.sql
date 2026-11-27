-- +goose Up
-- The API writes whether this release can serve Presenting; Sync reads it so it never offers what the API refuses.
create table presenting_api_capability (
    singleton boolean primary key default true check (singleton),
    servable boolean not null,
    updated_at timestamptz not null default now()
);

-- +goose Down
drop table presenting_api_capability;
