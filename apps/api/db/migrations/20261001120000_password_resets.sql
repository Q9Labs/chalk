-- +goose Up
SET LOCAL lock_timeout = '5s';
create table password_resets (
    account_id uuid primary key references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index password_resets_expires_at_idx on password_resets(expires_at);

-- +goose Down
SET LOCAL lock_timeout = '5s';
drop table password_resets;
