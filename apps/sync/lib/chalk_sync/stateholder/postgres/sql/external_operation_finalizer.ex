defmodule ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims

  def lock_operation do
    ExternalOperationClaims.read_operation() <> " for update"
  end

  def lock_admission_lifecycle_intent do
    """
    select lifecycle_intent_id, status, participant_generation
    from sync_lifecycle_intents
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and participant_id = $4
      and intent_name = 'participant_joined'
    for update
    """
  end

  def release_admission_request_reservation do
    """
    update sync_admission_requests
    set decision_external_operation_id = null
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id = $5
    returning participant_id
    """
  end

  def finalize_admission_request do
    """
    update sync_admission_requests
    set status = $5, completed_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id = $6
    returning participant_id
    """
  end

  def supersede_admission_join_intent do
    """
    update sync_lifecycle_intents
    set
      status = 'superseded', terminal_reason = 'participant_already_terminal',
      completed_at = now(), last_error_code = null
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and participant_id = $4 and intent_name = 'participant_joined'
      and status = 'pending'
    """
  end

  def complete_admission_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and id = $4 and status = 'joining'
    """
  end

  def restore_participant_active do
    """
    update participants
    set status = 'active', updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and id = $4 and generation = $5 and status = 'leaving'
    returning id
    """
  end

  def complete_external_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and id = $4 and generation = $5 and status = 'leaving'
    returning id, identity_id, space_id, episode_id, name, status, joined_at, left_at, updated_at
    """
  end

  def restore_episode_active do
    """
    update episodes
    set status = 'active', updated_at = now()
    where tenant_id = $1 and space_id = $2 and id = $3 and status = 'ending'
    returning id
    """
  end

  def complete_external_episode do
    """
    update episodes
    set status = 'ended', ended_at = now(), updated_at = now()
    where tenant_id = $1 and space_id = $2 and id = $3 and status = 'ending'
    returning id, space_id, status, started_at, ended_at, created_at, updated_at
    """
  end

  def complete_external_episode_participants do
    """
    update participants
    set status = 'left', left_at = coalesce(left_at, now()), updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and status <> 'left'
    """
  end

  def complete_external_episode_admissions do
    """
    update sync_admission_requests
    set status = 'expired', decision_external_operation_id = $4, completed_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and status = 'pending'
    """
  end

  def complete_external_episode_recordings do
    """
    update sync_recordings
    set status = 'stopped', completed_at = now(), updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and status in ('starting', 'recording', 'stopping')
    """
  end

  def finalize_recording do
    """
    update sync_recordings
    set
      status = $5,
      failure_code = $6,
      completed_at = case when $5 in ('stopped', 'failed') then now() else null end,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and recording_id = $4 and status in ('starting', 'stopping')
    returning recording_id
    """
  end

  def insert_external_event do
    """
    insert into sync_control_events (
      tenant_id, space_id, episode_id, event_id, base_revision, revision,
      event_name, payload, actor_participant_id, actor_generation,
      external_operation_id, event_schema_version, resulting_state_digest, encoded_bytes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    """
  end

  def update_external_control do
    """
    update sync_episode_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and control_revision = $4 - 1
      and $8 + snapshot_reserved_bytes <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
    returning control_revision
    """
  end

  def update_external_end_control do
    """
    update sync_episode_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      snapshot_reserved_bytes = 0,
      lifecycle_reserved_events = 0,
      lifecycle_reserved_bytes = 0,
      lifecycle_reserved_intents = 0,
      lifecycle_reserved_intent_bytes = 0,
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and control_revision = $4 - 1
      and $8 <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
    returning control_revision
    """
  end

  def update_external_admission_control do
    """
    update sync_episode_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      snapshot_reserved_bytes = greatest(snapshot_reserved_bytes - 2048, 0),
      lifecycle_reserved_events = greatest(lifecycle_reserved_events - 1, 0),
      lifecycle_reserved_bytes = greatest(lifecycle_reserved_bytes - 16384, 0),
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and control_revision = $4 - 1
      and $8 + greatest(snapshot_reserved_bytes - 2048, 0) <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
    returning control_revision
    """
  end

  def apply_external_operation do
    """
    update sync_external_operations
    set
      status = 'applied', fence_active = false, last_error_code = null,
      applied_event_id = $5, applied_revision = $6, completed_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and status = 'pending'
    returning external_operation_id
    """
  end

  def fail_external_operation do
    """
    update sync_external_operations
    set
      status = 'failed', fence_active = false, last_error_code = $5,
      applied_event_id = null, applied_revision = null, completed_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and status = 'pending'
    returning external_operation_id
    """
  end

  def commit_operation_receipt do
    """
    update sync_command_receipts
    set
      outcome = 'committed', event_id = $6, resulting_revision = $7,
      resulting_state_digest = $8, completed_at = now()
    where tenant_id = $1 and episode_id = $2 and participant_id = $3
      and command_id = $4 and external_operation_id = $5 and outcome = 'pending'
    returning command_id
    """
  end

  def reject_operation_receipt do
    """
    update sync_command_receipts
    set
      outcome = 'rejected', rejection_reason = 'external_operation_failed',
      completed_at = now()
    where tenant_id = $1 and episode_id = $2 and participant_id = $3
      and command_id = $4 and external_operation_id = $5 and outcome = 'pending'
    returning command_id
    """
  end

  def update_episode_deadline do
    """
    update episodes
    set
      deadline_at = to_timestamp($4::double precision / 1000.0),
      deadline_generation = $5,
      updated_at = now()
    where tenant_id = $1 and space_id = $2 and id = $3
      and status = 'active' and deadline_generation = $5 - 1
      and to_timestamp($4::double precision / 1000.0)
          <= created_at + make_interval(
            secs => (config_snapshot ->> 'maximum_episode_duration_seconds')::integer
          )
    returning id
    """
  end

  def release_screen_share_lease do
    """
    delete from sync_screen_share_leases
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and owner_participant_id = $4 and owner_generation = $5
    """
  end
end
