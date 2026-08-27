-- +goose Up
alter table sync_external_operations
    drop constraint if exists sync_external_operations_operation_name_check,
    drop constraint if exists sync_external_operations_operation_name_check1,
    add constraint sync_external_operations_operation_name_check
        check (operation_name in (
            'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
            'stop_participant_camera', 'stop_participant_screen_share',
            'remove_participant', 'start_recording', 'stop_recording',
            'recording_capture_ready', 'recording_capture_stopped',
            'participant_leave', 'end_episode', 'tenant_assign_roles', 'tenant_set_deadline',
            'tenant_end_episode', 'maximum_episode_duration_expired',
            'role_transition_cleanup', 'role_transition_source_stop'
        ));

alter table recordings
    add column storage_content_type text,
    add column storage_size bigint,
    add column storage_checksum bytea,
    add column duration_millis bigint,
    add column completed_at timestamptz;

alter table recordings
    add constraint recordings_storage_size_check
        check (storage_size is null or storage_size >= 0),
    add constraint recordings_storage_checksum_check
        check (storage_checksum is null or octet_length(storage_checksum) between 16 and 128),
    add constraint recordings_duration_millis_check
        check (duration_millis is null or duration_millis >= 0);

create unique index recording_reservations_recording_id_idx
    on recording_reservations(recording_id);

-- +goose Down
alter table sync_external_operations
    drop constraint if exists sync_external_operations_operation_name_check,
    drop constraint if exists sync_external_operations_operation_name_check1,
    add constraint sync_external_operations_operation_name_check
        check (operation_name in (
            'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
            'stop_participant_camera', 'stop_participant_screen_share',
            'remove_participant', 'start_recording', 'stop_recording',
            'participant_leave', 'end_episode', 'tenant_assign_roles', 'tenant_set_deadline',
            'tenant_end_episode', 'maximum_episode_duration_expired',
            'role_transition_cleanup', 'role_transition_source_stop'
        ));

drop index recording_reservations_recording_id_idx;
alter table recordings
    drop constraint recordings_duration_millis_check,
    drop constraint recordings_storage_checksum_check,
    drop constraint recordings_storage_size_check,
    drop column completed_at,
    drop column duration_millis,
    drop column storage_checksum,
    drop column storage_size,
    drop column storage_content_type;
