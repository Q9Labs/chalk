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

  def claim_eligible_episodes do
    """
    select
      control.tenant_id,
      control.space_id,
      control.episode_id,
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
    from episodes episode
    join sync_episode_control control
      on control.tenant_id = episode.tenant_id
      and control.space_id = episode.space_id
      and control.episode_id = episode.id
    where episode.status = 'ended'
      and episode.ended_at <= $1
      and control.retention_cleaned_at is null
      and not exists (
        select 1
        from sync_lifecycle_intents intent
        where intent.tenant_id = control.tenant_id
          and intent.episode_id = control.episode_id
          and intent.status = 'pending'
      )
      and not exists (
        select 1 from sync_external_operations operation
        where operation.tenant_id = control.tenant_id
          and operation.episode_id = control.episode_id
          and operation.status = 'pending'
      )
      and not exists (
        select 1 from sync_admission_requests admission
        where admission.tenant_id = control.tenant_id
          and admission.episode_id = control.episode_id
          and admission.status = 'pending'
      )
      and not exists (
        select 1 from sync_recordings recording
        where recording.tenant_id = control.tenant_id
          and recording.episode_id = control.episode_id
          and recording.status in ('starting', 'recording', 'stopping')
      )
      and not exists (
        select 1 from sync_screen_share_leases lease
        where lease.tenant_id = control.tenant_id
          and lease.episode_id = control.episode_id
      )
      and not exists (
        select 1 from sync_publication_fences fence
        where fence.tenant_id = control.tenant_id
          and fence.episode_id = control.episode_id
          and fence.expires_at > $2
      )
      and not exists (
        select 1 from sync_publication_grant_reservations reservation
        where reservation.tenant_id = control.tenant_id
          and reservation.episode_id = control.episode_id
          and reservation.status in ('pending', 'ambiguous')
      )
      and not exists (
        select 1 from sync_whiteboard_files file
        where file.tenant_id = control.tenant_id
          and file.episode_id = control.episode_id
      )
      and not exists (
        select 1 from sync_chat_attachments attachment
        where attachment.tenant_id = control.tenant_id
          and attachment.episode_id = control.episode_id
      )
    order by episode.ended_at, control.tenant_id, control.episode_id
    limit $3
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
      and episode_id = $2
      and revision > $3
    order by revision
    limit $4
    """
  end

  def write_checkpoint do
    """
    update sync_episode_control
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
      retention_deleted_external_operation_rows = $12,
      retention_deleted_external_operation_bytes = $13,
      retention_deleted_admission_request_rows = $14,
      retention_deleted_admission_request_bytes = $15,
      retention_deleted_recording_rows = $16,
      retention_deleted_recording_bytes = $17,
      retention_deleted_screen_share_lease_rows = $18,
      retention_deleted_screen_share_lease_bytes = $19,
      retention_deleted_publication_fence_rows = $20,
      retention_deleted_publication_fence_bytes = $21,
      retention_deleted_publication_grant_reservation_rows = $22,
      retention_deleted_publication_grant_reservation_bytes = $23,
      updated_at = $6
    where tenant_id = $1
      and episode_id = $2
      and control_revision = $3
      and state_digest = $4
      and retention_cleaned_at is null
    returning episode_id
    """
  end

  def delete_receipts do
    """
    with deleted as (
      delete from sync_command_receipts
      where tenant_id = $1 and episode_id = $2
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  def delete_admission_requests, do: delete_rows("sync_admission_requests")
  def delete_recordings, do: delete_rows("sync_recordings")
  def delete_screen_share_leases, do: delete_rows("sync_screen_share_leases")
  def delete_publication_fences, do: delete_rows("sync_publication_fences")

  def delete_publication_grant_reservations,
    do: delete_rows("sync_publication_grant_reservations")

  def delete_chat_messages, do: delete_rows("sync_chat_messages")
  def delete_chat_read_receipts, do: delete_rows("sync_chat_read_receipts")

  def delete_chat_streams do
    """
    with deleted as (
      delete from sync_chat_streams
      where tenant_id = $1
        and space_id = (select space_id from episodes where tenant_id = $1 and id = $2)
      returning pg_column_size(sync_chat_streams)::bigint as encoded_bytes
    )
    select count(*)::bigint, coalesce(sum(encoded_bytes), 0)::bigint from deleted
    """
  end

  def delete_whiteboard_operation_receipts,
    do: delete_rows("sync_whiteboard_operation_receipts")

  def delete_whiteboard_permissions, do: delete_rows("sync_whiteboard_permissions")
  def delete_whiteboard_elements, do: delete_rows("sync_whiteboard_elements")

  def delete_whiteboard_scenes do
    """
    with deleted as (
      delete from sync_whiteboard_scenes
      where tenant_id = $1
        and space_id = (select space_id from episodes where tenant_id = $1 and id = $2)
      returning pg_column_size(sync_whiteboard_scenes)::bigint as encoded_bytes
    )
    select count(*)::bigint, coalesce(sum(encoded_bytes), 0)::bigint from deleted
    """
  end

  def delete_terminal_external_operations do
    """
    with deleted as (
      delete from sync_external_operations
      where tenant_id = $1 and episode_id = $2 and status in ('applied', 'failed')
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  def measure_terminal_external_operations do
    """
    select count(*)::bigint, coalesce(sum(pg_column_size(sync_external_operations)), 0)::bigint
    from sync_external_operations
    where tenant_id = $1 and episode_id = $2 and status in ('applied', 'failed')
    """
  end

  def delete_terminal_lifecycle_intents do
    """
    with deleted as (
      delete from sync_lifecycle_intents
      where tenant_id = $1 and episode_id = $2 and status != 'pending'
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  def clear_terminal_operation_event_links do
    """
    with cleared as (
      update sync_external_operations
      set applied_event_id = null, applied_revision = null
      where tenant_id = $1 and episode_id = $2
        and status in ('applied', 'failed')
        and applied_event_id is not null
      returning 1
    )
    select count(*)::bigint from cleared
    """
  end

  def delete_events do
    """
    with deleted as (
      delete from sync_control_events
      where tenant_id = $1 and episode_id = $2
      returning 1
    )
    select count(*)::bigint from deleted
    """
  end

  defp delete_rows(table) do
    """
    with deleted as (
      delete from #{table}
      where tenant_id = $1 and episode_id = $2
      returning pg_column_size(#{table})::bigint as encoded_bytes
    )
    select count(*)::bigint, coalesce(sum(encoded_bytes), 0)::bigint from deleted
    """
  end
end
