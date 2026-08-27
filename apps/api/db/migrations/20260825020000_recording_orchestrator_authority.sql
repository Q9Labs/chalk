-- +goose Up
alter table provider_operation_receipts
    drop constraint if exists provider_operation_receipts_recording_id_fkey,
    drop constraint if exists provider_operation_receipts_recording_id_fkey1;

alter table recording_reservations
    add column policy_snapshot_version text;

update recording_reservations
set policy_snapshot_version = 'episode_config.v2'
where policy_snapshot_version is null;

alter table recording_reservations
    alter column policy_snapshot_version set not null,
    add constraint recording_reservations_policy_snapshot_version_check
        check (policy_snapshot_version = 'episode_config.v2');

alter table recording_pipelines
    add column stop_operation_id uuid,
    add column stop_requested_at timestamptz,
    add constraint recording_pipelines_stop_pair_check
        check ((stop_operation_id is null) = (stop_requested_at is null));

create unique index recording_pipelines_stop_operation_id_idx
    on recording_pipelines(stop_operation_id)
    where stop_operation_id is not null;

-- +goose Down
drop index if exists recording_pipelines_stop_operation_id_idx;

alter table recording_pipelines
    drop constraint if exists recording_pipelines_stop_pair_check,
    drop column if exists stop_requested_at,
    drop column if exists stop_operation_id;

alter table recording_reservations
    drop constraint if exists recording_reservations_policy_snapshot_version_check,
    drop column if exists policy_snapshot_version;

alter table provider_operation_receipts
    drop constraint if exists provider_operation_receipts_recording_id_fkey,
    drop constraint if exists provider_operation_receipts_recording_id_fkey1,
    add constraint provider_operation_receipts_recording_id_fkey
        foreign key (recording_id) references recordings(id) on delete restrict;
