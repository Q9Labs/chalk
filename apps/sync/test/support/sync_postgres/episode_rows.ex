defmodule ChalkSync.SyncPostgres.EpisodeRows do
  @moduledoc """
  Join history and control rows of a seeded Episode.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.SyncPostgres.Rows
  alias ChalkSync.UUID

  def insert_join_history(connection, episode, participants, policy) do
    Enum.reduce(participants, Reducer.new(episode.episode_id, policy), fn participant, state ->
      {:ok, event, next_state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_id" => participant.id,
          "display_name" => participant.display_name,
          "role" => participant.role,
          "admission_revision" => state.revision + 1
        })

      insert_join_intent_and_event(connection, episode, participant, event, next_state)
      next_state
    end)
  end

  defp insert_join_intent_and_event(connection, episode, participant, event, state) do
    intent_id = participant.admission_lifecycle_intent_id
    event_id = UUID.generate()
    request_key = "join_request_#{String.replace(participant.id, "-", "_")}"

    payload = %{
      "participant_id" => participant.id,
      "display_name" => participant.display_name
    }

    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_id,
        participant_generation, payload, status
      ) values ($1, $2, $3, $4, $5, $6, 'participant_joined', $7, $8, $9, 'pending')
      """,
      [
        Rows.uuid(episode.tenant_id),
        Rows.uuid(episode.space_id),
        Rows.uuid(episode.episode_id),
        Rows.uuid(intent_id),
        request_key,
        :crypto.hash(:sha256, request_key),
        Rows.uuid(participant.id),
        participant.generation,
        payload
      ]
    )

    wire_event = %{
      event_id: event_id,
      base_revision: event.base_revision,
      revision: event.revision,
      name: event.name,
      payload: event.payload,
      lifecycle_intent_id: intent_id,
      command_id: nil,
      schema_version: Reducer.state_schema_version(),
      resulting_state_digest: Reducer.digest(state)
    }

    encoded_bytes =
      wire_event
      |> Map.update!(:resulting_state_digest, &Base.encode16(&1, case: :lower))
      |> JSON.encode!()
      |> byte_size()

    Postgrex.query!(
      connection,
      """
      insert into sync_control_events (
        tenant_id, space_id, episode_id, event_id, base_revision, revision,
        event_name, payload, lifecycle_intent_id, event_schema_version,
        resulting_state_digest, encoded_bytes
      ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      """,
      [
        Rows.uuid(episode.tenant_id),
        Rows.uuid(episode.space_id),
        Rows.uuid(episode.episode_id),
        Rows.uuid(event_id),
        event.base_revision,
        event.revision,
        event.name,
        event.payload,
        Rows.uuid(intent_id),
        Reducer.state_schema_version(),
        Reducer.digest(state),
        encoded_bytes
      ]
    )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set status = 'applied', applied_event_id = $2, applied_revision = $3,
          completed_at = now()
      where lifecycle_intent_id = $1
      """,
      [Rows.uuid(intent_id), Rows.uuid(event_id), event.revision]
    )
  end

  def update_control(connection, episode, state, participant_count) do
    Postgrex.query!(
      connection,
      """
      update sync_episode_control
      set control_revision = $4,
          folded_state = $5,
          state_digest = $6,
          snapshot_bytes = $7,
          lifecycle_event_count = $8,
          lifecycle_event_bytes = $9,
          lifecycle_reserved_events = $10,
          lifecycle_reserved_bytes = $11,
          lifecycle_intent_count = $8,
          lifecycle_intent_bytes = $9,
          lifecycle_reserved_intents = $10,
          lifecycle_reserved_intent_bytes = $11
      where tenant_id = $1 and space_id = $2 and episode_id = $3
      """,
      [
        Rows.uuid(episode.tenant_id),
        Rows.uuid(episode.space_id),
        Rows.uuid(episode.episode_id),
        state.revision,
        Reducer.snapshot(state),
        Reducer.digest(state),
        Reducer.snapshot_bytes(state),
        participant_count,
        participant_count * 512,
        participant_count + 1,
        (participant_count + 1) * 16 * 1024
      ]
    )
  end

  def state_for(episode, participants, policy) do
    Enum.reduce(participants, Reducer.new(episode.episode_id, policy), fn participant, state ->
      {:ok, _event, state} =
        Reducer.apply_lifecycle(state, :participant_joined, %{
          "participant_id" => participant.id,
          "display_name" => participant.display_name,
          "role" => participant.role,
          "admission_revision" => state.revision + 1
        })

      state
    end)
  end
end
