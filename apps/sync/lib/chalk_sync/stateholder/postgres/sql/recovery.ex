defmodule ChalkSync.Stateholder.Postgres.SQL.Recovery do
  @moduledoc false

  def read_control do
    """
    select
      control_revision,
      folded_state,
      state_schema_version,
      state_digest,
      space_id
    from sync_episode_control
    where tenant_id = $1 and space_id = $2 and episode_id = $3
    """
  end

  def read_episode_status do
    """
    select status
    from episodes
    where tenant_id = $1 and space_id = $2 and id = $3
    """
  end

  def read_participant_status do
    """
    select generation, status
    from participants
    where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4
    """
  end

  def read_admission_intent do
    """
    select status
    from sync_lifecycle_intents
    where tenant_id = $1
      and space_id = $2
      and episode_id = $3
      and participant_id = $4
      and lifecycle_intent_id = $5
      and participant_generation = (
        select generation
        from participants
        where tenant_id = $1 and space_id = $2 and episode_id = $3 and id = $4
      )
      and intent_name = 'participant_joined'
    """
  end

  def read_cursor_digest do
    """
    select resulting_state_digest
    from sync_control_events
    where tenant_id = $1 and episode_id = $2 and revision = $3
    """
  end

  def replay_summary do
    """
    select count(*), coalesce(sum(encoded_bytes), 0)
    from sync_control_events
    where tenant_id = $1
      and episode_id = $2
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
        actor_participant_id,
        command_id,
        lifecycle_intent_id,
        external_operation_id,
        event_schema_version,
        resulting_state_digest,
        encoded_bytes,
        sum(encoded_bytes) over (order by revision) as running_encoded_bytes
      from sync_control_events
      where tenant_id = $1
        and episode_id = $2
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
      actor_participant_id,
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
end
