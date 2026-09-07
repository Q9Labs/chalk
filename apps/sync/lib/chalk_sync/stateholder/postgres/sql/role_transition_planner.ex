defmodule ChalkSync.Stateholder.Postgres.SQL.RoleTransitionPlanner do
  @moduledoc false

  def lock_active_publication_reservations do
    """
    select reservation_id, operation_id, participant_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and participant_id = $4 and participant_generation = $5
      and expires_at > now()
    order by source
    for update
    """
  end

  def insert_role_transition_parent do
    """
    insert into sync_external_operations (
      tenant_id, space_id, episode_id, external_operation_id, request_key,
      request_fingerprint, operation_name, actor_participant_id,
      actor_generation, target_participant_id, target_participant_generation,
      payload, fence_active
    ) values ($1, $2, $3, $4, $5, $6, 'role_transition_cleanup', $7, $8, $9, $10, $11, true)
    """
  end

  def insert_role_transition_child do
    """
    insert into sync_external_operations (
      tenant_id, space_id, episode_id, external_operation_id, parent_external_operation_id,
      request_key, request_fingerprint, operation_name,
      target_participant_id, target_participant_generation, source, payload
    ) values ($1, $2, $3, $4, $5, $6, $7, 'role_transition_source_stop', $8, $9, $10, $11)
    """
  end

  def insert_pending_role_transition_receipt do
    """
    insert into sync_command_receipts (
      tenant_id, episode_id, participant_id, submitted_generation,
      command_id, request_fingerprint, command_name, outcome, external_operation_id,
      event_id, resulting_revision, resulting_state_digest
    ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
    """
  end

  def insert_publication_fence do
    """
    insert into sync_publication_fences (
      tenant_id, space_id, episode_id, participant_id,
      participant_generation, source, external_operation_id, expires_at
    ) values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')
    on conflict (tenant_id, episode_id, participant_id, source) do update
    set
      space_id = excluded.space_id,
      participant_generation = excluded.participant_generation,
      external_operation_id = excluded.external_operation_id,
      expires_at = excluded.expires_at,
      created_at = now()
    where sync_publication_fences.expires_at <= now()
    returning external_operation_id
    """
  end
end
