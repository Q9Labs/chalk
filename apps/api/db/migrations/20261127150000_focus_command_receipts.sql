-- +goose Up
-- Focus adds four Episode commands that are recorded as receipts like any other command.
alter table sync_command_receipts drop constraint sync_command_receipts_command_name_check;
alter table sync_command_receipts
    add constraint sync_command_receipts_command_name_check check (command_name in (
        'raise_hand',
        'lower_hand',
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
        'end_episode',
        'set_focus_step_away',
        'clear_focus_step_away',
        'open_focus_allowance',
        'close_focus_allowance'
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
                'end_episode',
                'set_focus_step_away',
                'clear_focus_step_away',
                'open_focus_allowance',
                'close_focus_allowance'
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
delete from sync_command_receipts where command_name in ('set_focus_step_away', 'clear_focus_step_away', 'open_focus_allowance', 'close_focus_allowance');
alter table sync_command_receipts drop constraint sync_command_receipts_command_name_check;
alter table sync_command_receipts
    add constraint sync_command_receipts_command_name_check check (command_name in (
        'raise_hand',
        'lower_hand',
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
