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
      'tenant_set_deadline',
      'recording_capture_ready',
      'recording_capture_stopped',
      'recording_capture_failed'
    )
    """)
  end

  defp claim_operations_where(operation_filter) do
    """
    with pending_order as (
      select external_operation_id,
        row_number() over (
          partition by tenant_id, episode_id order by created_at, external_operation_id
        ) as episode_pending_position,
        row_number() over (
          partition by tenant_id, episode_id, target_participant_id
          order by created_at, external_operation_id
        ) as participant_pending_position,
        count(*) filter (
          where operation_name not in ('participant_leave', 'remove_participant')
        ) over (
          partition by tenant_id, episode_id order by created_at, external_operation_id
          rows between unbounded preceding and 1 preceding
        ) as barriers_before
      from sync_external_operations
      where status = 'pending' and operation_name <> 'role_transition_cleanup'
        and not (#{local_operation("sync_external_operations")})
    ), eligible as (
      select external_operation_id, next_attempt_at, attempt_count, created_at,
        row_number() over (
          partition by tenant_id, episode_id
          order by next_attempt_at, attempt_count, created_at, external_operation_id
        ) as episode_position
      from sync_external_operations
      left join pending_order using (external_operation_id)
      where status = 'pending'
        and next_attempt_at <= now()
        and attempt_count < 100
        and #{operation_filter}
        and (
          #{local_operation("sync_external_operations")}
          or (
            pending_order.barriers_before = 0
            and (
              pending_order.episode_pending_position = 1
              or (
                operation_name in ('participant_leave', 'remove_participant')
                and pending_order.participant_pending_position = 1
              )
            )
          )
        )
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
    ), candidates as (
      select operation.external_operation_id, eligible.episode_position
      from sync_external_operations operation
      join eligible using (external_operation_id)
      where operation.status = 'pending' and operation.next_attempt_at <= now()
      order by eligible.episode_position, eligible.next_attempt_at, eligible.attempt_count,
        eligible.created_at, operation.external_operation_id
      for update of operation skip locked
      limit $1
    ), claimed as (
      update sync_external_operations operation
      set
        attempt_count = operation.attempt_count + 1,
        next_attempt_at = now() + interval '60 seconds'
      from candidates
      where operation.external_operation_id = candidates.external_operation_id
      returning operation.*
    )
    select #{ExternalOperationColumns.columns("claimed")}
    from claimed
    join candidates using (external_operation_id)
    order by candidates.episode_position, claimed.next_attempt_at, claimed.attempt_count,
      claimed.created_at, claimed.external_operation_id
    """
  end

  # Capture callbacks must be able to finish the recording operation that an
  # Episode end is waiting for. Local decisions serialize on the control row.
  defp local_operation(table) do
    """
    #{table}.operation_name in (
      'admit_participant', 'deny_admission', 'admission_request_expired',
      'tenant_set_deadline', 'recording_capture_ready',
      'recording_capture_stopped', 'recording_capture_failed'
    )
    """
  end
end
