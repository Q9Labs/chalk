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
      snapshot_bytes
    from sync_session_control
    where tenant_id = $1 and room_id = $2 and session_id = $3
    for update
    """
  end

  def lock_session do
    """
    select status
    from room_sessions
    where tenant_id = $1 and room_id = $2 and id = $3
    for update
    """
  end

  def lock_participant do
    """
    select generation, status, capabilities
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
      receipt.resulting_revision
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
      rejection_reason
    ) values ($1, $2, $3, $4, $5, $6, $7, 'rejected', $8)
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
      resulting_revision
    ) values ($1, $2, $3, $4, $5, $6, $7, 'committed', $8, $9)
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
      applied_revision
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

  def update_leave_control do
    """
    update sync_session_control
    set
      control_revision = $4,
      folded_state = $5,
      state_schema_version = $6,
      state_digest = $7,
      snapshot_bytes = $8,
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
    returning id
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
    returning id
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
      room_id
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
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    from candidates
    where running_encoded_bytes <= 261120
    order by revision
    """
  end
end
