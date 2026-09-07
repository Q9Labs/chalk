defmodule ChalkSync.Stateholder.Postgres.SQL.ExternalOperationDecision do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationColumns

  def select_operation_receipt do
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

  def select_internal_operation do
    """
    select #{ExternalOperationColumns.columns()}
    from sync_external_operations
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and operation_name = $4
      and request_key = $5
    """
  end
end
