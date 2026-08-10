-- +goose Up
alter table participants
    add column account_id uuid references users(id) on delete restrict;

create unique index participants_dashboard_account_episode_idx
    on participants(tenant_id, episode_id, account_id)
    where account_id is not null;

create index participants_dashboard_account_space_idx
    on participants(tenant_id, space_id, account_id, created_at desc)
    where account_id is not null;

-- +goose Down
drop index if exists participants_dashboard_account_space_idx;
drop index if exists participants_dashboard_account_episode_idx;
alter table participants
    drop column if exists account_id;
