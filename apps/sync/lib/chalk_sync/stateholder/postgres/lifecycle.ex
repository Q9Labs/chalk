defmodule ChalkSync.Stateholder.Postgres.Lifecycle do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Authority, as: AuthoritySQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

  @schema_version 1
  @max_event_bytes 32 * 1024

  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case Postgrex.query(
               Database.connection(episode),
               SQL.record_lifecycle_failure(),
               Scope.lifecycle_intent(episode, lifecycle_intent_id) ++ [Atom.to_string(reason)],
               timeout: 1_000
             ) do
          {:ok, _result} -> :ok
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end

      :error ->
        :ok
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def pending_lifecycle_intents(limit) when is_integer(limit) and limit in 1..64 do
    episode = %EpisodeKey{
      tenant_id: "background",
      space_id: "background",
      episode_id: "background"
    }

    case Postgrex.query(
           Database.connection(episode),
           SQL.discover_pending_lifecycle_intents(),
           [limit],
           timeout: 2_000
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [tenant_id, space_id, episode_id, intent_id] ->
           {%EpisodeKey{
              tenant_id: UUID.load!(tenant_id),
              space_id: UUID.load!(space_id),
              episode_id: UUID.load!(episode_id)
            }, UUID.load!(intent_id)}
         end)}

      {:error, _reason} ->
        {:retryable, :dependency_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def transaction(connection, episode, lifecycle_intent_id) do
    Transaction.configure(connection)
    control = lock_lifecycle_control(connection, episode)
    intent = lock_intent(connection, episode, lifecycle_intent_id)

    case intent.status do
      "applied" -> lifecycle_decision(connection, episode, lifecycle_intent_id, intent)
      "superseded" -> superseded_lifecycle_decision(lifecycle_intent_id, intent)
      "pending" -> apply_pending_lifecycle(connection, episode, control, intent)
    end
  end

  defp lock_lifecycle_control(connection, episode) do
    case Postgrex.query!(connection, AuthoritySQL.lock_control(), Scope.episode(episode)).rows do
      [row] -> Control.from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

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

  defp apply_pending_lifecycle(connection, episode, control, intent) do
    episode_status = lock_lifecycle_episode_status(connection, episode)
    participant = lock_lifecycle_participant(connection, episode, intent)

    with :ok <- validate_lifecycle_product_state(intent, episode_status, participant),
         {:ok, state} <- Control.validate_fold(episode, control),
         payload = lifecycle_payload(intent, participant, state),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, lifecycle_name(intent.name), payload) do
      persist_commit(connection, episode, intent, event, next_state)
    else
      {:error, reason} ->
        Postgrex.rollback(connection, {:error, normalize_lifecycle_error(reason)})
    end
  end

  defp lock_lifecycle_episode_status(connection, episode) do
    case Postgrex.query!(connection, AuthoritySQL.lock_episode(), Scope.episode(episode)).rows do
      [[status, _config_snapshot, _deadline_at, _deadline_generation, _created_at]] ->
        status

      [] ->
        Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  defp lock_lifecycle_participant(_connection, _episode, %{name: "episode_ended"}), do: nil

  defp lock_lifecycle_participant(
         connection,
         episode,
         %{name: "admission_requested", payload: payload}
       ) do
    with {:ok, admission_request_id} <- UUID.dump(payload["admission_request_id"]),
         {:ok, participant_id} <- UUID.dump(payload["participant_id"]) do
      admission_params = Scope.episode(episode) ++ [admission_request_id]

      admission =
        case Postgrex.query!(connection, SQL.lock_admission_request(), admission_params).rows do
          [
            [
              id,
              participant_id,
              display_name,
              role,
              status,
              expires_at,
              _
            ]
          ] ->
            %{
              id: UUID.load!(id),
              participant_id: UUID.load!(participant_id),
              display_name: display_name,
              role: role,
              status: status,
              expires_at: expires_at
            }

          [] ->
            Postgrex.rollback(connection, {:error, :admission_request_not_found})
        end

      participant =
        case Postgrex.query!(
               connection,
               SQL.lock_admission_participant(),
               Scope.episode(episode) ++ [participant_id]
             ).rows do
          [[generation, status, display_name, role, capabilities]] ->
            %{
              id: payload["participant_id"],
              generation: generation,
              status: status,
              display_name: display_name,
              role: role,
              capabilities: capabilities
            }

          [] ->
            Postgrex.rollback(connection, {:error, :participant_not_found})
        end

      %{admission: admission, participant: participant}
    else
      :error -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_intent})
    end
  end

  defp lock_lifecycle_participant(connection, episode, intent) do
    params = Scope.episode(episode) ++ [Scope.uuid(intent.participant_id)]

    case Postgrex.query!(connection, AuthoritySQL.lock_participant(), params).rows do
      [[generation, status, role, capabilities]] ->
        %{generation: generation, status: status, role: role, capabilities: capabilities}

      [] ->
        Postgrex.rollback(connection, {:error, :participant_not_found})
    end
  end

  defp validate_lifecycle_product_state(
         %{name: "participant_joined"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_generation ->
        {:error, :stale_participant_generation}

      participant.status != "joining" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_product_state(
         %{name: "admission_requested", payload: payload},
         "active",
         %{admission: admission, participant: participant}
       ) do
    expected_payload = %{
      "admission_request_id" => admission.id,
      "participant_id" => admission.participant_id,
      "display_name" => admission.display_name,
      "role" => admission.role,
      "expires_at_ms" => DateTime.to_unix(admission.expires_at, :millisecond)
    }

    if admission.status == "pending" and participant.status == "joining" and
         participant.id == admission.participant_id and
         participant.display_name == admission.display_name and
         participant.role == admission.role and payload == expected_payload do
      :ok
    else
      {:error, :invalid_lifecycle_transition}
    end
  end

  defp validate_lifecycle_product_state(
         %{name: "participant_left"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_generation ->
        {:error, :stale_participant_generation}

      participant.status != "leaving" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_product_state(%{name: "episode_ended"}, "ending", nil), do: :ok

  defp validate_lifecycle_product_state(%{name: name}, status, _participant)
       when name in ["participant_joined", "participant_left"] and status in ["ending", "ended"],
       do: {:error, :episode_ending}

  defp validate_lifecycle_product_state(_intent, _status, _participant),
    do: {:error, :invalid_lifecycle_transition}

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

    Postgrex.query!(connection, SQL.complete_all_episode_participants(), Scope.episode(episode))

    case Postgrex.query!(connection, SQL.complete_lifecycle_episode(), Scope.episode(episode)).rows do
      [[id, space_id, status, started_at, ended_at, created_at, updated_at]] ->
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

  defp mark_lifecycle_applied(connection, episode, intent_id, event_id, revision) do
    params = Scope.lifecycle_intent(episode, intent_id) ++ [Scope.uuid(event_id), revision]

    case Postgrex.query!(connection, SQL.mark_lifecycle_intent_applied(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp lifecycle_decision(connection, episode, lifecycle_intent_id, intent) do
    params = [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(lifecycle_intent_id)
    ]

    case Postgrex.query!(connection, SQL.read_lifecycle_event(), params).rows do
      [row] ->
        event = Control.event_from_row(row)

        %LifecycleDecision{
          lifecycle_intent_id: lifecycle_intent_id,
          result: :already_applied,
          event_id: intent.applied_event_id,
          revision: intent.applied_revision,
          event: event
        }

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp superseded_lifecycle_decision(lifecycle_intent_id, intent) do
    %LifecycleDecision{
      lifecycle_intent_id: lifecycle_intent_id,
      result: :superseded,
      reason: lifecycle_terminal_reason(intent.terminal_reason)
    }
  end

  defp lifecycle_name("admission_requested"), do: :admission_requested
  defp lifecycle_name("participant_joined"), do: :participant_joined
  defp lifecycle_name("participant_left"), do: :participant_left
  defp lifecycle_name("episode_ended"), do: :episode_ended

  defp lifecycle_payload(%{name: "participant_joined", payload: payload}, participant, state) do
    payload
    |> Map.put("role", participant.role)
    |> Map.put("admission_revision", state.revision + 1)
  end

  defp lifecycle_payload(intent, _participant, _state), do: intent.payload

  defp normalize_lifecycle_error(:revision_gap), do: :invalid_state
  defp normalize_lifecycle_error(:invalid_payload), do: :invalid_lifecycle_intent
  defp normalize_lifecycle_error(:unknown_event), do: :invalid_lifecycle_intent
  defp normalize_lifecycle_error(reason), do: reason

  defp lifecycle_terminal_reason("superseded_by_episode_end"),
    do: :superseded_by_episode_end

  defp lifecycle_terminal_reason("participant_already_terminal"),
    do: :participant_already_terminal

  defp lifecycle_terminal_reason("participant_generation_replaced"),
    do: :participant_generation_replaced

  def resolve_uncertain(episode, lifecycle_intent_id) do
    connection = Database.connection(episode, 1)
    params = Scope.lifecycle_intent(episode, lifecycle_intent_id)

    case Postgrex.query(connection, SQL.read_lifecycle_intent_outcome(), params, timeout: 1_000) do
      {:ok, %{rows: [["applied", nil, event_id, revision]]}} ->
        event_params = [
          Scope.uuid(episode.tenant_id),
          Scope.uuid(episode.episode_id),
          Scope.uuid(lifecycle_intent_id)
        ]

        case Postgrex.query(connection, SQL.read_lifecycle_event(), event_params, timeout: 1_000) do
          {:ok, %{rows: [row]}} ->
            {:ok,
             %LifecycleDecision{
               lifecycle_intent_id: lifecycle_intent_id,
               result: :already_applied,
               event_id: UUID.load!(event_id),
               revision: revision,
               event: Control.event_from_row(row)
             }}

          _ ->
            {:retryable, :decision_unavailable}
        end

      {:ok, %{rows: [["superseded", reason, nil, nil]]}} ->
        {:ok,
         %LifecycleDecision{
           lifecycle_intent_id: lifecycle_intent_id,
           result: :superseded,
           reason: lifecycle_terminal_reason(reason)
         }}

      {:ok, %{rows: [["pending", nil, nil, nil]]}} ->
        {:retryable, :decision_unavailable}

      {:ok, %{rows: []}} ->
        {:error, :lifecycle_intent_not_found}

      _ ->
        {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end
end
