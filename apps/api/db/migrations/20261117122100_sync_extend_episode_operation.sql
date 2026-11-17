-- +goose Up
-- Extending a call is one more external operation. It is accepted and finalized in one
-- transaction, so no older node ever reads a pending row of this name.
-- chalk:removed-in #1469
alter table sync_external_operations
    drop constraint sync_external_operations_operation_name_check,
    add constraint sync_external_operations_operation_name_check
        check (operation_name in (
            'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
            'stop_participant_camera', 'stop_participant_screen_share',
            'remove_participant', 'start_recording', 'stop_recording',
            'recording_capture_ready', 'recording_capture_stopped', 'recording_capture_failed',
            'participant_leave', 'end_episode', 'extend_episode', 'tenant_assign_roles', 'tenant_set_deadline',
            'tenant_end_episode', 'maximum_episode_duration_expired',
            'role_transition_cleanup', 'role_transition_source_stop'
        ));
-- The baseline left this CHECK unnamed, so the migration finds it by what it says.
-- chalk:removed-in #1469
-- +goose StatementBegin
do $$
declare
    deadline_check text;
begin
    select conname into strict deadline_check
    from pg_constraint
    where conrelid = 'sync_external_operations'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%maximum_episode_duration_expired%deadline_generation IS NOT NULL%';
    execute format('alter table sync_external_operations drop constraint %I', deadline_check);
end
$$;
-- +goose StatementEnd
alter table sync_external_operations
    add constraint sync_external_operations_deadline_generation_check
        check (
            (operation_name in ('tenant_set_deadline', 'extend_episode', 'maximum_episode_duration_expired'))
            = (deadline_generation is not null)
        );

-- +goose Down
-- PostgreSQL validates existing rows before commit, so a database that still holds an
-- extension aborts this transaction.
alter table sync_external_operations drop constraint sync_external_operations_deadline_generation_check;
alter table sync_external_operations
    add check (
        (operation_name in ('tenant_set_deadline', 'maximum_episode_duration_expired'))
        = (deadline_generation is not null)
    );
alter table sync_external_operations
    drop constraint sync_external_operations_operation_name_check,
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
