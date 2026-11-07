-- +goose Up
-- The revision at which Sync decided a source grant or stop. The own SFU orders grants and
-- revokes for one source by it, and the API renews a grant's forwarding lease only while no
-- stop decided at or after it exists. Every decision takes the next value of one sequence while
-- it holds the Episode row lock, so within an Episode revisions are unique and rise in commit
-- order. A grant decided after a stop is strictly newer even when the stop failed without
-- committing a control event. Rows written before this column carry null and are never renewed.
create sequence sync_source_control_revisions as bigint;
alter table sync_publication_grant_reservations
    add column control_revision bigint check (control_revision > 0);
alter table sync_external_operations
    add column control_revision bigint check (control_revision > 0);

-- Lease renewal reads the newest confirmed grant of every source in a live Episode.
create index sync_publication_grant_reservations_confirmed_source_idx
    on sync_publication_grant_reservations(tenant_id, episode_id, participant_id, source, control_revision desc)
    where status = 'confirmed' and control_revision is not null;

-- +goose Down
drop index sync_publication_grant_reservations_confirmed_source_idx;
alter table sync_external_operations drop column control_revision;
alter table sync_publication_grant_reservations drop column control_revision;
drop sequence sync_source_control_revisions;
