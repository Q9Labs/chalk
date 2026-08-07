-- +goose Up
alter table sync_command_receipts
    drop constraint if exists sync_command_receipts_command_name_check,
    drop constraint if exists sync_command_receipts_check,
    drop constraint if exists sync_command_receipts_shape_check;

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
    )) not valid;

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
                        'external_operation_failed'
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
    ) not valid;

alter table sync_command_receipts
    validate constraint sync_command_receipts_command_name_check;
alter table sync_command_receipts
    validate constraint sync_command_receipts_shape_check;

-- +goose Down
-- This migration is not data-reversible for the two new command families.
-- Refuse the downgrade while either family has a receipt instead of deleting
-- or rewriting durable command history. Resolve those rows operationally,
-- then retry the downgrade in the same transaction.
do $$
begin
    if exists (
        select 1
        from sync_command_receipts
        where command_name in ('start_episode', 'extend_episode')
    ) then
        raise exception 'cannot downgrade sync command receipts while start_episode or extend_episode rows exist';
    end if;
end
$$;

alter table sync_command_receipts
    drop constraint if exists sync_command_receipts_command_name_check,
    drop constraint if exists sync_command_receipts_shape_check,
    drop constraint if exists sync_command_receipts_check;

alter table sync_command_receipts
    add constraint sync_command_receipts_command_name_check check (command_name in (
        'raise_hand', 'lower_hand', 'set_hand_raised', 'set_display_name',
        'set_admission_policy', 'set_participant_role', 'assign_roles',
        'admit_participant', 'deny_admission', 'mute_participant',
        'stop_participant_camera', 'stop_participant_screen_share',
        'remove_participant', 'start_recording', 'stop_recording',
        'participant_leave', 'end_episode'
    ));

alter table sync_command_receipts
    add constraint sync_command_receipts_check check (
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
                'end_episode'
            )
            and (
                (
                    outcome = 'committed'
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
                        'external_operation_failed'
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
