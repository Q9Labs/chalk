-- +goose Up
alter table sync_external_operations
    drop constraint if exists sync_external_operations_operation_name_check,
    drop constraint if exists sync_external_operations_operation_name_check1,
    add constraint sync_external_operations_operation_name_check
        check (operation_name in (
            'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
            'stop_participant_camera', 'stop_participant_screen_share',
            'remove_participant', 'start_recording', 'stop_recording',
            'recording_capture_ready', 'recording_capture_stopped', 'recording_capture_failed',
            'participant_leave', 'end_episode', 'tenant_assign_roles', 'tenant_set_deadline',
            'tenant_end_episode', 'maximum_episode_duration_expired',
            'role_transition_cleanup', 'role_transition_source_stop'
        ));

-- +goose Down
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
