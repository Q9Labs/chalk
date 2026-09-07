defmodule ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner do
  @moduledoc false

  def count_pending_operations do
    """
    select count(*)
    from sync_external_operations
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and status = 'pending'
    """
  end

  def insert_external_operation do
    """
    insert into sync_external_operations (
      tenant_id, space_id, episode_id, external_operation_id, request_key,
      request_fingerprint, operation_name, actor_participant_id,
      actor_generation, target_participant_id, target_participant_generation,
      source, recording_id, deadline_generation, journey_id, parent_journey_event_id,
      producing_trace_id, producing_span_id, producing_traceparent, producing_tracestate,
      payload, fence_active
    ) values (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22
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
      tenant_id, episode_id, participant_id, submitted_generation,
      command_id, request_fingerprint, command_name, outcome, external_operation_id
    ) values ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
    """
  end

  def increment_pending_operation_capacity do
    """
    update sync_episode_control
    set
      receipt_count = receipt_count + 1,
      receipt_bytes = receipt_bytes + $4,
      updated_at = now()
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and receipt_count < 500000
      and receipt_bytes + $4 <= 4294967296
    returning control_revision
    """
  end

  def reserve_admission_request do
    """
    update sync_admission_requests
    set decision_external_operation_id = $5
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and admission_request_id = $4 and status = 'pending'
      and decision_external_operation_id is null
    returning participant_id
    """
  end

  def lock_active_participants do
    """
    select id, generation, role, capabilities
    from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and status in ('active', 'leaving')
    order by id
    for update
    """
  end

  def mark_participant_leaving do
    """
    update participants
    set status = 'leaving', updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and id = $4 and generation = $5 and status = 'active'
    returning id
    """
  end

  def mark_episode_ending do
    """
    update episodes
    set status = 'ending', updated_at = now()
    where tenant_id = $1 and space_id = $2 and id = $3 and status = 'active'
    returning id
    """
  end

  def insert_recording_reservation do
    """
    insert into sync_recordings (
      tenant_id, space_id, episode_id, recording_id, status, generation,
      started_by_participant_id, started_by_generation,
      start_external_operation_id
    ) values ($1, $2, $3, $4, 'starting', 1, $5, $6, $7)
    returning recording_id
    """
  end

  def lock_recording do
    """
    select status, generation, start_external_operation_id, stop_external_operation_id
    from sync_recordings
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and recording_id = $4
    for update
    """
  end

  def lock_active_recording_for_end do
    """
    select recording_id
    from sync_recordings
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and status in ('starting', 'recording', 'stopping')
    for update
    """
  end

  def accept_recording_stop do
    """
    update sync_recordings
    set status = 'stopping', stop_external_operation_id = $5, updated_at = now()
    where tenant_id = $1 and space_id = $2 and episode_id = $3
      and recording_id = $4 and status = 'recording'
      and stop_external_operation_id is null
    returning recording_id
    """
  end
end
