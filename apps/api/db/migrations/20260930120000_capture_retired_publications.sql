-- +goose Up
create table recording_capture_retired_publications (
    tenant_id uuid not null references tenants(id) on delete restrict,
    episode_id uuid not null references episodes(id) on delete restrict,
    publication_id text not null check (octet_length(publication_id) between 1 and 512),
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, publication_id)
);

-- +goose Down
drop table if exists recording_capture_retired_publications;
