defmodule ChalkSync.Stateholder.Postgres.Lifecycle do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.Stateholder.Postgres.Lifecycle.AutomaticRecording
  alias ChalkSync.Stateholder.Postgres.Lifecycle.Participant
  alias ChalkSync.Stateholder.Postgres.LifecycleCommit
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Authority, as: AuthoritySQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason) do
    Database.guard(
      fn -> write_lifecycle_failure(episode, lifecycle_intent_id, reason) end,
      {:retryable, :dependency_unavailable}
    )
  end

  defp write_lifecycle_failure(episode, lifecycle_intent_id, reason) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        episode
        |> Database.connection()
        |> Postgrex.query(
          SQL.record_lifecycle_failure(),
          Scope.lifecycle_intent(episode, lifecycle_intent_id) ++ [Atom.to_string(reason)],
          timeout: 1_000
        )
        |> case do
          {:ok, _result} -> :ok
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end

      :error ->
        :ok
    end
  end

  def pending_lifecycle_intents(limit) when is_integer(limit) and limit in 1..64 do
    case Postgrex.query(
           Database.connection_for(:background),
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

  def transaction(connection, episode, lifecycle_intent_id, identity \\ nil) do
    Transaction.configure(connection)
    control = lock_lifecycle_control(connection, episode)
    intent = LifecycleCommit.lock_intent(connection, episode, lifecycle_intent_id)
    prepared = JoinSeats.prepare(connection, episode, intent, identity)

    intent =
      if prepared in [:expired, :entry_expired],
        do: LifecycleCommit.lock_intent(connection, episode, lifecycle_intent_id),
        else: intent

    decision =
      case {intent.status, prepared} do
        {"applied", _prepared} ->
          lifecycle_decision(connection, episode, lifecycle_intent_id, intent)

        {"superseded", :entry_expired} ->
          %{superseded_lifecycle_decision(lifecycle_intent_id, intent) | reason: :entry_expired}

        {"superseded", _prepared} ->
          superseded_lifecycle_decision(lifecycle_intent_id, intent)

        {"pending", _prepared} ->
          apply_pending_lifecycle(connection, episode, control, intent)
      end

    if decision.result in [:applied, :already_applied],
      do: JoinSeats.claim_entry(connection, identity)

    decision
  end

  defp lock_lifecycle_control(connection, episode) do
    case Postgrex.query!(connection, AuthoritySQL.lock_control(), Scope.episode(episode)).rows do
      [row] -> Control.from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  defp apply_pending_lifecycle(connection, episode, control, intent) do
    policy = Authority.lock_episode(connection, episode)
    participant = Participant.lock_lifecycle_participant(connection, episode, intent)

    with :ok <- Participant.validate_lifecycle_product_state(intent, policy.status, participant),
         {:ok, state} <- Control.validate_fold(episode, control),
         payload = Participant.lifecycle_payload(intent, participant, state),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, Participant.lifecycle_name(intent.name), payload) do
      decision = LifecycleCommit.persist_commit(connection, episode, intent, event, next_state)

      AutomaticRecording.maybe_accept_automatic_recording(
        connection,
        episode,
        intent,
        policy,
        next_state
      )

      decision
    else
      {:error, reason} ->
        Postgrex.rollback(connection, {:error, Participant.normalize_lifecycle_error(reason)})
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

  defp lifecycle_terminal_reason("superseded_by_episode_end"),
    do: :superseded_by_episode_end

  defp lifecycle_terminal_reason("participant_already_terminal"),
    do: :participant_already_terminal

  defp lifecycle_terminal_reason("participant_generation_replaced"),
    do: :participant_generation_replaced

  def resolve_uncertain(episode, lifecycle_intent_id, %{entry_generation: generation} = identity)
      when is_integer(generation) and generation > 0 do
    connection = Database.alternate_connection(episode)
    params = Scope.participant(identity) ++ [identity.participant_generation, generation]

    case Postgrex.query(connection, SQL.read_entry_confirmation(), params, timeout: 1_000) do
      {:ok, %{rows: [[true]]}} -> resolve_uncertain(episode, lifecycle_intent_id, nil)
      _ -> {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  def resolve_uncertain(episode, lifecycle_intent_id, _identity) do
    connection = Database.alternate_connection(episode)
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
