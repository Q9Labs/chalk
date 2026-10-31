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

  def claim_dispatch_episodes do
    """
    with #{eligible_cte("operation_name <> 'role_transition_cleanup'", "and not (episode_id = any($2::uuid[]))")},
    episode_heads as (
      select distinct on (tenant_id, episode_id)
        tenant_id, episode_id, next_attempt_at, attempt_count, acceptance_order
      from eligible
      order by tenant_id, episode_id, acceptance_order
    ), selected_episodes as (
      select head.tenant_id, head.episode_id
      from episode_heads head
      where not exists (
        select 1
        from sync_episode_dispatch_leases lease
        where lease.tenant_id = head.tenant_id
          and lease.episode_id = head.episode_id
          and lease.expires_at > now()
          and lease.owner_id <> $1::uuid
      )
      order by head.next_attempt_at, head.attempt_count, head.acceptance_order
      limit $3
    ), leased_episodes as (
      insert into sync_episode_dispatch_leases as current_lease (
        tenant_id, episode_id, owner_id, fence, expires_at
      )
      select
        selected.tenant_id,
        selected.episode_id,
        $1::uuid,
        next_sync_episode_dispatch_fence(),
        now() + ($4::bigint * interval '1 millisecond')
      from selected_episodes selected
      on conflict (tenant_id, episode_id) do update
      set
        owner_id = excluded.owner_id,
        fence = excluded.fence,
        expires_at = excluded.expires_at
      where current_lease.expires_at <= now()
        or current_lease.owner_id = excluded.owner_id
      returning tenant_id, episode_id, owner_id, fence
    )
    select tenant_id, episode_id, owner_id, fence
    from leased_episodes
    """
  end

  def claim_leased_operations do
    """
    with #{eligible_cte("operation_name <> 'role_transition_cleanup'", "")},
    leased_episodes as (
      select tenant_id, episode_id, fence
      from unnest($2::uuid[], $3::uuid[], $4::bigint[])
        as leased(tenant_id, episode_id, fence)
    ), candidates as (
      select operation.external_operation_id
      from sync_external_operations operation
      join eligible using (external_operation_id)
      join leased_episodes leased
        on leased.tenant_id = operation.tenant_id
        and leased.episode_id = operation.episode_id
      join sync_episode_dispatch_leases lease
        on lease.tenant_id = leased.tenant_id
        and lease.episode_id = leased.episode_id
        and lease.owner_id = $5::uuid
        and lease.fence = leased.fence
        and lease.expires_at > now()
      where operation.status = 'pending'
        and operation.next_attempt_at <= now()
        and operation.attempt_count < 100
      order by eligible.acceptance_order
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
    order by acceptance_order
    """
  end

  def release_dispatch_leases do
    """
    delete from sync_episode_dispatch_leases lease
    using unnest($1::uuid[], $2::uuid[], $3::bigint[])
      as acquired(tenant_id, episode_id, fence)
    where lease.tenant_id = acquired.tenant_id
      and lease.episode_id = acquired.episode_id
      and lease.owner_id = $4::uuid
      and lease.fence = acquired.fence
    """
  end

  def renew_dispatch_lease do
    """
    update sync_episode_dispatch_leases
    set expires_at = now() + ($5::bigint * interval '1 millisecond')
    where tenant_id = $1 and episode_id = $2 and owner_id = $3 and fence = $4
    """
  end

  def release_dispatch_lease do
    """
    delete from sync_episode_dispatch_leases
    where tenant_id = $1 and episode_id = $2 and owner_id = $3 and fence = $4
    """
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
    with #{eligible_cte(operation_filter, "and not (episode_id = any($2::uuid[]))")},
    episode_heads as (
      select distinct on (tenant_id, episode_id)
        tenant_id, episode_id, next_attempt_at, attempt_count, acceptance_order
      from eligible
      order by tenant_id, episode_id, acceptance_order
    ), selected_episodes as (
      select tenant_id, episode_id from episode_heads
      order by next_attempt_at, attempt_count, acceptance_order
      limit $3
    ), candidates as (
      select operation.external_operation_id
      from sync_external_operations operation
      join eligible using (external_operation_id)
      join selected_episodes selected
        on selected.tenant_id = operation.tenant_id and selected.episode_id = operation.episode_id
      where operation.status = 'pending'
        and operation.next_attempt_at <= now()
        and operation.attempt_count < 100
      order by eligible.acceptance_order
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
    order by acceptance_order
    """
  end

  defp eligible_cte(operation_filter, exclusion) do
    """
    eligible as (
      select tenant_id, episode_id, external_operation_id,
        next_attempt_at, attempt_count, acceptance_order
      from sync_external_operations
      where status = 'pending'
        #{exclusion}
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
    )
    """
  end
end
