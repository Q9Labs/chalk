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
    add constraint sync_external_operations_deadline_operation_check
        check (
            (operation_name in ('tenant_set_deadline', 'extend_episode', 'maximum_episode_duration_expired'))
            = (deadline_generation is not null)
        );
-- An extension is an operation receipt like a leave: pending until finalized, then committed with its operation id.
-- chalk:removed-in #1469
alter table sync_command_receipts drop constraint sync_command_receipts_shape_check;
alter table sync_command_receipts
    add constraint sync_command_receipts_shape_check check (
        (
            command_name in ('raise_hand', 'lower_hand')
            and resulting_state_digest is null
            and external_operation_id is null
            and completed_at is null
            and (
                (
                    outcome = 'committed'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                )
                or (
                    outcome = 'rejected'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'command_id_conflict'
                    )
                    and event_id is null
                    and resulting_revision is null
                )
            )
        )
        or (
            command_name in (
                'set_hand_raised',
                'set_display_name',
                'set_admission_policy',
                'set_participant_role',
                'assign_roles',
                'admit_participant',
                'deny_admission',
                'mute_participant',
                'stop_participant_camera',
                'stop_participant_screen_share',
                'remove_participant',
                'start_recording',
                'stop_recording',
                'participant_leave',
                'start_episode',
                'extend_episode',
                'end_episode'
            )
            and (
                (
                    outcome = 'committed'
                    and command_name <> 'start_episode'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                    and octet_length(resulting_state_digest) = 32
                    and completed_at is not null
                )
                or (
                    outcome = 'satisfied'
                    and rejection_reason is null
                    and event_id is null
                    and resulting_revision >= 0
                    and octet_length(resulting_state_digest) = 32
                    and external_operation_id is null
                    and completed_at is not null
                )
                or (
                    outcome = 'pending'
                    and command_name <> 'start_episode'
                    and rejection_reason is null
                    and external_operation_id is not null
                    and completed_at is null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
                or (
                    outcome = 'rejected'
                    and command_name <> 'start_episode'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'invalid_target',
                        'role_not_eligible',
                        'role_assignment_required',
                        'screen_share_in_use',
                        'recording_in_progress',
                        'recording_policy_disabled',
                        'external_operation_failed'
                    )
                    and (
                        rejection_reason <> 'recording_policy_disabled'
                        or command_name = 'start_recording'
                    )
                    and completed_at is not null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and external_operation_id is not null
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
            )
        )
    );

-- +goose Down
-- PostgreSQL validates existing rows before commit, so a database that still holds an
-- extension aborts this transaction.
alter table sync_external_operations drop constraint sync_external_operations_deadline_operation_check;
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
alter table sync_command_receipts drop constraint sync_command_receipts_shape_check;
alter table sync_command_receipts
    add constraint sync_command_receipts_shape_check check (
        (
            command_name in ('raise_hand', 'lower_hand')
            and resulting_state_digest is null
            and external_operation_id is null
            and completed_at is null
            and (
                (
                    outcome = 'committed'
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                )
                or (
                    outcome = 'rejected'
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'command_id_conflict'
                    )
                    and event_id is null
                    and resulting_revision is null
                )
            )
        )
        or (
            command_name in (
                'set_hand_raised',
                'set_display_name',
                'set_admission_policy',
                'set_participant_role',
                'assign_roles',
                'admit_participant',
                'deny_admission',
                'mute_participant',
                'stop_participant_camera',
                'stop_participant_screen_share',
                'remove_participant',
                'start_recording',
                'stop_recording',
                'participant_leave',
                'start_episode',
                'extend_episode',
                'end_episode'
            )
            and (
                (
                    outcome = 'committed'
                    and command_name <> 'start_episode'
                    and (command_name <> 'extend_episode' or external_operation_id is null)
                    and rejection_reason is null
                    and event_id is not null
                    and resulting_revision > 0
                    and octet_length(resulting_state_digest) = 32
                    and completed_at is not null
                )
                or (
                    outcome = 'satisfied'
                    and command_name <> 'extend_episode'
                    and rejection_reason is null
                    and event_id is null
                    and resulting_revision >= 0
                    and octet_length(resulting_state_digest) = 32
                    and external_operation_id is null
                    and completed_at is not null
                )
                or (
                    outcome = 'pending'
                    and command_name not in ('start_episode', 'extend_episode')
                    and rejection_reason is null
                    and external_operation_id is not null
                    and completed_at is null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
                or (
                    outcome = 'rejected'
                    and command_name <> 'start_episode'
                    and (command_name <> 'extend_episode' or external_operation_id is null)
                    and rejection_reason in (
                        'episode_ended',
                        'participant_inactive',
                        'stale_participant_generation',
                        'capability_denied',
                        'invalid_state',
                        'invalid_target',
                        'role_not_eligible',
                        'role_assignment_required',
                        'screen_share_in_use',
                        'recording_in_progress',
                        'recording_policy_disabled',
                        'external_operation_failed'
                    )
                    and (
                        rejection_reason <> 'recording_policy_disabled'
                        or command_name = 'start_recording'
                    )
                    and completed_at is not null
                    and (
                        (
                            command_name in ('set_participant_role', 'assign_roles')
                            and external_operation_id is not null
                            and event_id is not null
                            and resulting_revision > 0
                            and octet_length(resulting_state_digest) = 32
                        )
                        or (
                            command_name not in ('set_participant_role', 'assign_roles')
                            and event_id is null
                            and resulting_revision is null
                            and resulting_state_digest is null
                        )
                    )
                )
            )
        )
    );
