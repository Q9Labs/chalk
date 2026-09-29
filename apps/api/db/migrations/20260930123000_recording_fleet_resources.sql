-- +goose Up
alter table recording_fleet_nodes
    add column resources_latest jsonb,
    add column peak_rss_bytes bigint not null default 0 check (peak_rss_bytes >= 0);

create index recording_jobs_active_lease_owner_idx
    on recording_jobs(lease_owner) where state = 'leased';

-- +goose Down
drop index recording_jobs_active_lease_owner_idx;
alter table recording_fleet_nodes
    drop column resources_latest,
    drop column peak_rss_bytes;
