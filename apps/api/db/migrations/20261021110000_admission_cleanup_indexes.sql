-- +goose Up
create index participants_admission_cleanup_active_idx
    on participants(tenant_id, episode_id, id)
    where status = 'active';
create index sync_admission_requests_admitted_participant_idx
    on sync_admission_requests(tenant_id, episode_id, participant_id)
    where status = 'admitted';

-- +goose Down
drop index sync_admission_requests_admitted_participant_idx;
drop index participants_admission_cleanup_active_idx;
