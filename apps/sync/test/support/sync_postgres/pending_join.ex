defmodule ChalkSync.SyncPostgres.PendingJoin do
  @moduledoc """
  Seeds an Episode with a pending join.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.SyncPostgres.Rows
  alias ChalkSync.UUID

  def seed_pending_join(connection), do: seed_pending_join(connection, pending_join_policy())

  def seed_pending_join(connection, policy) do
    tenant_id = UUID.generate()
    space_id = UUID.generate()
    episode_id = UUID.generate()
    participant_id = UUID.generate()
    intent_id = UUID.generate()
    journey_id = UUID.generate()
    parent_journey_event_id = UUID.generate()
    episode = %EpisodeKey{tenant_id: tenant_id, space_id: space_id, episode_id: episode_id}
    display_name = "Pending Participant"

    payload = %{
      "participant_id" => participant_id,
      "display_name" => display_name,
      "role" => "owner"
    }

    {:ok, _result} =
      Postgrex.transaction(connection, fn transaction ->
        Postgrex.query!(transaction, "select set_config('chalk.entry_writer','1',true)", [])
        Rows.insert_product_rows(transaction, episode, [], policy)
        Rows.insert_control(transaction, episode, policy)

        Postgrex.query!(
          transaction,
          """
          insert into participants (
            id, name, capabilities, tenant_id, space_id, episode_id, generation, status,
            role
          ) values ($1, $2, $3, $4, $5, $6, 1, 'joining', 'owner')
          """,
          [
            Rows.uuid(participant_id),
            display_name,
            Reducer.new(episode_id).role_capabilities["owner"],
            Rows.uuid(tenant_id),
            Rows.uuid(space_id),
            Rows.uuid(episode_id)
          ]
        )

        insert_pending_intent(
          transaction,
          episode,
          intent_id,
          "join_pending_request_0001",
          "participant_joined",
          {participant_id, 1},
          payload,
          {journey_id, parent_journey_event_id}
        )

        payload_bytes = payload |> JSON.encode!() |> byte_size()

        Postgrex.query!(
          transaction,
          """
          update sync_episode_control
          set snapshot_reserved_bytes = 2048,
              lifecycle_reserved_events = 3,
              lifecycle_reserved_bytes = 49152,
              lifecycle_intent_count = 1,
              lifecycle_intent_bytes = $4,
              lifecycle_reserved_intents = 2,
              lifecycle_reserved_intent_bytes = 32768
          where tenant_id = $1 and space_id = $2 and episode_id = $3
          """,
          [Rows.uuid(tenant_id), Rows.uuid(space_id), Rows.uuid(episode_id), payload_bytes]
        )
      end)

    identity = %Identity{
      episode: episode,
      participant_id: participant_id,
      participant_generation: 1,
      admission_lifecycle_intent_id: intent_id,
      role: "owner",
      capabilities: Reducer.new(episode_id).role_capabilities["owner"]
    }

    %{
      episode: episode,
      identity: identity,
      lifecycle_intent_id: intent_id,
      journey_id: journey_id,
      parent_journey_event_id: parent_journey_event_id
    }
  end

  defp insert_pending_intent(
         connection,
         episode,
         intent_id,
         request_key,
         name,
         {participant_id, generation},
         payload,
         {journey_id, parent_journey_event_id}
       ) do
    Postgrex.query!(
      connection,
      """
      insert into sync_lifecycle_intents (
        tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
        request_fingerprint, intent_name, participant_id,
        participant_generation, payload, status, journey_id,
        parent_journey_event_id, producing_trace_id, producing_span_id
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12,
        '11111111111111111111111111111111', '2222222222222222'
      )
      """,
      [
        Rows.uuid(episode.tenant_id),
        Rows.uuid(episode.space_id),
        Rows.uuid(episode.episode_id),
        Rows.uuid(intent_id),
        request_key,
        :crypto.hash(:sha256, JSON.encode!(payload)),
        name,
        Rows.nullable_uuid(participant_id),
        generation,
        payload,
        Rows.uuid(journey_id),
        Rows.uuid(parent_journey_event_id)
      ]
    )
  end

  defp pending_join_policy do
    %{
      artifact_policy: %{
        "schema_version" => "episode_config.v2",
        "recording" => %{
          "mode" => "manual",
          "profile" => "composite_720p_v1",
          "retention_seconds" => 2_592_000
        },
        "transcription" => %{
          "mode" => "disabled",
          "retention_seconds" => 0,
          "source_window_seconds" => 0
        }
      }
    }
  end
end
