defmodule ChalkSync.Stateholder.Postgres.SQL.Command do
  @moduledoc false

  def select_receipt do
    """
    select
      receipt.request_fingerprint,
      receipt.outcome,
      receipt.rejection_reason,
      receipt.event_id,
      receipt.resulting_revision,
      receipt.resulting_state_digest,
      receipt.external_operation_id
    from sync_command_receipts receipt
    join sync_episode_control control
      on control.tenant_id = receipt.tenant_id
      and control.episode_id = receipt.episode_id
    where receipt.tenant_id = $1
      and control.space_id = $2
      and receipt.episode_id = $3
      and receipt.participant_id = $4
      and receipt.command_id = $5
    """
  end

  def insert_rejected_receipt do
    """
    insert into sync_command_receipts (
      tenant_id,
      episode_id,
      participant_id,
      submitted_generation,
      command_id,
      request_fingerprint,
      command_name,
      outcome,
      rejection_reason,
      completed_at
    ) values ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8, now())
    """
  end

  def increment_rejected_receipt_capacity do
    """
    update sync_episode_control
    set
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $4,
      updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and receipt_count < 500000
      and receipt_bytes + $4 <= 4294967296
    returning control_revision
    """
  end

  def increment_satisfied_receipt_capacity do
    increment_rejected_receipt_capacity()
  end

  def insert_event do
    """
    insert into sync_control_events (
      tenant_id,
      space_id,
      episode_id,
      event_id,
      base_revision,
      revision,
      event_name,
      payload,
      actor_participant_id,
      actor_generation,
      command_id,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    """
  end

  def update_committed_control do
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
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $10,
      updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and control_revision = $4 - 1
      and $8 + snapshot_reserved_bytes <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
      and receipt_count < 500000
      and receipt_bytes + $10 <= 4294967296
    returning control_revision
    """
  end

  def insert_committed_receipt do
    """
    insert into sync_command_receipts (
      tenant_id,
      episode_id,
      participant_id,
      submitted_generation,
      command_id,
      request_fingerprint,
      command_name,
      outcome,
      event_id,
      resulting_revision,
      resulting_state_digest,
      completed_at
    ) values ($1, $2, $3, $4, $5, $6, $7, 'committed', $8, $9, $10, now())
    """
  end

  def insert_satisfied_receipt do
    """
    insert into sync_command_receipts (
      tenant_id,
      episode_id,
      participant_id,
      submitted_generation,
      command_id,
      request_fingerprint,
      command_name,
      outcome,
      resulting_revision,
      resulting_state_digest,
      completed_at
    ) values ($1, $2, $3, $4, $5, $6, $7, 'satisfied', $8, $9, now())
    """
  end

  def update_participant_role do
    """
    update participants
    set
      role = $5,
      capabilities = coalesce(
        (
          select array_agg(value order by value)
          from jsonb_array_elements_text(episodes.config_snapshot -> 'roles' -> $5) values(value)
        ),
        '{}'::text[]
      ),
      updated_at = now()
    from episodes
    where participants.tenant_id = $1
      and participants.space_id = $2
      and participants.episode_id = $3
      and participants.id = $4
      and episodes.tenant_id = participants.tenant_id
      and episodes.space_id = participants.space_id
      and episodes.id = participants.episode_id
      and participants.status = 'active'
    returning participants.id
    """
  end
end
