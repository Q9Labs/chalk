defmodule ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationColumns

  def read_operation do
    """
    select #{ExternalOperationColumns.columns()}
    from sync_external_operations
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and external_operation_id = $4
    """
  end

  def claim_operations do
    claim_operations_where("operation_name <> 'role_transition_cleanup'")
  end

  def claim_local_operations do
    claim_operations_where("""
    operation_name in (
      'deny_admission',
      'admission_request_expired',
      'tenant_set_deadline'
    )
    """)
  end

  defp claim_operations_where(operation_filter) do
    """
    with candidates as (
      select external_operation_id
      from sync_external_operations
      where status = 'pending'
        and next_attempt_at <= now()
        and attempt_count < 100
        and #{operation_filter}
        and (
          (
            source is not null
            and not exists (
              select 1
              from sync_publication_grant_reservations reservation
              where reservation.tenant_id = sync_external_operations.tenant_id
                and reservation.episode_id = sync_external_operations.episode_id
                and reservation.participant_id = sync_external_operations.target_participant_id
                and reservation.participant_generation = sync_external_operations.target_participant_generation
                and reservation.source = sync_external_operations.source
                and reservation.status in ('pending', 'ambiguous')
                and reservation.expires_at > now()
            )
          )
          or (
            operation_name in ('remove_participant', 'participant_leave')
            and not exists (
              select 1
              from sync_publication_grant_reservations reservation
              where reservation.tenant_id = sync_external_operations.tenant_id
                and reservation.episode_id = sync_external_operations.episode_id
                and reservation.participant_id = sync_external_operations.target_participant_id
                and reservation.participant_generation = sync_external_operations.target_participant_generation
                and reservation.status in ('pending', 'ambiguous')
                and reservation.expires_at > now()
            )
          )
          or (
            operation_name in ('end_episode', 'tenant_end_episode', 'maximum_duration_expired')
            and not exists (
              select 1
              from sync_publication_grant_reservations reservation
              where reservation.tenant_id = sync_external_operations.tenant_id
                and reservation.episode_id = sync_external_operations.episode_id
                and reservation.status in ('pending', 'ambiguous')
                and reservation.expires_at > now()
            )
          )
          or (
            source is null
            and operation_name not in (
              'remove_participant', 'participant_leave',
              'end_episode', 'tenant_end_episode', 'maximum_duration_expired'
            )
          )
        )
      order by next_attempt_at, attempt_count, created_at, external_operation_id
      for update skip locked
      limit $1
    ), claimed as (
      update sync_external_operations operation
      set
        attempt_count = operation.attempt_count + 1,
        next_attempt_at = now() + interval '30 seconds'
      from candidates
      where operation.external_operation_id = candidates.external_operation_id
      returning operation.*
    )
    select #{ExternalOperationColumns.columns("claimed")}
    from claimed
    order by next_attempt_at, attempt_count, created_at, external_operation_id
    """
  end
end
