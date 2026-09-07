defmodule ChalkSync.Stateholder.Postgres.SQL.Lifecycle do
  @moduledoc false

  def lock_lifecycle_intent do
    """
    select
      status,
      intent_name,
      participant_id,
      participant_generation,
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
      and space_id = $2
      and episode_id = $3
      and lifecycle_intent_id = $4
    for update
    """
  end

  def read_lifecycle_intent_outcome do
    """
    select status, terminal_reason, applied_event_id, applied_revision
    from sync_lifecycle_intents
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
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
      actor_participant_id,
      command_id,
      lifecycle_intent_id,
      external_operation_id,
      event_schema_version,
      resulting_state_digest,
      encoded_bytes
    from sync_control_events
    where tenant_id = $1 and episode_id = $2 and lifecycle_intent_id = $3
    """
  end

  def insert_lifecycle_event do
    """
    insert into sync_control_events (
      tenant_id,
      space_id,
      episode_id,
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
    update sync_episode_control
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
      and space_id = $2
      and episode_id = $3
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
    update sync_episode_control
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
      and space_id = $2
      and episode_id = $3
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
    update sync_episode_control
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
      and space_id = $2
      and episode_id = $3
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
      and space_id = $2
      and episode_id = $3
      and id = $4
      and generation = $5
      and status = 'joining'
    returning id, identity_id, space_id, episode_id, name, status, joined_at, left_at, updated_at
    """
  end

  def complete_lifecycle_participant do
    """
    update participants
    set status = 'left', left_at = now(), updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and id = $4
      and generation = $5
      and status = 'leaving'
    returning id, identity_id, space_id, episode_id, name, status, joined_at, left_at, updated_at
    """
  end

  def complete_lifecycle_episode do
    """
    update episodes
    set status = 'ended', ended_at = now(), updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and id = $3
      and status = 'ending'
    returning id, space_id, status, started_at, ended_at, created_at, updated_at
    """
  end

  def supersede_pending_lifecycle_intents do
    """
    update sync_lifecycle_intents
    set
      status = 'superseded',
      terminal_reason = 'superseded_by_episode_end',
      completed_at = now(),
      attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
      last_error_code = null
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and lifecycle_intent_id != $4
      and status = 'pending'
    """
  end

  def complete_all_episode_participants do
    """
    update participants
    set status = 'left', left_at = coalesce(left_at, now()), updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
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
      and space_id = $2
      and episode_id = $3
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
      and space_id = $2
      and episode_id = $3
      and lifecycle_intent_id = $4
      and status = 'pending'
    """
  end

  def discover_pending_lifecycle_intents do
    """
    select tenant_id, space_id, episode_id, lifecycle_intent_id
    from sync_lifecycle_intents
    where status = 'pending' and next_attempt_at <= now()
    order by next_attempt_at, attempt_count, created_at, lifecycle_intent_id
    limit $1
    """
  end

  def lock_admission_request do
    """
    select
      admission_request_id,
      participant_id,
      display_name,
      role,
      status,
      expires_at,
      decision_external_operation_id
    from sync_admission_requests
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and admission_request_id = $4
    for update
    """
  end

  def lock_admission_participant do
    """
    select generation, status, name, role, capabilities
    from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4
    for update
    """
  end
end
