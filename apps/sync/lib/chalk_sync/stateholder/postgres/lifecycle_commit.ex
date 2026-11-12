defmodule ChalkSync.Stateholder.Postgres.LifecycleCommit do
  @moduledoc false

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: SQL
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

  @schema_version 1
  @max_event_bytes 32 * 1024

  def lock_intent(connection, episode, lifecycle_intent_id) do
    params = Scope.lifecycle_intent(episode, lifecycle_intent_id)

    case Postgrex.query!(connection, SQL.lock_lifecycle_intent(), params).rows do
      [
        [
          status,
          name,
          participant_id,
          generation,
          payload,
          reason,
          event_id,
          revision,
          journey_id,
          parent_journey_event_id,
          producing_trace_id,
          producing_span_id
        ]
      ] ->
        %{
          id: lifecycle_intent_id,
          status: status,
          name: name,
          participant_id: Scope.nullable_uuid(participant_id),
          participant_generation: generation,
          payload: payload,
          terminal_reason: reason,
          applied_event_id: Scope.nullable_uuid(event_id),
          applied_revision: revision,
          journey_id: Scope.nullable_uuid(journey_id),
          parent_journey_event_id: Scope.nullable_uuid(parent_journey_event_id),
          producing_trace_id: producing_trace_id,
          producing_span_id: producing_span_id
        }

      [] ->
        Postgrex.rollback(connection, {:error, :lifecycle_intent_not_found})
    end
  end

  def persist_commit(connection, episode, intent, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)

    stored_event =
      event
      |> Map.put(:event_id, event_id)
      |> Map.put(:command_id, nil)
      |> Map.put(:lifecycle_intent_id, intent.id)
      |> Map.put(:schema_version, @schema_version)
      |> Map.put(:resulting_state_digest, digest)

    event_bytes = Control.encoded_event_bytes(stored_event)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_lifecycle_event(connection, episode, stored_event, event_bytes)
    FaultHooks.lifecycle(:after_event_insert, episode, intent.id)
    update_lifecycle_control(connection, episode, event.name, state, event_bytes)
    webhook_object = update_lifecycle_product(connection, episode, intent, event)
    mark_lifecycle_applied(connection, episode, intent.id, event_id, event.revision)
    FaultHooks.lifecycle(:after_intent_applied, episode, intent.id)

    if webhook_object != :no_webhook do
      WebhookProducer.produce(connection, episode, intent, webhook_object)
    end

    FaultHooks.lifecycle(:after_webhook_production, episode, intent.id)
    Control.notify_head(connection, episode, event.revision)

    %LifecycleDecision{
      lifecycle_intent_id: intent.id,
      result: :applied,
      event_id: event_id,
      revision: event.revision,
      event: stored_event
    }
  end

  defp insert_lifecycle_event(connection, episode, event, event_bytes) do
    Postgrex.query!(connection, SQL.insert_lifecycle_event(), [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.space_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(event.event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      Scope.uuid(event.lifecycle_intent_id),
      event.schema_version,
      event.resulting_state_digest,
      event_bytes
    ])
  end

  defp update_lifecycle_control(connection, episode, name, state, event_bytes) do
    params = [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.space_id),
      Scope.uuid(episode.episode_id),
      state.revision,
      Reducer.snapshot(state),
      Reducer.state_schema_version(),
      Reducer.digest(state),
      Reducer.snapshot_bytes(state),
      event_bytes
    ]

    query =
      case name do
        "admission_requested" -> SQL.update_generic_lifecycle_control()
        "participant_joined" -> SQL.update_join_control()
        "participant_left" -> SQL.update_generic_lifecycle_control()
        "episode_ended" -> SQL.update_end_control()
      end

    case Postgrex.query!(connection, query, params).rows do
      [[revision]] when revision == state.revision -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp update_lifecycle_product(
         connection,
         episode,
         %{name: "participant_joined"} = intent,
         _event
       ) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(intent.participant_id), intent.participant_generation]

    case Postgrex.query!(connection, SQL.activate_lifecycle_participant(), params).rows do
      [row] ->
        WebhookObservation.participant_object(row)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp update_lifecycle_product(
         _connection,
         _episode,
         %{name: "admission_requested"},
         _event
       ),
       do: :no_webhook

  defp update_lifecycle_product(connection, episode, %{name: "participant_left"} = intent, _event) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(intent.participant_id), intent.participant_generation]

    case Postgrex.query!(connection, SQL.complete_lifecycle_participant(), params).rows do
      [row] ->
        WebhookObservation.participant_object(row)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp update_lifecycle_product(connection, episode, %{name: "episode_ended"} = intent, _event) do
    Postgrex.query!(
      connection,
      SQL.supersede_pending_lifecycle_intents(),
      Scope.episode(episode) ++ [Scope.uuid(intent.id)]
    )

    case Postgrex.query!(connection, SQL.complete_lifecycle_episode(), Scope.episode(episode)).rows do
      [[id, space_id, status, started_at, ended_at, created_at, updated_at]] ->
        complete_episode_participants(connection, episode, intent, ended_at)

        %{
          id: UUID.load!(id),
          space_id: UUID.load!(space_id),
          status: status,
          started_at: started_at,
          ended_at: ended_at,
          created_at: created_at,
          updated_at: updated_at
        }

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  def complete_episode_participants(connection, episode, source, ended_at) do
    objects =
      connection
      |> Postgrex.query!(
        SQL.complete_all_episode_participants(),
        Scope.episode(episode) ++ [ended_at]
      )
      |> Map.fetch!(:rows)
      |> Enum.map(&WebhookObservation.participant_object/1)

    WebhookProducer.produce_episode_departures(connection, episode, source, objects)
  end

  defp mark_lifecycle_applied(connection, episode, intent_id, event_id, revision) do
    params = Scope.lifecycle_intent(episode, intent_id) ++ [Scope.uuid(event_id), revision]

    case Postgrex.query!(connection, SQL.mark_lifecycle_intent_applied(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end
end
