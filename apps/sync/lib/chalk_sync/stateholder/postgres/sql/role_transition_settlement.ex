defmodule ChalkSync.Stateholder.Postgres.SQL.RoleTransitionSettlement do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationColumns

  def apply_role_transition_child do
    """
    update sync_external_operations
    set status = 'applied', completed_at = now(), last_error_code = null
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_source_stop'
      and status = 'pending'
    returning parent_external_operation_id
    """
  end

  def fail_role_transition_child do
    """
    update sync_external_operations
    set status = 'failed', completed_at = now(), last_error_code = $5
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_source_stop'
      and status = 'pending'
    returning parent_external_operation_id
    """
  end

  def lock_role_transition_parent do
    """
    select #{ExternalOperationColumns.columns()}
    from sync_external_operations
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
    for update
    """
  end

  def role_transition_child_statuses do
    """
    select status
    from sync_external_operations
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and parent_external_operation_id = $4
    order by source
    for update
    """
  end

  def apply_role_transition_parent do
    """
    update sync_external_operations
    set status = 'applied', fence_active = false, completed_at = now(), last_error_code = null
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
      and status = 'pending'
    returning external_operation_id
    """
  end

  def fail_role_transition_parent do
    """
    update sync_external_operations
    set status = 'failed', last_error_code = $5, completed_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
      and status = 'pending'
    returning external_operation_id
    """
  end

  def commit_role_transition_receipt do
    """
    update sync_command_receipts
    set outcome = 'committed', completed_at = now()
    where tenant_id = $1 and episode_id = $2 and external_operation_id = $3
      and outcome = 'pending'
    returning command_id
    """
  end

  def fail_role_transition_receipt do
    """
    update sync_command_receipts
    set outcome = 'rejected', rejection_reason = 'external_operation_failed', completed_at = now()
    where tenant_id = $1 and episode_id = $2 and external_operation_id = $3
      and outcome = 'pending'
    returning command_id
    """
  end

  def delete_operation_fences do
    """
    delete from sync_publication_fences
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4
    """
  end
end
