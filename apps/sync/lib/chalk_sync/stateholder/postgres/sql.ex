defmodule ChalkSync.Stateholder.Postgres.SQL do
  @moduledoc false

  def transaction_settings do
    """
    select
      set_config('lock_timeout', '750ms', true),
      set_config('statement_timeout', '2s', true),
      set_config('synchronous_commit', 'on', true)
    """
  end

  def effective_synchronous_commit,
    do: "select current_setting('synchronous_commit')"

  def lock_control do
    """
    select
      control_revision,
      folded_state,
      state_schema_version,
      state_digest,
      snapshot_bytes,
      host_participant_session_id
    from sync_session_control
    where tenant_id = $1 and room_id = $2 and session_id = $3
    for update
    """
  end

  def lock_session do
    """
    select status, host_exit_policy, role_capabilities
    from room_sessions
    where tenant_id = $1 and room_id = $2 and id = $3
    for update
    """
  end

  def lock_participant do
    """
    select generation, status, role, eligible_roles
    from participants
    where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
    for update
    """
  end

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
    join sync_session_control control
      on control.tenant_id = receipt.tenant_id
      and control.session_id = receipt.session_id
    where receipt.tenant_id = $1
      and control.room_id = $2
      and receipt.session_id = $3
      and receipt.participant_session_id = $4
      and receipt.command_id = $5
    """
  end

  def insert_rejected_receipt do
    """
    insert into sync_command_receipts (
      tenant_id,
      session_id,
      participant_session_id,
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
    update sync_session_control
    set
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $4,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
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
      room_id,
      session_id,
      event_id,
      base_revision,
      revision,
      event_name,
      payload,
      actor_participant_session_id,
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
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $11,
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $10,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
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
      session_id,
      participant_session_id,
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
      session_id,
      participant_session_id,
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
    set role = $5, updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
      and status = 'active' and $5 = any(eligible_roles)
    returning id
    """
  end

  def transfer_host do
    """
    with old_host as (
      update participants
      set role = 'cohost', updated_at = now()
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
        and status in ('active', 'leaving') and role = 'host' and 'cohost' = any(eligible_roles)
      returning id
    ), new_host as (
      update participants
      set role = 'host', updated_at = now()
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $5
        and status = 'active' and role <> 'host' and 'host' = any(eligible_roles)
        and exists (select 1 from old_host)
      returning id
    )
    update sync_session_control
    set host_participant_session_id = $5, updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and host_participant_session_id = $4
      and exists (select 1 from new_host)
    returning host_participant_session_id
    """
  end

  def notify_head,
    do: "select pg_notify('chalk_sync_heads', $1)"

  def lock_lifecycle_intent do
    """
    select
      status,
      intent_name,
      participant_session_id,
      participant_session_generation,
      payload,
      terminal_reason,
      applied_event_id,
      applied_revision,
      journey_id,
      parent_journey_event_id,
      producing_trace_id,
      producing_span_id
    from sync_lifecycle_intents
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and lifecycle_intent_id = $4
    for update
    """
  end

  def read_lifecycle_intent_outcome do
    """
    select status, terminal_reason, applied_event_id, applied_revision
    from sync_lifecycle_intents
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and lifecycle_intent_id = $4
    """
  end

  def read_lifecycle_event do
    """
    select
      event_id,
      base_revision,
      revision,
      event_name,
      payload,
      actor_participant_session_id,
      command_id,
      lifecycle_intent_id,
      external_operation_id,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    from sync_control_events
    where tenant_id = $1 and session_id = $2 and lifecycle_intent_id = $3
    """
  end

  def insert_lifecycle_event do
    """
    insert into sync_control_events (
      tenant_id,
      room_id,
      session_id,
      event_id,
      base_revision,
      revision,
      event_name,
      payload,
      lifecycle_intent_id,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    """
  end

  def update_join_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      snapshot_reserved_bytes = snapshot_reserved_bytes - 2048,
      lifecycle_event_count = lifecycle_event_count + 1,
      lifecycle_event_bytes = lifecycle_event_bytes + $9,
      lifecycle_reserved_events = lifecycle_reserved_events - 1,
      lifecycle_reserved_bytes = lifecycle_reserved_bytes - 16384,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and control_revision = $4 - 1
      and snapshot_reserved_bytes >= 2048
      and $8 + snapshot_reserved_bytes - 2048 <= 1048576
      and lifecycle_reserved_events >= 1
      and lifecycle_reserved_bytes >= 16384
      and lifecycle_event_count < 2048
      and lifecycle_event_bytes + $9 <= 33554432
    returning control_revision
    """
  end

  def update_generic_lifecycle_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      lifecycle_event_count = lifecycle_event_count + 1,
      lifecycle_event_bytes = lifecycle_event_bytes + $9,
      lifecycle_reserved_events = lifecycle_reserved_events - 1,
      lifecycle_reserved_bytes = lifecycle_reserved_bytes - 16384,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and control_revision = $4 - 1
      and $8 + snapshot_reserved_bytes <= 1048576
      and lifecycle_reserved_events >= 1
      and lifecycle_reserved_bytes >= 16384
      and lifecycle_event_count < 2048
      and lifecycle_event_bytes + $9 <= 33554432
    returning control_revision
    """
  end

  def update_end_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      snapshot_reserved_bytes = 0,
      lifecycle_event_count = lifecycle_event_count + 1,
      lifecycle_event_bytes = lifecycle_event_bytes + $9,
      lifecycle_reserved_events = 0,
      lifecycle_reserved_bytes = 0,
      lifecycle_reserved_intents = 0,
      lifecycle_reserved_intent_bytes = 0,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and control_revision = $4 - 1
      and $8 <= 1048576
      and lifecycle_reserved_events >= 1
      and lifecycle_reserved_bytes >= 16384
      and lifecycle_event_count < 2048
      and lifecycle_event_bytes + $9 <= 33554432
    returning control_revision
    """
  end

  def activate_lifecycle_participant do
    """
    update participants
    set status = 'active', joined_at = now(), updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and id = $4
      and generation = $5
      and status = 'joining'
    returning id, user_id, room_id, session_id, name, status, joined_at, left_at, updated_at
    """
  end

  def complete_lifecycle_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and id = $4
      and generation = $5
      and status = 'leaving'
    returning id, user_id, room_id, session_id, name, status, joined_at, left_at, updated_at
    """
  end

  def promote_host_after_leave do
    """
    with old_host as (
      update participants
      set role = 'cohost', updated_at = now()
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
        and status = 'leaving' and role = 'host' and 'cohost' = any(eligible_roles)
      returning id
    )
    update participants
    set role = 'host', updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $5
      and status = 'active' and role = 'cohost' and 'host' = any(eligible_roles)
      and exists (select 1 from old_host)
    returning id
    """
  end

  def complete_lifecycle_session do
    """
    update room_sessions
    set status = 'ended', ended_at = now(), updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and id = $3
      and status = 'ending'
    returning id, room_id, status, started_at, ended_at, created_at, updated_at
    """
  end

  def supersede_pending_lifecycle_intents do
    """
    update sync_lifecycle_intents
    set
      status = 'superseded',
      terminal_reason = 'superseded_by_session_end',
      completed_at = now(),
      attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
      last_error_code = null
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and lifecycle_intent_id != $4
      and status = 'pending'
    """
  end

  def complete_all_session_participants do
    """
    update participants
    set status = 'left', left_at = coalesce(left_at, now()), updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and status != 'left'
    """
  end

  def mark_lifecycle_intent_applied do
    """
    update sync_lifecycle_intents
    set
      status = 'applied',
      applied_event_id = $5,
      applied_revision = $6,
      completed_at = now(),
      attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
      last_error_code = null
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and lifecycle_intent_id = $4
      and status = 'pending'
    returning applied_revision
    """
  end

  def record_lifecycle_failure do
    """
    update sync_lifecycle_intents
    set
      attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
      last_error_code = $5,
      next_attempt_at = now() + case
        when attempt_count = 0 then interval '100 milliseconds'
        when attempt_count = 1 then interval '200 milliseconds'
        when attempt_count = 2 then interval '400 milliseconds'
        when attempt_count = 3 then interval '800 milliseconds'
        when attempt_count = 4 then interval '1600 milliseconds'
        when attempt_count = 5 then interval '3200 milliseconds'
        when attempt_count = 6 then interval '6400 milliseconds'
        when attempt_count = 7 then interval '12800 milliseconds'
        when attempt_count = 8 then interval '25600 milliseconds'
        else interval '30 seconds'
      end
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and lifecycle_intent_id = $4
      and status = 'pending'
    """
  end

  def discover_pending_lifecycle_intents do
    """
    select tenant_id, room_id, session_id, lifecycle_intent_id
    from sync_lifecycle_intents
    where status = 'pending' and next_attempt_at <= now()
    order by next_attempt_at, attempt_count, created_at, lifecycle_intent_id
    limit $1
    """
  end

  def read_control do
    """
    select
      control_revision,
      folded_state,
      state_schema_version,
      state_digest,
      room_id,
      host_participant_session_id
    from sync_session_control
    where tenant_id = $1 and room_id = $2 and session_id = $3
    """
  end

  def read_session_status do
    """
    select status
    from room_sessions
    where tenant_id = $1 and room_id = $2 and id = $3
    """
  end

  def read_participant_status do
    """
    select generation, status
    from participants
    where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
    """
  end

  def read_admission_intent do
    """
    select status
    from sync_lifecycle_intents
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and participant_session_id = $4
      and lifecycle_intent_id = $5
      and participant_session_generation = (
        select generation
        from participants
        where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
      )
      and intent_name = 'participant_joined'
    """
  end

  def read_cursor_digest do
    """
    select resulting_state_digest
    from sync_control_events
    where tenant_id = $1 and session_id = $2 and revision = $3
    """
  end

  def replay_summary do
    """
    select count(*), coalesce(sum(encoded_bytes), 0)
    from sync_control_events
    where tenant_id = $1
      and session_id = $2
      and revision > $3
      and revision <= $4
    """
  end

  def read_recovery_page do
    """
    with candidates as (
      select
        event_id,
        base_revision,
        revision,
        event_name,
        payload,
        actor_participant_session_id,
        command_id,
        lifecycle_intent_id,
        external_operation_id,
        event_schema_version,
        resulting_state_digest,
        encoded_bytes,
        sum(encoded_bytes) over (order by revision) as running_encoded_bytes
      from sync_control_events
      where tenant_id = $1
        and session_id = $2
        and revision > $3
        and revision <= $4
      order by revision
      limit 128
    )
    select
      event_id,
      base_revision,
      revision,
      event_name,
      payload,
      actor_participant_session_id,
      command_id,
      lifecycle_intent_id,
      external_operation_id,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    from candidates
    where running_encoded_bytes <= 261120
    order by revision
    """
  end

  def lock_operation_session do
    """
    select
      status,
      host_exit_policy,
      role_capabilities,
      deadline_at,
      deadline_generation,
      maximum_duration_ceiling_seconds,
      created_at
    from room_sessions
    where tenant_id = $1 and room_id = $2 and id = $3
    for update
    """
  end

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
    join sync_session_control control
      on control.tenant_id = receipt.tenant_id
      and control.session_id = receipt.session_id
    where receipt.tenant_id = $1
      and control.room_id = $2
      and receipt.session_id = $3
      and receipt.participant_session_id = $4
      and receipt.command_id = $5
    """
  end

  def select_internal_operation do
    """
    select #{external_operation_columns()}
    from sync_external_operations
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and operation_name = $4
      and request_key = $5
    """
  end

  def count_pending_operations do
    """
    select count(*)
    from sync_external_operations
    where tenant_id = $1 and room_id = $2 and session_id = $3 and status = 'pending'
    """
  end

  def insert_external_operation do
    """
    insert into sync_external_operations (
      tenant_id, room_id, session_id, external_operation_id, request_key,
      request_fingerprint, operation_name, actor_participant_session_id,
      actor_generation, target_participant_session_id, target_participant_generation,
      source, recording_id, deadline_generation, journey_id, parent_journey_event_id,
      producing_trace_id, producing_span_id, payload, fence_active
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20
    )
    """
  end

  def insert_external_operation_journey_event do
    """
    insert into observability_journey_events (
      event_id, journey_id, sequence, occurred_at, name, phase, state,
      origin_kind, first_observed_layer, upstream_visibility, parent_event_id,
      trace_id, span_id, attributes
    ) values (
      $1, $2,
      (select coalesce(max(sequence), -1) + 1 from observability_journey_events where journey_id = $2),
      $3, 'sync.external_operation.accepted', 'acceptance', 'accepted',
      'server', 'sync', $4, null, $5, $6, $7
    )
    """
  end

  def insert_pending_operation_receipt do
    """
    insert into sync_command_receipts (
      tenant_id, session_id, participant_session_id, submitted_generation,
      command_id, request_fingerprint, command_name, outcome, external_operation_id
    ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
    """
  end

  def increment_pending_operation_capacity do
    """
    update sync_session_control
    set
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $4,
      updated_at = now()
    where tenant_id = $1
      and room_id = $2
      and session_id = $3
      and receipt_count < 500000
      and receipt_bytes + $4 <= 4294967296
    returning control_revision
    """
  end

  def read_operation do
    """
    select #{external_operation_columns()}
    from sync_external_operations
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4
    """
  end

  def lock_operation do
    read_operation() <> " for update"
  end

  def participant_authority do
    """
    select
      session.status,
      participant.generation,
      participant.status,
      participant.role,
      session.role_capabilities
    from room_sessions session
    left join participants participant
      on participant.tenant_id = session.tenant_id
     and participant.room_id = session.room_id
     and participant.session_id = session.id
     and participant.id = $4
    where session.tenant_id = $1 and session.room_id = $2 and session.id = $3
    for share of session
    """
  end

  def select_publication_grant_reservation do
    """
    select reservation_id, operation_id, participant_session_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and room_id = $2 and session_id = $3 and operation_id = $4
    """
  end

  def lock_publication_grant_reservation do
    read_publication_grant_reservation() <> " for update"
  end

  def read_publication_grant_reservation do
    """
    select reservation_id, operation_id, participant_session_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and room_id = $2 and session_id = $3 and reservation_id = $4
    """
  end

  def insert_publication_grant_reservation do
    """
    insert into sync_publication_grant_reservations (
      tenant_id, room_id, session_id, reservation_id, operation_id,
      participant_session_id, participant_generation, source, expires_at
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '30 seconds')
    on conflict (tenant_id, session_id, participant_session_id, source)
      where status in ('pending', 'ambiguous') do update
    set room_id = excluded.room_id, reservation_id = excluded.reservation_id,
      operation_id = excluded.operation_id,
      participant_generation = excluded.participant_generation,
      status = 'pending', failure_code = null,
      expires_at = excluded.expires_at, created_at = now(), completed_at = null
    where sync_publication_grant_reservations.expires_at <= now()
    returning reservation_id, operation_id, participant_session_id,
      participant_generation, source, status, failure_code, expires_at
    """
  end

  def complete_publication_grant_reservation do
    """
    update sync_publication_grant_reservations
    set status = $5, failure_code = $6,
      completed_at = case when $5 in ('confirmed', 'failed') then now() else null end,
      expires_at = greatest(expires_at, now() + interval '5 minutes')
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and reservation_id = $4 and status in ('pending', 'ambiguous')
    returning reservation_id, operation_id, participant_session_id,
      participant_generation, source, status, failure_code, expires_at
    """
  end

  def lock_active_publication_reservations do
    """
    select reservation_id, operation_id, participant_session_id,
      participant_generation, source, status, failure_code, expires_at
    from sync_publication_grant_reservations
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and participant_session_id = $4 and participant_generation = $5
      and expires_at > now()
    order by source
    for update
    """
  end

  def publication_fence do
    """
    select external_operation_id
    from sync_publication_fences
    where tenant_id = $1 and session_id = $2 and participant_session_id = $3
      and participant_generation = $4 and source = $5 and expires_at > now()
    for update
    """
  end

  def count_publication_grant_reservations do
    """
    select count(*)
    from sync_publication_grant_reservations
    where tenant_id = $1 and room_id = $2 and session_id = $3 and expires_at > now()
    """
  end

  def pending_role_transition_child_for_source do
    """
    select external_operation_id
    from sync_external_operations
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and operation_name = 'role_transition_source_stop' and status = 'pending'
      and target_participant_session_id = $4 and target_participant_generation = $5
      and source = $6
    order by created_at, external_operation_id
    for update
    limit 1
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
      'tenant_transfer_host',
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
                and reservation.session_id = sync_external_operations.session_id
                and reservation.participant_session_id = sync_external_operations.target_participant_session_id
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
                and reservation.session_id = sync_external_operations.session_id
                and reservation.participant_session_id = sync_external_operations.target_participant_session_id
                and reservation.participant_generation = sync_external_operations.target_participant_generation
                and reservation.status in ('pending', 'ambiguous')
                and reservation.expires_at > now()
            )
          )
          or (
            operation_name in ('end_session', 'tenant_end_session', 'maximum_duration_expired')
            and not exists (
              select 1
              from sync_publication_grant_reservations reservation
              where reservation.tenant_id = sync_external_operations.tenant_id
                and reservation.session_id = sync_external_operations.session_id
                and reservation.status in ('pending', 'ambiguous')
                and reservation.expires_at > now()
            )
          )
          or (
            source is null
            and operation_name not in (
              'remove_participant', 'participant_leave',
              'end_session', 'tenant_end_session', 'maximum_duration_expired'
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
    select #{external_operation_columns("claimed")}
    from claimed
    order by next_attempt_at, attempt_count, created_at, external_operation_id
    """
  end

  def insert_role_transition_parent do
    """
    insert into sync_external_operations (
      tenant_id, room_id, session_id, external_operation_id, request_key,
      request_fingerprint, operation_name, actor_participant_session_id,
      actor_generation, target_participant_session_id, target_participant_generation,
      payload, fence_active
    ) values ($1, $2, $3, $4, $5, $6, 'role_transition_cleanup', $7, $8, $9, $10, $11, true)
    """
  end

  def insert_role_transition_child do
    """
    insert into sync_external_operations (
      tenant_id, room_id, session_id, external_operation_id, parent_external_operation_id,
      request_key, request_fingerprint, operation_name,
      target_participant_session_id, target_participant_generation, source, payload
    ) values ($1, $2, $3, $4, $5, $6, $7, 'role_transition_source_stop', $8, $9, $10, $11)
    """
  end

  def insert_pending_role_transition_receipt do
    """
    insert into sync_command_receipts (
      tenant_id, session_id, participant_session_id, submitted_generation,
      command_id, request_fingerprint, command_name, outcome, external_operation_id,
      event_id, resulting_revision, resulting_state_digest
    ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, $10, $11)
    """
  end

  def apply_role_transition_child do
    """
    update sync_external_operations
    set status = 'applied', completed_at = now(), last_error_code = null
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_source_stop'
      and status = 'pending'
    returning parent_external_operation_id
    """
  end

  def fail_role_transition_child do
    """
    update sync_external_operations
    set status = 'failed', completed_at = now(), last_error_code = $5
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_source_stop'
      and status = 'pending'
    returning parent_external_operation_id
    """
  end

  def lock_role_transition_parent do
    """
    select #{external_operation_columns()}
    from sync_external_operations
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
    for update
    """
  end

  def role_transition_child_statuses do
    """
    select status
    from sync_external_operations
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and parent_external_operation_id = $4
    order by source
    for update
    """
  end

  def apply_role_transition_parent do
    """
    update sync_external_operations
    set status = 'applied', fence_active = false, completed_at = now(), last_error_code = null
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
      and status = 'pending'
    returning external_operation_id
    """
  end

  def fail_role_transition_parent do
    """
    update sync_external_operations
    set status = 'failed', last_error_code = $5, completed_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4 and operation_name = 'role_transition_cleanup'
      and status = 'pending'
    returning external_operation_id
    """
  end

  def commit_role_transition_receipt do
    """
    update sync_command_receipts
    set outcome = 'committed', completed_at = now()
    where tenant_id = $1 and session_id = $2 and external_operation_id = $3
      and outcome = 'pending'
    returning command_id
    """
  end

  def fail_role_transition_receipt do
    """
    update sync_command_receipts
    set outcome = 'rejected', rejection_reason = 'external_operation_failed', completed_at = now()
    where tenant_id = $1 and session_id = $2 and external_operation_id = $3
      and outcome = 'pending'
    returning command_id
    """
  end

  def lock_admission_request do
    """
    select
      admission_request_id,
      participant_session_id,
      display_name,
      initial_role,
      eligible_roles,
      status,
      expires_at,
      decision_external_operation_id
    from sync_admission_requests
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and admission_request_id = $4
    for update
    """
  end

  def lock_admission_participant do
    """
    select generation, status, name, role, eligible_roles
    from participants
    where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
    for update
    """
  end

  def lock_admission_lifecycle_intent do
    """
    select lifecycle_intent_id, status, participant_session_generation
    from sync_lifecycle_intents
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and participant_session_id = $4
      and intent_name = 'participant_joined'
    for update
    """
  end

  def reserve_admission_request do
    """
    update sync_admission_requests
    set decision_external_operation_id = $5
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id is null
    returning participant_session_id
    """
  end

  def release_admission_request_reservation do
    """
    update sync_admission_requests
    set decision_external_operation_id = null
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id = $5
    returning participant_session_id
    """
  end

  def finalize_admission_request do
    """
    update sync_admission_requests
    set status = $5, completed_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id = $6
    returning participant_session_id
    """
  end

  def supersede_admission_join_intent do
    """
    update sync_lifecycle_intents
    set
      status = 'superseded', terminal_reason = 'participant_already_terminal',
      completed_at = now(), last_error_code = null
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and participant_session_id = $4 and intent_name = 'participant_joined'
      and status = 'pending'
    """
  end

  def complete_admission_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and id = $4 and status = 'joining'
    """
  end

  def insert_publication_fence do
    """
    insert into sync_publication_fences (
      tenant_id, room_id, session_id, participant_session_id,
      participant_generation, source, external_operation_id, expires_at
    ) values ($1, $2, $3, $4, $5, $6, $7, now() + interval '5 minutes')
    on conflict (tenant_id, session_id, participant_session_id, source) do update
    set
      room_id = excluded.room_id,
      participant_generation = excluded.participant_generation,
      external_operation_id = excluded.external_operation_id,
      expires_at = excluded.expires_at,
      created_at = now()
    where sync_publication_fences.expires_at <= now()
    returning external_operation_id
    """
  end

  def delete_operation_fences do
    """
    delete from sync_publication_fences
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and external_operation_id = $4
    """
  end

  def lock_active_participants do
    """
    select id, generation, role, eligible_roles
    from participants
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and status in ('active', 'leaving')
    order by id
    for update
    """
  end

  def mark_participant_leaving do
    """
    update participants
    set status = 'leaving', updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and id = $4 and generation = $5 and status = 'active'
    returning id
    """
  end

  def restore_participant_active do
    """
    update participants
    set status = 'active', updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and id = $4 and generation = $5 and status = 'leaving'
    returning id
    """
  end

  def complete_external_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and id = $4 and generation = $5 and status = 'leaving'
    returning id, user_id, room_id, session_id, name, status, joined_at, left_at, updated_at
    """
  end

  def mark_session_ending do
    """
    update room_sessions
    set status = 'ending', updated_at = now()
    where tenant_id = $1 and room_id = $2 and id = $3 and status = 'active'
    returning id
    """
  end

  def restore_session_active do
    """
    update room_sessions
    set status = 'active', updated_at = now()
    where tenant_id = $1 and room_id = $2 and id = $3 and status = 'ending'
    returning id
    """
  end

  def complete_external_session do
    """
    update room_sessions
    set status = 'ended', ended_at = now(), updated_at = now()
    where tenant_id = $1 and room_id = $2 and id = $3 and status = 'ending'
    returning id, room_id, status, started_at, ended_at, created_at, updated_at
    """
  end

  def complete_external_session_participants do
    """
    update participants
    set status = 'left', left_at = coalesce(left_at, now()), updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3 and status <> 'left'
    """
  end

  def complete_external_session_admissions do
    """
    update sync_admission_requests
    set status = 'expired', decision_external_operation_id = $4, completed_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3 and status = 'pending'
    """
  end

  def complete_external_session_recordings do
    """
    update sync_recordings
    set status = 'stopped', completed_at = now(), updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and status in ('starting', 'recording', 'stopping')
    """
  end

  def insert_recording_reservation do
    """
    insert into sync_recordings (
      tenant_id, room_id, session_id, recording_id, status, generation,
      started_by_participant_session_id, started_by_generation,
      start_external_operation_id
    ) values ($1, $2, $3, $4, 'starting', 1, $5, $6, $7)
    returning recording_id
    """
  end

  def lock_recording do
    """
    select status, generation, start_external_operation_id, stop_external_operation_id
    from sync_recordings
    where tenant_id = $1 and room_id = $2 and session_id = $3 and recording_id = $4
    for update
    """
  end

  def lock_active_recording_for_end do
    """
    select recording_id
    from sync_recordings
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and status in ('starting', 'recording', 'stopping')
    for update
    """
  end

  def accept_recording_stop do
    """
    update sync_recordings
    set status = 'stopping', stop_external_operation_id = $5, updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and recording_id = $4 and status = 'recording'
      and stop_external_operation_id is null
    returning recording_id
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
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and recording_id = $4 and status in ('starting', 'stopping')
    returning recording_id
    """
  end

  def insert_external_event do
    """
    insert into sync_control_events (
      tenant_id, room_id, session_id, event_id, base_revision, revision,
      event_name, payload, actor_participant_session_id, actor_generation,
      external_operation_id, event_schema_version, resulting_state_digest, encoded_bytes
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    """
  end

  def update_external_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and control_revision = $4 - 1
      and $8 + snapshot_reserved_bytes <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
    returning control_revision
    """
  end

  def update_external_end_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      snapshot_reserved_bytes = 0,
      lifecycle_reserved_events = 0,
      lifecycle_reserved_bytes = 0,
      lifecycle_reserved_intents = 0,
      lifecycle_reserved_intent_bytes = 0,
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and control_revision = $4 - 1
      and $8 <= 1048576
      and participant_event_count < 250000
      and participant_event_bytes + $9 <= 2147483648
    returning control_revision
    """
  end

  def update_external_admission_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
      host_participant_session_id = $10,
      snapshot_reserved_bytes = greatest(snapshot_reserved_bytes - 2048, 0),
      lifecycle_reserved_events = greatest(lifecycle_reserved_events - 1, 0),
      lifecycle_reserved_bytes = greatest(lifecycle_reserved_bytes - 16384, 0),
      participant_event_count = participant_event_count + 1,
      participant_event_bytes = participant_event_bytes + $9,
      updated_at = now()
    where tenant_id = $1 and room_id = $2 and session_id = $3
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
    where tenant_id = $1 and room_id = $2 and session_id = $3
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
    where tenant_id = $1 and room_id = $2 and session_id = $3
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
    where tenant_id = $1 and session_id = $2 and participant_session_id = $3
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
    where tenant_id = $1 and session_id = $2 and participant_session_id = $3
      and command_id = $4 and external_operation_id = $5 and outcome = 'pending'
    returning command_id
    """
  end

  def update_session_deadline do
    """
    update room_sessions
    set
      deadline_at = to_timestamp($4::double precision / 1000.0),
      maximum_duration_seconds = least(
        maximum_duration_ceiling_seconds,
        greatest(60, ceil($4::double precision / 1000.0 - extract(epoch from created_at))::integer)
      ),
      deadline_generation = $5,
      updated_at = now()
    where tenant_id = $1 and room_id = $2 and id = $3
      and status = 'active' and deadline_generation = $5 - 1
      and to_timestamp($4::double precision / 1000.0)
          <= created_at + make_interval(secs => maximum_duration_ceiling_seconds)
    returning id
    """
  end

  def transfer_host_products do
    """
    with old_host as (
      update participants
      set role = 'cohost', updated_at = now()
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
        and status in ('active', 'leaving') and role = 'host'
        and 'cohost' = any(eligible_roles)
      returning id
    ), new_host as (
      update participants
      set role = 'host', updated_at = now()
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $5
        and status = 'active' and role <> 'host' and 'host' = any(eligible_roles)
        and exists (select 1 from old_host)
      returning id
    )
    select id from new_host
    """
  end

  def release_screen_share_lease do
    """
    delete from sync_screen_share_leases
    where tenant_id = $1 and room_id = $2 and session_id = $3
      and owner_participant_session_id = $4 and owner_generation = $5
    """
  end

  defp external_operation_columns(prefix \\ nil) do
    columns = [
      "tenant_id",
      "room_id",
      "session_id",
      "external_operation_id",
      "parent_external_operation_id",
      "request_key",
      "request_fingerprint",
      "operation_name",
      "actor_participant_session_id",
      "actor_generation",
      "target_participant_session_id",
      "target_participant_generation",
      "source",
      "recording_id",
      "deadline_generation",
      "journey_id",
      "parent_journey_event_id",
      "producing_trace_id",
      "producing_span_id",
      "payload",
      "status",
      "attempt_count",
      "applied_event_id",
      "applied_revision",
      "last_error_code"
    ]

    Enum.map_join(columns, ", ", fn column ->
      if prefix, do: "#{prefix}.#{column}", else: column
    end)
  end
end
