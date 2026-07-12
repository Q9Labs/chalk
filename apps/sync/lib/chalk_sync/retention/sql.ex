defmodule ChalkSync.Retention.SQL do
  @moduledoc false

  def transaction_settings do
    """
    select
      set_config('lock_timeout', '250ms', true),
      set_config('statement_timeout', '30s', true),
      set_config('synchronous_commit', 'on', true)
    """
  end

  def claim_eligible_sessions do
    """
    select
      control.tenant_id,
      control.room_id,
      control.session_id,
      control.control_revision,
      control.folded_state,
      control.state_schema_version,
      control.state_digest,
      control.participant_event_count,
      control.participant_event_bytes,
      control.lifecycle_event_count,
      control.lifecycle_event_bytes,
      control.lifecycle_intent_count,
      control.lifecycle_intent_bytes,
      control.receipt_count,
      control.receipt_bytes
    from room_sessions session
    join sync_session_control control
      on control.tenant_id = session.tenant_id
      and control.room_id = session.room_id
      and control.session_id = session.id
    where session.status = 'ended'
      and session.ended_at <= $1
      and control.retention_cleaned_at is null
      and not exists (
        select 1
        from sync_lifecycle_intents intent
        where intent.tenant_id = control.tenant_id
          and intent.session_id = control.session_id
          and intent.status = 'pending'
      )
    order by session.ended_at, control.tenant_id, control.session_id
    limit $2
    for update of control skip locked
    """
  end

  def read_event_page do
    """
    select
      base_revision,
      revision,
      event_name,
      payload,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    from sync_control_events
    where tenant_id = $1
      and session_id = $2
      and revision > $3
    order by revision
    limit $4
    """
  end

  def write_checkpoint do
    """
    update sync_session_control
    set
      retention_checkpoint_revision = $3,
      retention_checkpoint_state_digest = $4,
      retention_checkpoint_event_count = $5,
      retention_cleaned_at = $6,
      retention_deleted_event_rows = $5,
      retention_deleted_event_bytes = $7,
      retention_deleted_receipt_rows = $8,
      retention_deleted_receipt_bytes = $9,
      retention_deleted_lifecycle_intent_rows = $10,
      retention_deleted_lifecycle_intent_bytes = $11,
      updated_at = $6
    where tenant_id = $1
      and session_id = $2
      and control_revision = $3
      and state_digest = $4
      and retention_cleaned_at is null
    returning session_id
    """
  end

  def delete_receipts do
    """
    with deleted as (
      delete from sync_command_receipts
      where tenant_id = $1 and session_id = $2
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  def delete_terminal_lifecycle_intents do
    """
    with deleted as (
      delete from sync_lifecycle_intents
      where tenant_id = $1 and session_id = $2 and status != 'pending'
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  def delete_events do
    """
    with deleted as (
      delete from sync_control_events
      where tenant_id = $1 and session_id = $2
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end
end
