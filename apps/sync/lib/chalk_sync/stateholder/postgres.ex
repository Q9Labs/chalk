defmodule ChalkSync.Stateholder.Postgres do
  @moduledoc """
  PostgreSQL authority for atomic control decisions and recovery reads.

  Every command locks the Episode control row, resolves its receipt first,
  validates locked product facts, and commits the event, folded state, revision,
  and receipt together. Notification payloads are disposable head hints.
  """

  @behaviour ChalkSync.Stateholder

  require Logger

  alias ChalkSync.CanonicalJSON
  alias ChalkSync.Database
  alias ChalkSync.DeliveryGate
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Observability
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.SQL
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Telemetry
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer
  alias ChalkSync.Webhooks.SQL, as: WebhookSQL

  @transaction_timeout_ms 3_000
  @max_event_bytes 32 * 1024
  @max_replay_events 2_048
  @max_replay_bytes 2 * 1024 * 1024
  @max_pending_operations 2_048
  @max_publication_grant_reservations 6_144
  @pending_receipt_reserved_bytes 2_048
  @schema_version 1
  @publication_operation_id ~r/\A[A-Za-z0-9_-]{16,128}\z/

  @impl ChalkSync.Stateholder
  def decide_command(%Identity{} = identity, %Command{} = command) do
    checkpoint(:before_transaction, identity, command)

    case run_decision_transaction(identity, command) do
      {:ok, decision} ->
        checkpoint(:after_commit_before_reply, identity, command)
        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, _reason} ->
        resolve_uncertain(identity, command)
    end
  rescue
    exception ->
      Logger.error("sync decision transaction became uncertain: #{Exception.message(exception)}")
      resolve_uncertain(identity, command)
  catch
    :exit, reason ->
      Logger.error("sync decision transaction exited before resolution: #{inspect(reason)}")
      resolve_uncertain(identity, command)
  end

  @impl ChalkSync.Stateholder
  def resolve_receipt(%Identity{} = identity, %Command{} = command) do
    connection = Database.connection(identity.episode, 1)
    params = receipt_params(identity, command)

    case Postgrex.query(connection, SQL.select_receipt(), params, timeout: 1_000) do
      {:ok, %{rows: [row]}} -> {:ok, decision_from_receipt(command, row)}
      {:ok, %{rows: []}} -> :not_found
      {:error, _error} -> {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(%EpisodeKey{} = episode, lifecycle_intent_id)
      when is_binary(lifecycle_intent_id) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case run_lifecycle_transaction(episode, lifecycle_intent_id) do
          {:ok, %LifecycleDecision{} = decision} ->
            lifecycle_checkpoint(:after_commit_before_reply, episode, lifecycle_intent_id)
            observe_lifecycle_webhook(episode, lifecycle_intent_id, decision)
            {:ok, decision}

          {:error, {:retryable, reason}} ->
            {:retryable, reason}

          {:error, {:error, reason}} ->
            {:error, reason}

          {:error, _reason} ->
            resolve_uncertain_lifecycle(episode, lifecycle_intent_id)
        end

      :error ->
        {:error, :invalid_lifecycle_intent_id}
    end
  rescue
    exception ->
      Logger.error("sync lifecycle transaction became uncertain: #{Exception.message(exception)}")

      resolve_uncertain_lifecycle(episode, lifecycle_intent_id)
  catch
    :exit, reason ->
      Logger.error("sync lifecycle transaction exited before resolution: #{inspect(reason)}")
      resolve_uncertain_lifecycle(episode, lifecycle_intent_id)
  end

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(%EpisodeKey{} = episode, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case Postgrex.query(
               Database.connection(episode),
               SQL.record_lifecycle_failure(),
               lifecycle_intent_params(episode, lifecycle_intent_id) ++ [Atom.to_string(reason)],
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

  @impl ChalkSync.Stateholder
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

  @impl ChalkSync.Stateholder
  def begin_operation(%Identity{} = identity, %Operation{} = operation) do
    case run_operation_transaction(identity, operation) do
      {:ok, %OperationDecision{} = decision} -> {:ok, decision}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> resolve_uncertain_operation(identity, operation)
    end
  rescue
    exception ->
      Logger.error(
        "sync external operation acceptance became uncertain: #{Exception.message(exception)}"
      )

      resolve_uncertain_operation(identity, operation)
  catch
    :exit, reason ->
      Logger.error("sync external operation acceptance exited: #{inspect(reason)}")
      resolve_uncertain_operation(identity, operation)
  end

  @impl ChalkSync.Stateholder
  def begin_internal_operation(%EpisodeKey{} = episode, %Operation{} = operation) do
    case run_internal_operation_transaction(episode, operation) do
      {:ok, %OperationDecision{} = decision} -> {:ok, decision}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> resolve_uncertain_internal_operation(episode, operation)
    end
  rescue
    exception ->
      Logger.error(
        "sync internal operation acceptance became uncertain: #{Exception.message(exception)}"
      )

      resolve_uncertain_internal_operation(episode, operation)
  catch
    :exit, reason ->
      Logger.error("sync internal operation acceptance exited: #{inspect(reason)}")
      resolve_uncertain_internal_operation(episode, operation)
  end

  @impl ChalkSync.Stateholder
  def claim_operations(limit) when is_integer(limit) and limit in 1..64 do
    claim_operation_rows(SQL.claim_operations(), limit)
  end

  @impl ChalkSync.Stateholder
  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64 do
    claim_operation_rows(SQL.claim_local_operations(), limit)
  end

  defp claim_operation_rows(query, limit) do
    episode = %EpisodeKey{
      tenant_id: "background",
      space_id: "background",
      episode_id: "background"
    }

    case Postgrex.query(
           Database.connection(episode),
           query,
           [limit],
           timeout: 2_000
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn row ->
           operation = external_operation_from_row(row)

           {%EpisodeKey{
              tenant_id: UUID.load!(Enum.at(row, 0)),
              space_id: UUID.load!(Enum.at(row, 1)),
              episode_id: UUID.load!(Enum.at(row, 2))
            }, operation}
         end)}

      {:error, _reason} ->
        {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @impl ChalkSync.Stateholder
  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id) do
    case UUID.dump(external_operation_id) do
      {:ok, id} -> read_operation_row(episode, id)
      :error -> :not_found
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp read_operation_row(episode, id) do
    case Postgrex.query(
           Database.connection(episode, 1),
           SQL.read_operation(),
           episode_params(episode) ++ [id],
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} -> {:ok, external_operation_from_row(row)}
      {:ok, %{rows: []}} -> :not_found
      {:error, _reason} -> {:retryable, :decision_unavailable}
    end
  end

  @impl ChalkSync.Stateholder
  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation)
      when is_binary(participant_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)) do
    case UUID.dump(participant_id) do
      {:ok, participant_id} ->
        read_participant_authority(
          episode,
          participant_id,
          participant_id,
          expected_generation
        )

      :error ->
        {:error, :participant_inactive}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  defp read_participant_authority(episode, participant_id, participant_id, expected) do
    result =
      Postgrex.query(
        Database.connection(episode),
        SQL.participant_authority(),
        episode_params(episode) ++ [participant_id],
        timeout: 1_000
      )

    participant_authority_result(result, participant_id, expected)
  end

  defp participant_authority_result({:ok, %{rows: []}}, _participant_id, _expected),
    do: {:error, :episode_not_found}

  defp participant_authority_result(
         {:ok, %{rows: [[episode_status, _generation, _status, _role, _capabilities]]}},
         _participant_id,
         _expected
       )
       when episode_status != "active",
       do: {:error, :episode_ended}

  defp participant_authority_result(
         {:ok, %{rows: [["active", generation, _status, _role, _capabilities]]}},
         _participant_id,
         expected
       )
       when is_integer(expected) and generation != expected,
       do: {:error, :stale_participant_generation}

  defp participant_authority_result(
         {:ok, %{rows: [["active", generation, "active", role, capabilities]]}},
         participant_id,
         _expected
       ) do
    {:ok,
     %{
       participant_id: UUID.load!(participant_id),
       generation: generation,
       role: role,
       capabilities: capabilities
     }}
  end

  defp participant_authority_result({:ok, %{rows: [_row]}}, _participant_id, _expected),
    do: {:error, :participant_inactive}

  defp participant_authority_result({:error, _reason}, _participant_id, _expected),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def reserve_publication_grant(%Identity{} = identity, operation_id, source)
      when is_binary(operation_id) and source in [:microphone, :camera, :screen] do
    case Postgrex.transaction(
           Database.connection(identity.episode),
           &reserve_publication_grant_transaction(&1, identity, operation_id, source),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync publication grant reservation"
         ) do
      {:ok, reservation} -> {:ok, reservation}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def reserve_publication_grant(_identity, _operation_id, _source),
    do: {:error, :invalid_operation}

  @impl ChalkSync.Stateholder
  def complete_publication_grant(%EpisodeKey{} = episode, reservation_id, outcome)
      when is_binary(reservation_id) do
    case UUID.dump(reservation_id) do
      {:ok, _id} -> complete_publication_grant(episode, reservation_id, outcome, :valid)
      :error -> {:error, :reservation_not_found}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  defp complete_publication_grant(episode, reservation_id, outcome, :valid) do
    case Postgrex.transaction(
           Database.connection(episode),
           &complete_publication_grant_transaction(&1, episode, reservation_id, outcome),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync publication grant completion"
         ) do
      {:ok, result} -> {:ok, result}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end

  @impl ChalkSync.Stateholder
  def begin_role_transition(%Identity{} = identity, %Command{} = command, publications)
      when command.name in [:assign_roles] and is_list(publications) do
    case Postgrex.transaction(
           Database.connection(identity.episode),
           &role_transition_transaction(&1, identity, command, publications),
           timeout: @transaction_timeout_ms,
           commit_comment: "chalk sync role transition"
         ) do
      {:ok, decision} -> {:ok, decision}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> resolve_uncertain(identity, command)
    end
  rescue
    _exception -> resolve_uncertain(identity, command)
  catch
    :exit, _reason -> resolve_uncertain(identity, command)
  end

  def begin_role_transition(%Identity{} = identity, %Command{} = command, _publications),
    do: decide_command(identity, command)

  @impl ChalkSync.Stateholder
  def finalize_operation(%EpisodeKey{} = episode, external_operation_id, outcome)
      when is_binary(external_operation_id) and is_tuple(outcome) do
    case UUID.dump(external_operation_id) do
      {:ok, _id} -> finalize_known_operation(episode, external_operation_id, outcome)
      :error -> {:error, :operation_not_found}
    end
  rescue
    exception ->
      Logger.error(
        "sync external operation finalization became uncertain: #{Exception.message(exception)}"
      )

      resolve_uncertain_finalization(episode, external_operation_id)
  catch
    :exit, reason ->
      Logger.error("sync external operation finalization exited: #{inspect(reason)}")
      resolve_uncertain_finalization(episode, external_operation_id)
  end

  defp finalize_known_operation(episode, external_operation_id, outcome) do
    case run_operation_finalization(episode, external_operation_id, outcome) do
      {:ok, %OperationDecision{} = decision} ->
        observe_webhook_finalization(episode, external_operation_id, decision)
        {:ok, decision}

      {:error, {:retryable, reason}} ->
        {:retryable, reason}

      {:error, {:error, reason}} ->
        {:error, reason}

      {:error, _reason} ->
        resolve_uncertain_finalization(episode, external_operation_id)
    end
  end

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor) do
    connection = Database.connection(identity.episode)

    case Postgrex.transaction(
           connection,
           &recovery_transaction(&1, identity, cursor),
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %Recovery{} = recovery} -> {:ok, recovery}
      {:ok, {:error, reason}} -> {:error, reason}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @doc false
  def recover(%EpisodeKey{} = episode, cursor) do
    connection = Database.connection(episode)

    case Postgrex.transaction(
           connection,
           &recovery_transaction(&1, episode, cursor),
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %Recovery{} = recovery} -> {:ok, recovery}
      {:ok, {:error, reason}} -> {:error, reason}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @impl ChalkSync.Stateholder
  def recover_episode(%EpisodeKey{} = episode, cursor), do: recover(episode, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%EpisodeKey{} = episode, after_revision, through_revision) do
    params = [
      uuid(episode.tenant_id),
      uuid(episode.episode_id),
      after_revision,
      through_revision
    ]

    case Postgrex.query(
           Database.connection(episode),
           SQL.read_recovery_page(),
           params,
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &event_from_row/1)}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  defp run_decision_transaction(identity, command) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      &decision_transaction(&1, identity, command),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync command"
    )
  end

  defp reserve_publication_grant_transaction(connection, identity, operation_id, source) do
    configure_transaction(connection)

    unless Regex.match?(@publication_operation_id, operation_id) do
      Postgrex.rollback(connection, {:error, :invalid_operation})
    end

    policy = lock_operation_episode(connection, identity.episode)

    participant =
      lock_operation_participant(
        connection,
        identity.episode,
        identity.participant_id
      )

    with :ok <-
           validate_operation_actor(identity, %{name: :participant_leave}, policy, participant),
         :ok <- validate_publication_capability(policy, participant, source) do
      params = episode_params(identity.episode) ++ [operation_id]

      case Postgrex.query!(connection, SQL.select_publication_grant_reservation(), params).rows do
        [row] -> publication_reservation(row)
        [] -> insert_publication_grant_reservation(connection, identity, operation_id, source)
      end
    else
      {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp validate_publication_capability(_policy, participant, source) do
    capability = publication_capability(source)
    allowed = participant.capabilities
    if capability in allowed, do: :ok, else: {:error, :capability_denied}
  end

  defp insert_publication_grant_reservation(connection, identity, operation_id, source) do
    participant_id = uuid(identity.participant_id)
    source_name = Atom.to_string(source)

    fence_params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      participant_id,
      identity.participant_generation,
      source_name
    ]

    case Postgrex.query!(connection, SQL.publication_fence(), fence_params).rows do
      [] -> :ok
      [_row] -> Postgrex.rollback(connection, {:error, :publication_fenced})
    end

    case Postgrex.query!(
           connection,
           SQL.count_publication_grant_reservations(),
           episode_params(identity.episode)
         ).rows do
      [[count]] when count < @max_publication_grant_reservations -> :ok
      _ -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    reservation_id = UUID.generate()

    params =
      episode_params(identity.episode) ++
        [
          uuid(reservation_id),
          operation_id,
          participant_id,
          identity.participant_generation,
          source_name
        ]

    case Postgrex.query!(connection, SQL.insert_publication_grant_reservation(), params).rows do
      [row] -> publication_reservation(row)
      [] -> Postgrex.rollback(connection, {:error, :publication_in_progress})
    end
  end

  defp complete_publication_grant_transaction(connection, episode, reservation_id, outcome) do
    configure_transaction(connection)
    policy = lock_operation_episode(connection, episode)
    params = episode_params(episode) ++ [uuid(reservation_id)]
    observed = read_publication_reservation!(connection, params)
    participant = lock_grant_participant!(connection, episode, observed)
    reservation = lock_publication_reservation!(connection, params)

    reservation = persist_publication_grant_outcome(connection, episode, reservation, outcome)

    cleanup_required =
      publication_cleanup_required?(connection, episode, policy, participant, reservation)

    if reservation.status == :failed and cleanup_required do
      satisfy_failed_grant_child(connection, episode, reservation)
    end

    Map.put(reservation, :result, if(cleanup_required, do: :cleanup_required, else: :authorized))
  end

  defp read_publication_reservation!(connection, params) do
    case Postgrex.query!(connection, SQL.read_publication_grant_reservation(), params).rows do
      [row] -> publication_reservation(row)
      [] -> Postgrex.rollback(connection, {:error, :reservation_not_found})
    end
  end

  defp lock_grant_participant!(connection, episode, reservation) do
    participant =
      lock_operation_participant(connection, episode, reservation.participant_id)

    if participant && participant.generation == reservation.participant_generation,
      do: participant,
      else: Postgrex.rollback(connection, {:error, :participant_inactive})
  end

  defp lock_publication_reservation!(connection, params) do
    case Postgrex.query!(connection, SQL.lock_publication_grant_reservation(), params).rows do
      [row] -> publication_reservation(row)
      [] -> Postgrex.rollback(connection, {:error, :reservation_not_found})
    end
  end

  defp persist_publication_grant_outcome(
         _connection,
         _episode,
         %{status: status} = reservation,
         _outcome
       )
       when status in [:confirmed, :failed],
       do: reservation

  defp persist_publication_grant_outcome(connection, episode, reservation, outcome) do
    {status, failure_code} = publication_grant_outcome(outcome)
    params = episode_params(episode) ++ [uuid(reservation.reservation_id), status, failure_code]

    case Postgrex.query!(connection, SQL.complete_publication_grant_reservation(), params).rows do
      [row] -> publication_reservation(row)
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp publication_grant_outcome(outcome) when outcome in [:confirmed, :satisfied],
    do: {"confirmed", nil}

  defp publication_grant_outcome({:terminal_failure, reason}) when is_atom(reason),
    do: {"failed", Atom.to_string(reason)}

  defp publication_grant_outcome(_outcome), do: {"ambiguous", nil}

  defp publication_cleanup_required?(connection, episode, _policy, participant, reservation) do
    capability_denied =
      publication_capability(reservation.source) not in participant.capabilities

    fence_params = [
      uuid(episode.tenant_id),
      uuid(episode.episode_id),
      uuid(reservation.participant_id),
      reservation.participant_generation,
      Atom.to_string(reservation.source)
    ]

    capability_denied or
      Postgrex.query!(connection, SQL.publication_fence(), fence_params).rows != []
  end

  defp satisfy_failed_grant_child(connection, episode, reservation) do
    params =
      episode_params(episode) ++
        [
          uuid(reservation.participant_id),
          reservation.participant_generation,
          Atom.to_string(reservation.source)
        ]

    case Postgrex.query!(connection, SQL.pending_role_transition_child_for_source(), params).rows do
      [[child_id]] ->
        settle_role_transition_child(connection, episode, UUID.load!(child_id), :applied)

      [] ->
        :ok
    end
  end

  defp role_transition_transaction(connection, identity, command, publications) do
    configure_transaction(connection)
    {control, episode_policy, actor} = lock_authority(connection, identity)

    case fetch_receipt(connection, identity, command) do
      {:ok, row} ->
        decision_from_receipt(command, row)

      :not_found ->
        with :ok <- validate_product_state(identity, command, episode_policy, actor),
             {:ok, state} <- validate_fold(identity.episode, control, episode_policy),
             :ok <- validate_command_authority(identity, command, state),
             {:ok, affected} <-
               lock_role_transition_participants(connection, identity, command, actor),
             decision <-
               Reducer.decide_command(
                 state,
                 identity.participant_id,
                 command.name,
                 command.payload
               ) do
          decide_role_transition(
            connection,
            identity,
            command,
            episode_policy,
            affected,
            publications,
            decision
          )
        else
          {:error, reason} ->
            persist_rejection(connection, identity, command, terminal_reason(reason))
        end
    end
  end

  defp lock_role_transition_participants(
         connection,
         identity,
         %{name: :assign_roles} = command,
         _actor
       ) do
    target_id = command.payload["participantId"]

    case lock_operation_participant(connection, identity.episode, target_id) do
      %{status: "active"} = target ->
        {:ok, Map.merge(target, %{id: target_id, next_role: command.payload["role"]})}

      _ ->
        {:error, :invalid_target}
    end
  end

  defp decide_role_transition(
         connection,
         identity,
         command,
         _policy,
         _affected,
         _publications,
         {:satisfied, state}
       ),
       do: persist_satisfied(connection, identity, command, state)

  defp decide_role_transition(
         connection,
         identity,
         command,
         _policy,
         _affected,
         _publications,
         {:error, reason}
       ),
       do: persist_rejection(connection, identity, command, terminal_reason(reason))

  defp decide_role_transition(
         connection,
         identity,
         command,
         policy,
         affected,
         publications,
         {:change, event, next_state}
       ) do
    lost_sources = lost_publication_sources(policy, affected.role, affected.next_role)
    reservations = lock_publication_reservations(connection, identity.episode, affected)

    exercised_sources =
      lost_sources
      |> Enum.filter(&observed_enabled?(publications, affected.id, &1))
      |> Kernel.++(
        Enum.flat_map(reservations, fn reservation ->
          if reservation.source in lost_sources, do: [reservation.source], else: []
        end)
      )
      |> Enum.uniq()
      |> Enum.sort()

    if exercised_sources == [] do
      persist_commit(connection, identity, command, event, next_state)
    else
      persist_pending_role_transition(
        connection,
        identity,
        command,
        event,
        next_state,
        affected,
        exercised_sources
      )
    end
  end

  defp lock_publication_reservations(connection, episode, affected) do
    params = episode_params(episode) ++ [uuid(affected.id), affected.generation]

    Postgrex.query!(connection, SQL.lock_active_publication_reservations(), params).rows
    |> Enum.map(&publication_reservation/1)
  end

  defp lost_publication_sources(policy, old_role, new_role) do
    old = Map.get(policy.role_capabilities, old_role, [])
    new = Map.get(policy.role_capabilities, new_role, [])

    [:microphone, :camera, :screen]
    |> Enum.filter(fn source ->
      capability = publication_capability(source)
      capability in old and capability not in new
    end)
  end

  defp observed_enabled?(publications, participant_id, source) do
    Enum.any?(publications, fn publication ->
      Map.get(publication, :participant_id) == participant_id and
        Map.get(publication, :source) == source and Map.get(publication, :enabled) == true
    end)
  end

  defp persist_pending_role_transition(
         connection,
         identity,
         command,
         event,
         state,
         affected,
         sources
       ) do
    ensure_transition_operation_capacity(connection, identity.episode, length(sources) + 1)
    event_id = UUID.generate()
    digest = Reducer.digest(state)
    stored_event = stored_event(event, event_id, command.id, digest)
    event_bytes = encoded_event_bytes(stored_event)
    receipt_bytes = receipt_bytes(command, :pending, nil, event_id, event.revision, digest)
    parent_id = UUID.generate()

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_event(connection, identity, command, stored_event, event_bytes)
    update_command_product(connection, identity, event)
    update_control(connection, identity, state, event_bytes, receipt_bytes)
    insert_role_transition_parent(connection, identity, command, affected, parent_id)
    insert_role_transition_children(connection, identity.episode, affected, parent_id, sources)

    parent = role_transition_parent(identity, command, affected, parent_id)
    install_participant_fences(connection, identity.episode, parent, affected, sources)

    Postgrex.query!(connection, SQL.insert_pending_role_transition_receipt(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      uuid(parent_id),
      uuid(event_id),
      event.revision,
      digest
    ])

    notify_head(connection, identity.episode, event.revision)

    %Decision{
      command_id: command.id,
      result: :pending,
      delivery: :original,
      event_id: event_id,
      external_operation_id: parent_id,
      revision: event.revision,
      state_digest: digest,
      event: stored_event
    }
  end

  defp ensure_transition_operation_capacity(connection, episode, required) do
    case Postgrex.query!(connection, SQL.count_pending_operations(), episode_params(episode)).rows do
      [[count]] when count + required <= @max_pending_operations -> :ok
      _ -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp insert_role_transition_parent(connection, identity, command, affected, parent_id) do
    payload = Map.put(command.payload, "commandName", Atom.to_string(command.name))
    request_key = String.replace(identity.participant_id, "-", "") <> "_" <> command.id

    Postgrex.query!(connection, SQL.insert_role_transition_parent(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id),
      uuid(parent_id),
      request_key,
      command.fingerprint,
      uuid(identity.participant_id),
      identity.participant_generation,
      uuid(affected.id),
      affected.generation,
      payload
    ])
  end

  defp insert_role_transition_children(connection, episode, affected, parent_id, sources) do
    Enum.each(sources, fn source ->
      child_id = UUID.generate()
      request_key = "rt_#{String.replace(parent_id, "-", "")}_#{source}"
      payload = %{"participantId" => affected.id, "source" => Atom.to_string(source)}

      Postgrex.query!(
        connection,
        SQL.insert_role_transition_child(),
        episode_params(episode) ++
          [
            uuid(child_id),
            uuid(parent_id),
            request_key,
            :crypto.hash(:sha256, request_key),
            uuid(affected.id),
            affected.generation,
            Atom.to_string(source),
            payload
          ]
      )
    end)
  end

  defp role_transition_parent(identity, command, affected, parent_id) do
    %ExternalOperation{
      external_operation_id: parent_id,
      request_key: command.id,
      request_fingerprint: command.fingerprint,
      name: :role_transition_cleanup,
      payload: command.payload,
      status: :pending,
      attempt_count: 0,
      actor_participant_id: identity.participant_id,
      actor_generation: identity.participant_generation,
      target_participant_id: affected.id,
      target_participant_generation: affected.generation
    }
  end

  defp publication_capability(:microphone), do: "publishAudio"
  defp publication_capability(:camera), do: "publishVideo"
  defp publication_capability(:screen), do: "publishScreen"

  defp publication_reservation([
         reservation_id,
         operation_id,
         participant_id,
         generation,
         source,
         status,
         failure_code,
         expires_at
       ]) do
    %{
      reservation_id: UUID.load!(reservation_id),
      operation_id: operation_id,
      participant_id: UUID.load!(participant_id),
      participant_generation: generation,
      source: String.to_existing_atom(source),
      status: String.to_existing_atom(status),
      failure_code: failure_code,
      expires_at: expires_at
    }
  end

  defp run_lifecycle_transaction(episode, lifecycle_intent_id) do
    Postgrex.transaction(
      Database.connection(episode),
      &lifecycle_transaction(&1, episode, lifecycle_intent_id),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync lifecycle intent"
    )
  end

  defp run_operation_transaction(identity, operation) do
    Postgrex.transaction(
      Database.connection(identity.episode),
      &operation_transaction(&1, identity, operation),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync external operation acceptance"
    )
  end

  defp run_internal_operation_transaction(episode, operation) do
    Postgrex.transaction(
      Database.connection(episode),
      &internal_operation_transaction(&1, episode, operation),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync internal operation acceptance"
    )
  end

  defp run_operation_finalization(episode, external_operation_id, outcome) do
    Postgrex.transaction(
      Database.connection(episode),
      &operation_finalization_transaction(&1, episode, external_operation_id, outcome),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync external operation finalization"
    )
  end

  defp operation_transaction(connection, identity, operation) do
    configure_transaction(connection)
    control = lock_operation_control(connection, identity.episode)
    policy = lock_operation_episode(connection, identity.episode)
    external_operation_checkpoint(:after_acceptance_authority_lock, identity.episode, operation)

    case fetch_operation_receipt(connection, identity, operation) do
      {:ok, row} ->
        operation_decision_from_receipt(connection, identity, operation, row)

      :not_found ->
        participant =
          lock_operation_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        with :ok <- validate_operation_actor(identity, operation, policy, participant),
             {:ok, state} <- validate_fold(identity.episode, control, policy),
             {:ok, context} <- prepare_operation(connection, identity, operation, policy, state),
             :ok <- ensure_operation_capacity(connection, identity.episode) do
          persist_operation_acceptance(connection, identity, operation, policy, state, context)
        else
          {:error, :overloaded} ->
            Postgrex.rollback(connection, {:retryable, :overloaded})

          {:error, reason} ->
            persist_operation_rejection(connection, identity, operation, terminal_reason(reason))
        end
    end
  end

  defp internal_operation_transaction(connection, episode, operation) do
    configure_transaction(connection)
    control = lock_operation_control(connection, episode)
    policy = lock_operation_episode(connection, episode)
    external_operation_checkpoint(:after_acceptance_authority_lock, episode, operation)

    case fetch_internal_operation(connection, episode, operation) do
      {:ok, existing} when existing.request_fingerprint != operation.fingerprint ->
        %OperationDecision{
          request_key: operation.request_key,
          result: :command_id_conflict,
          reason: :command_id_conflict
        }

      {:ok, existing} ->
        operation_decision(existing, :duplicate)

      :not_found ->
        with :ok <- validate_internal_operation(operation),
             {:ok, state} <- validate_fold(episode, control, policy),
             {:ok, context} <-
               prepare_internal_operation(connection, episode, operation, policy, state),
             :ok <- ensure_operation_capacity(connection, episode) do
          persist_internal_operation_acceptance(
            connection,
            episode,
            operation,
            policy,
            state,
            context
          )
        else
          {:error, :overloaded} -> Postgrex.rollback(connection, {:retryable, :overloaded})
          {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp lock_operation_control(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_control(), episode_params(episode)).rows do
      [row] -> control_row(row)
      [] -> Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  defp lock_operation_episode(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_operation_episode(), episode_params(episode)).rows do
      [
        [
          status,
          config_snapshot,
          deadline_at,
          deadline_generation,
          created_at
        ]
      ] ->
        snapshot = if is_map(config_snapshot), do: config_snapshot, else: %{}

        role_capabilities =
          Map.get(snapshot, "roles", Map.get(snapshot, "role_capabilities", %{}))

        %{
          status: status,
          role_capabilities: role_capabilities,
          deadline_at: deadline_at,
          deadline_generation: deadline_generation,
          maximum_duration_ceiling_seconds:
            Map.get(snapshot, "maximum_episode_duration_seconds", 2_592_000),
          created_at: created_at
        }

      [] ->
        Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  defp lock_operation_participant(connection, episode, participant_id) do
    case Postgrex.query!(
           connection,
           SQL.lock_participant(),
           episode_params(episode) ++ [uuid(participant_id)]
         ).rows do
      [[generation, status, role, capabilities]] ->
        %{
          id: participant_id,
          generation: generation,
          status: status,
          role: role,
          capabilities: capabilities
        }

      [] ->
        nil
    end
  end

  defp fetch_operation_receipt(connection, identity, operation) do
    params =
      episode_params(identity.episode) ++
        [uuid(identity.participant_id), operation.request_key]

    case Postgrex.query!(connection, SQL.select_operation_receipt(), params).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  defp fetch_internal_operation(connection, episode, operation) do
    params =
      episode_params(episode) ++ [Atom.to_string(operation.name), operation.request_key]

    case Postgrex.query!(connection, SQL.select_internal_operation(), params).rows do
      [row] -> {:ok, external_operation_from_row(row)}
      [] -> :not_found
    end
  end

  defp validate_operation_actor(_identity, _operation, %{status: status}, _participant)
       when status != "active",
       do: {:error, :episode_ended}

  defp validate_operation_actor(_identity, _operation, _policy, nil),
    do: {:error, :participant_inactive}

  defp validate_operation_actor(identity, _operation, _policy, participant)
       when participant.generation != identity.participant_generation,
       do: {:error, :stale_participant_generation}

  defp validate_operation_actor(_identity, _operation, _policy, %{status: status})
       when status != "active",
       do: {:error, :participant_inactive}

  defp validate_operation_actor(_identity, %{name: :participant_leave}, _policy, _participant),
    do: :ok

  defp validate_operation_actor(_identity, operation, _policy, participant) do
    required = required_capability(operation.name)
    allowed = participant.capabilities
    if required in allowed, do: :ok, else: {:error, :capability_denied}
  end

  defp validate_internal_operation(%{name: name})
       when name in [
              :admission_request_expired,
              :tenant_set_deadline,
              :tenant_end_episode,
              :maximum_duration_expired
            ],
       do: :ok

  defp validate_internal_operation(_operation), do: {:error, :invalid_internal_operation}

  defp prepare_operation(connection, identity, operation, _policy, state) do
    case operation.name do
      name when name in [:admit_participant, :deny_admission] ->
        with {:ok, admission} <- lock_pending_admission(connection, identity.episode, operation) do
          {:ok, %{admission: admission, target: nil, sources: []}}
        end

      name
      when name in [
             :mute_participant,
             :stop_participant_camera,
             :stop_participant_screen_share,
             :remove_participant
           ] ->
        prepare_participant_target(connection, identity.episode, operation)

      :participant_leave ->
        target =
          lock_operation_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        validate_leave_acceptance(state, target)

      name when name in [:start_recording, :stop_recording] ->
        prepare_recording(connection, identity.episode, operation, state)

      :end_episode ->
        prepare_end_operation(connection, identity.episode, nil)

      _ ->
        {:error, :invalid_state}
    end
  end

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :admission_request_expired} = op,
         _policy,
         _state
       ) do
    case lock_pending_admission(connection, episode, op) do
      {:ok, admission} ->
        if DateTime.compare(admission.expires_at, DateTime.utc_now()) in [:lt, :eq],
          do: {:ok, %{admission: admission, target: nil, sources: []}},
          else: {:error, :invalid_state}

      error ->
        error
    end
  end

  defp prepare_internal_operation(
         _connection,
         _episode,
         %{name: :tenant_set_deadline} = operation,
         policy,
         _state
       ),
       do: prepare_deadline(operation, policy)

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :tenant_end_episode},
         policy,
         _state
       ) do
    if policy.status == "active" do
      prepare_end_operation(connection, episode, nil)
    else
      {:error, :episode_ended}
    end
  end

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :maximum_duration_expired, payload: payload},
         policy,
         _state
       ) do
    supplied_generation = payload["deadlineGeneration"]
    due = DateTime.compare(policy.deadline_at, DateTime.utc_now()) in [:lt, :eq]

    cond do
      supplied_generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      policy.status != "active" || !due ->
        {:error, :episode_ended}

      true ->
        prepare_end_operation(connection, episode, supplied_generation)
    end
  end

  defp prepare_end_operation(connection, episode, deadline_generation) do
    recording_id =
      case Postgrex.query!(
             connection,
             SQL.lock_active_recording_for_end(),
             episode_params(episode)
           ).rows do
        [[id]] -> UUID.load!(id)
        [] -> nil
      end

    {:ok,
     %{
       target: nil,
       sources: [],
       end_episode: true,
       deadline_generation: deadline_generation,
       recording_id: recording_id
     }}
  end

  defp lock_pending_admission(connection, episode, operation) do
    request_id = operation.payload["admissionRequestId"]
    params = episode_params(episode) ++ [uuid(request_id)]

    case Postgrex.query!(connection, SQL.lock_admission_request(), params).rows do
      [
        [
          id,
          participant_id,
          display_name,
          role,
          "pending",
          expires_at,
          nil
        ]
      ] ->
        {:ok,
         %{
           id: UUID.load!(id),
           participant_id: UUID.load!(participant_id),
           display_name: display_name,
           role: role,
           expires_at: expires_at
         }}

      [[_id, _participant_id, _name, _role, _status, _expires_at, _decision]] ->
        {:error, :invalid_state}

      [] ->
        {:error, :invalid_target}
    end
  end

  defp prepare_participant_target(connection, episode, operation) do
    target_id = operation.payload["participantId"]

    case lock_operation_participant(connection, episode, target_id) do
      %{status: "active"} = target ->
        sources = operation_sources(operation.name)
        {:ok, %{target: target, sources: sources}}

      _ ->
        {:error, :invalid_target}
    end
  end

  defp validate_leave_acceptance(state, %{status: "active"} = target) do
    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => target.id,
           "reason" => "left"
         }) do
      {:change, _event, _next} ->
        {:ok, %{target: target, sources: [:microphone, :camera, :screen], leave: true}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp validate_leave_acceptance(_state, _target), do: {:error, :participant_inactive}

  defp prepare_recording(_connection, _episode, %{name: :start_recording} = operation, state) do
    recording_id = operation.payload["recordingId"]

    if is_nil(state.recording) or state.recording["status"] in ["stopped", "failed"] do
      {:ok, %{recording_id: recording_id, recording_action: :start, target: nil, sources: []}}
    else
      {:error, :recording_in_progress}
    end
  end

  defp prepare_recording(connection, episode, %{name: :stop_recording} = operation, state) do
    recording_id = operation.payload["recordingId"]
    params = episode_params(episode) ++ [uuid(recording_id)]

    case Postgrex.query!(connection, SQL.lock_recording(), params).rows do
      [["recording", _generation, _start_id, nil]] ->
        if state.recording == %{
             "recording_id" => recording_id,
             "status" => "recording",
             "failure_code" => nil
           } do
          {:ok, %{recording_id: recording_id, recording_action: :stop, target: nil, sources: []}}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_target}
    end
  end

  defp prepare_deadline(operation, policy) do
    deadline_at_ms = operation.payload["deadlineAtMs"]
    generation = operation.payload["deadlineGeneration"]

    ceiling_ms =
      DateTime.to_unix(policy.created_at, :millisecond) +
        policy.maximum_duration_ceiling_seconds * 1_000

    if generation == policy.deadline_generation + 1 and deadline_at_ms <= ceiling_ms do
      {:ok,
       %{
         target: nil,
         sources: [],
         deadline_generation: generation,
         deadline_at_ms: deadline_at_ms
       }}
    else
      {:error, :invalid_state}
    end
  end

  defp ensure_operation_capacity(connection, episode) do
    case Postgrex.query!(connection, SQL.count_pending_operations(), episode_params(episode)).rows do
      [[count]] when count < @max_pending_operations -> :ok
      _ -> {:error, :overloaded}
    end
  end

  defp persist_operation_acceptance(connection, identity, operation, _policy, state, context) do
    external = build_external_operation(identity, operation, context)

    insert_external_operation(
      connection,
      identity.episode,
      external,
      context,
      operation.observed_context
    )

    accepted_state =
      persist_pre_call_authority(connection, identity.episode, external, state, context)

    insert_pending_operation_receipt(connection, identity, operation, external)

    increment_pending_receipt_capacity(connection, identity.episode, accepted_state.revision)
    operation_decision(external, :original)
  end

  defp persist_internal_operation_acceptance(
         connection,
         episode,
         operation,
         _policy,
         state,
         context
       ) do
    external = build_external_operation(nil, operation, context)
    insert_external_operation(connection, episode, external, context, operation.observed_context)
    _accepted_state = persist_pre_call_authority(connection, episode, external, state, context)
    operation_decision(external, :original)
  end

  defp build_external_operation(identity, operation, context) do
    target = context[:target]
    observed = operation.observed_context

    %ExternalOperation{
      external_operation_id: UUID.generate(),
      request_key: operation.request_key,
      request_fingerprint: operation.fingerprint,
      name: operation.name,
      payload: operation.payload,
      status: :pending,
      attempt_count: 0,
      actor_participant_id: identity && identity.participant_id,
      actor_generation: identity && identity.participant_generation,
      target_participant_id: target && target.id,
      target_participant_generation: target && target.generation,
      recording_id: context[:recording_id],
      deadline_generation: context[:deadline_generation],
      journey_id: observed && observed.journey_id,
      parent_journey_event_id: observed && observed.parent_journey_event_id,
      producing_trace_id: observed && observed.producing_trace_id,
      producing_span_id: observed && observed.producing_span_id
    }
  end

  defp insert_external_operation(connection, episode, external, context, observed) do
    source = operation_source(external.name)
    fence_active = context.sources != [] || context[:end_episode] == true

    Postgrex.query!(connection, SQL.insert_external_operation(), [
      uuid(episode.tenant_id),
      uuid(episode.space_id),
      uuid(episode.episode_id),
      uuid(external.external_operation_id),
      external.request_key,
      external.request_fingerprint,
      operation_name_string(external.name),
      nullable_dump(external.actor_participant_id),
      external.actor_generation,
      nullable_dump(external.target_participant_id),
      external.target_participant_generation,
      source,
      nullable_dump(external.recording_id),
      external.deadline_generation,
      nullable_dump(external.journey_id),
      nullable_dump(external.parent_journey_event_id),
      external.producing_trace_id,
      external.producing_span_id,
      external.payload,
      fence_active
    ])

    insert_external_operation_journey_event(connection, external, observed)
  end

  defp operation_name_string(:maximum_duration_expired), do: "maximum_episode_duration_expired"
  defp operation_name_string(name), do: Atom.to_string(name)

  defp insert_external_operation_journey_event(_connection, _external, nil), do: :ok

  defp insert_external_operation_journey_event(connection, external, observed) do
    Postgrex.query!(connection, SQL.insert_external_operation_journey_event(), [
      uuid(observed.parent_journey_event_id),
      uuid(observed.journey_id),
      observed.occurred_at,
      "visible",
      observed.producing_trace_id,
      observed.producing_span_id,
      %{
        "external_operation_id" => external.external_operation_id,
        "operation" => Atom.to_string(external.name)
      }
    ])
  end

  defp persist_pre_call_authority(connection, episode, external, state, context) do
    reserve_admission_decision(connection, episode, external, context[:admission])

    participants =
      if context[:end_episode],
        do: lock_all_operation_participants(connection, episode),
        else: List.wrap(context[:target])

    install_operation_fences(connection, episode, external, participants, context)

    cond do
      context[:recording_action] == :start ->
        accept_recording_start(connection, episode, external)
        persist_acceptance_fact(connection, episode, external, state, "starting")

      context[:recording_action] == :stop ->
        accept_recording_stop(connection, episode, external)
        persist_acceptance_fact(connection, episode, external, state, "stopping")

      context[:leave] || external.name == :remove_participant ->
        mark_operation_participant_leaving(connection, episode, external)
        state

      context[:end_episode] ->
        mark_operation_episode_ending(connection, episode)
        state

      true ->
        state
    end
  end

  defp reserve_admission_decision(_connection, _episode, _external, nil), do: :ok

  defp reserve_admission_decision(connection, episode, external, admission) do
    participant_id = uuid(admission.participant_id)

    params =
      episode_params(episode) ++
        [uuid(admission.id), uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.reserve_admission_request(), params).rows do
      [[^participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp lock_all_operation_participants(connection, episode) do
    Postgrex.query!(connection, SQL.lock_active_participants(), episode_params(episode)).rows
    |> Enum.map(fn [id, generation, role, capabilities] ->
      %{
        id: UUID.load!(id),
        generation: generation,
        status: "active",
        role: role,
        capabilities: capabilities
      }
    end)
  end

  defp install_operation_fences(connection, episode, external, participants, context) do
    sources = if context[:end_episode], do: [:microphone, :camera, :screen], else: context.sources

    Enum.each(
      participants,
      &install_participant_fences(connection, episode, external, &1, sources)
    )
  end

  defp install_participant_fences(_connection, _episode, _external, nil, _sources), do: :ok

  defp install_participant_fences(connection, episode, external, participant, sources) do
    Enum.each(sources, fn source ->
      operation_id = uuid(external.external_operation_id)

      params =
        episode_params(episode) ++
          [uuid(participant.id), participant.generation, Atom.to_string(source), operation_id]

      case Postgrex.query!(connection, SQL.insert_publication_fence(), params).rows do
        [[^operation_id]] -> :ok
        _ -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end)
  end

  defp mark_operation_participant_leaving(connection, episode, external) do
    params =
      episode_params(episode) ++
        [uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.mark_participant_leaving(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_target})
    end
  end

  defp mark_operation_episode_ending(connection, episode) do
    case Postgrex.query!(connection, SQL.mark_episode_ending(), episode_params(episode)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :episode_ended})
    end
  end

  defp accept_recording_start(connection, episode, external) do
    params =
      episode_params(episode) ++
        [
          uuid(external.recording_id),
          uuid(external.actor_participant_id),
          external.actor_generation,
          uuid(external.external_operation_id)
        ]

    case Postgrex.query!(connection, SQL.insert_recording_reservation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :recording_in_progress})
    end
  end

  defp accept_recording_stop(connection, episode, external) do
    params =
      episode_params(episode) ++
        [uuid(external.recording_id), uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.accept_recording_stop(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_target})
    end
  end

  defp persist_acceptance_fact(connection, episode, external, state, status) do
    payload = %{
      "recording_id" => external.recording_id,
      "status" => status,
      "failure_code" => nil
    }

    case Reducer.apply_external(state, :recording_status_changed, payload) do
      {:ok, event, next_state} ->
        persist_external_event(connection, episode, external, event, next_state)
        next_state

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp insert_pending_operation_receipt(connection, identity, operation, external) do
    Postgrex.query!(connection, SQL.insert_pending_operation_receipt(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      identity.participant_generation,
      operation.request_key,
      operation.fingerprint,
      Atom.to_string(operation.name),
      uuid(external.external_operation_id)
    ])
  end

  defp increment_pending_receipt_capacity(connection, episode, revision) do
    params = episode_params(episode) ++ [@pending_receipt_reserved_bytes]

    case Postgrex.query!(connection, SQL.increment_pending_operation_capacity(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp persist_operation_rejection(connection, identity, operation, reason) do
    command = operation_as_command(operation)

    persist_rejection(connection, identity, command, reason)
    |> operation_rejection_from_command(operation)
  end

  defp operation_as_command(operation) do
    %{
      id: operation.request_key,
      name: operation.name,
      fingerprint: operation.fingerprint,
      payload: operation.payload
    }
  end

  defp operation_rejection_from_command(%Decision{} = decision, operation) do
    %OperationDecision{
      request_key: operation.request_key,
      result: decision.result,
      reason: decision.reason
    }
  end

  defp operation_sources(:mute_participant), do: [:microphone]
  defp operation_sources(:stop_participant_camera), do: [:camera]
  defp operation_sources(:stop_participant_screen_share), do: [:screen]
  defp operation_sources(:remove_participant), do: [:microphone, :camera, :screen]

  defp operation_source(:mute_participant), do: "microphone"
  defp operation_source(:stop_participant_camera), do: "camera"
  defp operation_source(:stop_participant_screen_share), do: "screen"
  defp operation_source(_name), do: nil

  defp operation_decision_from_receipt(
         _connection,
         _identity,
         operation,
         [fingerprint, _outcome, _reason, _event_id, _revision, _digest, _operation_id]
       )
       when fingerprint != operation.fingerprint do
    %OperationDecision{
      request_key: operation.request_key,
      result: :command_id_conflict,
      reason: :command_id_conflict
    }
  end

  defp operation_decision_from_receipt(
         connection,
         identity,
         _operation,
         [_fingerprint, "pending", nil, nil, nil, nil, external_operation_id]
       ) do
    params = episode_params(identity.episode) ++ [external_operation_id]

    case Postgrex.query!(connection, SQL.read_operation(), params).rows do
      [row] -> operation_decision(external_operation_from_row(row), :duplicate)
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp operation_decision_from_receipt(
         _connection,
         _identity,
         operation,
         [_fingerprint, "committed", nil, event_id, revision, digest, external_operation_id]
       ) do
    %OperationDecision{
      request_key: operation.request_key,
      result: :applied,
      delivery: :duplicate,
      external_operation_id: UUID.load!(external_operation_id),
      event_id: UUID.load!(event_id),
      revision: revision,
      state_digest: digest
    }
  end

  defp operation_decision_from_receipt(
         _connection,
         _identity,
         operation,
         [_fingerprint, "rejected", reason, nil, nil, nil, external_operation_id]
       ) do
    %OperationDecision{
      request_key: operation.request_key,
      result: :failed,
      delivery: :duplicate,
      external_operation_id: nullable_uuid(external_operation_id),
      reason: rejection_atom(reason)
    }
  end

  defp operation_decision(operation, delivery, state \\ nil, event_id \\ nil, revision \\ nil) do
    %OperationDecision{
      request_key: operation.request_key,
      result: operation.status,
      delivery: delivery,
      external_operation_id: operation.external_operation_id,
      event_id: event_id || operation.applied_event_id,
      revision: revision || operation.applied_revision,
      state_digest: state && Reducer.digest(state),
      reason: operation.last_error_code
    }
  end

  defp external_operation_from_row([
         _tenant_id,
         _space_id,
         _episode_id,
         operation_id,
         parent_operation_id,
         request_key,
         fingerprint,
         name,
         actor_id,
         actor_generation,
         target_id,
         target_generation,
         source,
         recording_id,
         deadline_generation,
         journey_id,
         parent_journey_event_id,
         producing_trace_id,
         producing_span_id,
         payload,
         status,
         attempt_count,
         applied_event_id,
         applied_revision,
         last_error_code
       ]) do
    %ExternalOperation{
      external_operation_id: UUID.load!(operation_id),
      parent_external_operation_id: nullable_uuid(parent_operation_id),
      request_key: request_key,
      request_fingerprint: fingerprint,
      name: external_operation_name(name),
      payload: payload,
      status: String.to_existing_atom(status),
      attempt_count: attempt_count,
      actor_participant_id: nullable_uuid(actor_id),
      actor_generation: actor_generation,
      target_participant_id: nullable_uuid(target_id),
      target_participant_generation: target_generation,
      source: source && String.to_existing_atom(source),
      recording_id: nullable_uuid(recording_id),
      deadline_generation: deadline_generation,
      journey_id: nullable_uuid(journey_id),
      parent_journey_event_id: nullable_uuid(parent_journey_event_id),
      producing_trace_id: producing_trace_id,
      producing_span_id: producing_span_id,
      applied_event_id: nullable_uuid(applied_event_id),
      applied_revision: applied_revision,
      last_error_code: failure_reason(last_error_code)
    }
  end

  defp external_operation_name("maximum_episode_duration_expired"), do: :maximum_duration_expired
  defp external_operation_name(name), do: String.to_existing_atom(name)

  defp failure_reason(nil), do: nil

  defp failure_reason(value) do
    String.to_existing_atom(value)
  rescue
    ArgumentError -> :external_operation_failed
  end

  defp operation_finalization_transaction(connection, episode, external_operation_id, outcome) do
    configure_transaction(connection)
    control = lock_operation_control(connection, episode)
    policy = lock_operation_episode(connection, episode)
    external = lock_external_operation(connection, episode, external_operation_id)

    cond do
      external.status != :pending ->
        operation_decision(external, :duplicate)

      stale_maximum_duration?(external, policy) ->
        settle_stale_maximum_duration(connection, episode, external)

      true ->
        with {:ok, state} <- validate_fold(episode, control, policy),
             :ok <- validate_finalization_authority(connection, episode, external, policy) do
          finalize_pending_operation(connection, episode, external, state, outcome)
        else
          {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp stale_maximum_duration?(%{name: :maximum_duration_expired} = external, policy) do
    external.deadline_generation != policy.deadline_generation ||
      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt
  end

  defp stale_maximum_duration?(_external, _policy), do: false

  defp settle_stale_maximum_duration(connection, episode, external) do
    release_failed_acceptance(connection, episode, external)
    delete_operation_fences(connection, episode, external)
    mark_external_failed(connection, episode, external, "stale_deadline_generation")

    failed = %{
      external
      | status: :failed,
        last_error_code: :stale_deadline_generation
    }

    operation_decision(failed, :original)
  end

  defp lock_external_operation(connection, episode, external_operation_id) do
    params = episode_params(episode) ++ [uuid(external_operation_id)]

    case Postgrex.query!(connection, SQL.lock_operation(), params).rows do
      [row] -> external_operation_from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :operation_not_found})
    end
  end

  defp validate_finalization_authority(connection, episode, external, policy) do
    with :ok <- validate_finalization_episode(external, policy),
         :ok <- validate_finalization_participant(connection, episode, external, :actor),
         :ok <- validate_finalization_participant(connection, episode, external, :target) do
      validate_finalization_deadline(external, policy)
    end
  end

  defp validate_finalization_episode(%{name: name}, %{status: "ending"})
       when name in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: :ok

  defp validate_finalization_episode(%{name: name}, %{status: "active"})
       when name not in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: :ok

  defp validate_finalization_episode(_external, _policy), do: {:error, :episode_ended}

  defp validate_finalization_participant(_connection, _episode, external, field)
       when field == :actor and is_nil(external.actor_participant_id),
       do: :ok

  defp validate_finalization_participant(_connection, _episode, external, field)
       when field == :target and is_nil(external.target_participant_id),
       do: :ok

  defp validate_finalization_participant(connection, episode, external, field) do
    {participant_id, generation} =
      case field do
        :actor ->
          {external.actor_participant_id, external.actor_generation}

        :target ->
          {external.target_participant_id, external.target_participant_generation}
      end

    case lock_operation_participant(connection, episode, participant_id) do
      %{generation: ^generation, status: status}
      when status in ["active", "leaving", "joining"] ->
        :ok

      %{generation: _other} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp validate_finalization_deadline(
         %{name: :tenant_set_deadline, deadline_generation: generation},
         policy
       ) do
    if generation == policy.deadline_generation + 1,
      do: :ok,
      else: {:error, :stale_deadline_generation}
  end

  defp validate_finalization_deadline(
         %{name: :maximum_duration_expired, deadline_generation: generation},
         policy
       ) do
    cond do
      generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt ->
        {:error, :stale_deadline_generation}

      true ->
        :ok
    end
  end

  defp validate_finalization_deadline(_external, _policy), do: :ok

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :admit_participant} = external,
         state,
         {:confirmed, :local}
       ) do
    with {:ok, admission} <- lock_reserved_admission_for_external(connection, episode, external) do
      finalize_admission_approval(
        connection,
        episode,
        external,
        state,
        :participant_joined,
        admission_join_payload(admission, state)
      )
    end
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :local}
       )
       when name in [:deny_admission, :admission_request_expired, :tenant_set_deadline],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :provider}
       )
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant,
              :participant_leave,
              :end_episode,
              :tenant_end_episode,
              :maximum_duration_expired
            ],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :recording}
       )
       when name in [:start_recording, :stop_recording],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:confirmed, _provider}
       ) do
    settle_role_transition_child(connection, episode, external.external_operation_id, :applied)
    operation_decision(%{external | status: :applied}, :original)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:applied, _name, _payload}
       ) do
    settle_role_transition_child(connection, episode, external.external_operation_id, :applied)
    operation_decision(%{external | status: :applied}, :original)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:failed, reason}
       )
       when is_atom(reason) do
    settle_role_transition_child(
      connection,
      episode,
      external.external_operation_id,
      {:failed, reason}
    )

    operation_decision(%{external | status: :failed, last_error_code: reason}, :original)
  end

  defp finalize_pending_operation(connection, episode, external, state, {:failed, reason})
       when is_atom(reason) do
    failure_code = Atom.to_string(reason)

    if byte_size(failure_code) > 96 do
      Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end

    state = maybe_persist_recording_failure(connection, episode, external, state, failure_code)
    release_failed_acceptance(connection, episode, external)
    delete_operation_fences(connection, episode, external)
    mark_external_failed(connection, episode, external, failure_code)
    reject_external_receipt(connection, episode, external)

    failed = %{external | status: :failed, last_error_code: reason}
    operation_decision(failed, :original, state)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         external,
         state,
         {:applied, name, payload}
       )
       when is_atom(name) and is_map(payload) do
    if external.name == :admit_participant do
      finalize_admission_approval(connection, episode, external, state, name, payload)
    else
      finalize_external_fact(connection, episode, external, state, name, payload)
    end
  end

  defp finalize_pending_operation(connection, _episode, _external, _state, _outcome),
    do: Postgrex.rollback(connection, {:error, :invalid_operation_outcome})

  defp finalize_confirmed_operation(connection, episode, external, state) do
    case local_operation_outcome(external, state) do
      {:ok, event_name, payload} ->
        finalize_pending_operation(
          connection,
          episode,
          external,
          state,
          {:applied, event_name, payload}
        )

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp settle_role_transition_child(connection, episode, child_id, result) do
    params = episode_params(episode) ++ [uuid(child_id)]

    parent_id =
      case result do
        :applied ->
          case Postgrex.query!(connection, SQL.apply_role_transition_child(), params).rows do
            [[id]] -> id
            [] -> Postgrex.rollback(connection, {:error, :invalid_state})
          end

        {:failed, reason} ->
          failure_code = Atom.to_string(reason)

          case Postgrex.query!(
                 connection,
                 SQL.fail_role_transition_child(),
                 params ++ [failure_code]
               ).rows do
            [[id]] -> id
            [] -> Postgrex.rollback(connection, {:error, :invalid_state})
          end
      end

    settle_role_transition_parent(connection, episode, UUID.load!(parent_id))
  end

  defp settle_role_transition_parent(connection, episode, parent_id) do
    params = episode_params(episode) ++ [uuid(parent_id)]

    parent =
      case Postgrex.query!(connection, SQL.lock_role_transition_parent(), params).rows do
        [row] -> external_operation_from_row(row)
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end

    statuses =
      Postgrex.query!(connection, SQL.role_transition_child_statuses(), params).rows
      |> Enum.map(&hd/1)

    case role_transition_settlement(statuses) do
      :failed -> fail_role_transition_parent(connection, episode, parent_id, params)
      :applied -> apply_role_transition_parent(connection, episode, parent, parent_id, params)
      :pending -> :pending
    end
  end

  defp role_transition_settlement(statuses) do
    cond do
      "failed" in statuses -> :failed
      statuses != [] and Enum.all?(statuses, &(&1 == "applied")) -> :applied
      true -> :pending
    end
  end

  defp fail_role_transition_parent(connection, episode, parent_id, params) do
    case Postgrex.query!(
           connection,
           SQL.fail_role_transition_parent(),
           params ++ ["external_operation_failed"]
         ).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end

    Postgrex.query!(connection, SQL.fail_role_transition_receipt(), [
      uuid(episode.tenant_id),
      uuid(episode.episode_id),
      uuid(parent_id)
    ])
  end

  defp apply_role_transition_parent(connection, episode, parent, parent_id, params) do
    case Postgrex.query!(connection, SQL.apply_role_transition_parent(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end

    delete_operation_fences(connection, episode, parent)

    Postgrex.query!(connection, SQL.commit_role_transition_receipt(), [
      uuid(episode.tenant_id),
      uuid(episode.episode_id),
      uuid(parent_id)
    ])
  end

  defp local_operation_outcome(%{name: name} = external, state)
       when name in [:participant_leave, :remove_participant] do
    reason = if name == :participant_leave, do: "left", else: "removed"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, _next_state} ->
        {:ok, String.to_existing_atom(event.name), event.payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp local_operation_outcome(external, state) do
    case expected_fact(external, state) do
      {name, payload} -> {:ok, name, payload}
      :invalid -> {:error, :invalid_operation_outcome}
    end
  end

  defp finalize_external_fact(connection, episode, external, state, name, payload) do
    case expected_external_fact(external, state, name, payload) do
      {:ok, event, next_state} ->
        event_id = persist_external_event(connection, episode, external, event, next_state)

        webhook_object =
          update_external_products(connection, episode, external, event, next_state)

        delete_operation_fences(connection, episode, external)
        mark_external_applied(connection, episode, external, event_id, event.revision)

        commit_external_receipt(
          connection,
          episode,
          external,
          event_id,
          event.revision,
          next_state
        )

        WebhookProducer.produce_external(connection, episode, external, event, webhook_object)
        external_operation_checkpoint(:after_webhook_production, episode, external)
        notify_head(connection, episode, event.revision)

        applied = %{
          external
          | status: :applied,
            applied_event_id: event_id,
            applied_revision: event.revision
        }

        operation_decision(applied, :original, next_state)

      {:error, _reason} ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp finalize_admission_approval(
         connection,
         episode,
         external,
         state,
         :participant_joined,
         payload
       ) do
    with {:ok, admission} <- lock_reserved_admission_for_external(connection, episode, external),
         true <- payload == admission_join_payload(admission, state),
         {:ok, intent} <- lock_admission_join_intent(connection, episode, admission),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, :participant_joined, payload) do
      finalize_admission_row(connection, episode, admission.id, "admitted", external)
      decision = persist_lifecycle_commit(connection, episode, intent, event, next_state)
      mark_external_applied(connection, episode, external, nil, nil)

      commit_external_receipt(
        connection,
        episode,
        external,
        decision.event_id,
        decision.revision,
        next_state
      )

      applied = %{external | status: :applied}
      operation_decision(applied, :original, next_state, decision.event_id, decision.revision)
    else
      _ -> Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp finalize_admission_approval(
         _connection,
         _episode,
         _external,
         _state,
         _name,
         _payload
       ),
       do: {:error, :invalid_operation_outcome}

  defp lock_reserved_admission_for_external(connection, episode, external) do
    request_id = external.payload["admissionRequestId"]
    operation_id = uuid(external.external_operation_id)
    params = episode_params(episode) ++ [uuid(request_id)]

    case Postgrex.query!(connection, SQL.lock_admission_request(), params).rows do
      [
        [
          id,
          participant_id,
          display_name,
          role,
          "pending",
          expires_at,
          ^operation_id
        ]
      ] ->
        {:ok,
         %{
           id: UUID.load!(id),
           participant_id: UUID.load!(participant_id),
           display_name: display_name,
           role: role,
           expires_at: expires_at
         }}

      _ ->
        {:error, :invalid_state}
    end
  end

  defp admission_join_payload(admission, state) do
    %{
      "participant_id" => admission.participant_id,
      "display_name" => admission.display_name,
      "role" => admission.role,
      "admission_revision" => state.revision + 1
    }
  end

  defp lock_admission_join_intent(connection, episode, admission) do
    params = episode_params(episode) ++ [uuid(admission.participant_id)]

    case Postgrex.query!(connection, SQL.lock_admission_lifecycle_intent(), params).rows do
      [[intent_id, "pending", generation]] ->
        participant =
          lock_operation_participant(connection, episode, admission.participant_id)

        if participant && participant.generation == generation && participant.status == "joining" &&
             participant.role == admission.role do
          {:ok, lock_lifecycle_intent(connection, episode, UUID.load!(intent_id))}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_state}
    end
  end

  defp expected_external_fact(external, state, name, payload)
       when external.name in [:remove_participant, :participant_leave] do
    reason = if external.name == :remove_participant, do: "removed", else: "left"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, next_state} ->
        if name == String.to_existing_atom(event.name) and payload == event.payload,
          do: {:ok, event, next_state},
          else: {:error, :invalid_operation_outcome}

      error ->
        error
    end
  end

  defp expected_external_fact(external, state, name, payload) do
    expected = expected_fact(external, state)

    if expected == {name, payload} do
      Reducer.apply_external(state, name, payload)
    else
      {:error, :invalid_operation_outcome}
    end
  end

  defp expected_fact(%{name: :deny_admission} = external, _state),
    do: {:admission_denied, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :admission_request_expired} = external, _state),
    do: {:admission_expired, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :mute_participant} = external, _state),
    do: {:participant_microphone_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_camera} = external, _state),
    do: {:participant_camera_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_screen_share} = external, _state),
    do: {:participant_screen_share_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: name} = external, _state)
       when name in [:start_recording, :stop_recording] do
    terminal_status = if name == :start_recording, do: "recording", else: "stopped"

    {:recording_status_changed,
     %{
       "recording_id" => external.recording_id,
       "status" => terminal_status,
       "failure_code" => nil
     }}
  end

  defp expected_fact(%{name: :end_episode}, _state),
    do: {:episode_ended, %{"reason" => "ended_by_participant"}}

  defp expected_fact(%{name: :tenant_end_episode}, _state),
    do: {:episode_ended, %{"reason" => "tenant_recovery"}}

  defp expected_fact(%{name: :maximum_duration_expired}, _state),
    do: {:episode_ended, %{"reason" => "maximum_duration"}}

  defp expected_fact(%{name: :tenant_set_deadline} = external, _state),
    do:
      {:deadline_changed,
       %{
         "deadline_at_ms" => external.payload["deadlineAtMs"],
         "deadline_generation" => external.deadline_generation
       }}

  defp expected_fact(_external, _state), do: :invalid

  defp persist_external_event(connection, episode, external, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)

    stored_event =
      event
      |> Map.put(:event_id, event_id)
      |> Map.put(:command_id, nil)
      |> Map.put(:lifecycle_intent_id, nil)
      |> Map.put(:external_operation_id, external.external_operation_id)
      |> Map.put(:actor_participant_id, external.actor_participant_id)
      |> Map.put(:actor_generation, external.actor_generation)
      |> Map.put(:schema_version, @schema_version)
      |> Map.put(:resulting_state_digest, digest)

    event_bytes = encoded_event_bytes(stored_event)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    Postgrex.query!(connection, SQL.insert_external_event(), [
      uuid(episode.tenant_id),
      uuid(episode.space_id),
      uuid(episode.episode_id),
      uuid(event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      nullable_dump(external.actor_participant_id),
      external.actor_generation,
      uuid(external.external_operation_id),
      @schema_version,
      digest,
      event_bytes
    ])

    update_external_control(connection, episode, external, state, event_bytes)
    event_id
  end

  defp update_external_control(connection, episode, external, state, event_bytes) do
    params =
      episode_params(episode) ++
        [
          state.revision,
          Reducer.snapshot(state),
          Reducer.state_schema_version(),
          Reducer.digest(state),
          Reducer.snapshot_bytes(state),
          event_bytes
        ]

    query =
      cond do
        state.status == "ended" ->
          SQL.update_external_end_control()

        external.name in [:deny_admission, :admission_request_expired] ->
          SQL.update_external_admission_control()

        true ->
          SQL.update_external_control()
      end

    case Postgrex.query!(connection, query, params).rows do
      [[revision]] when revision == state.revision -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp update_external_products(connection, episode, external, _event, _state)
       when external.name in [:remove_participant, :participant_leave] do
    complete_external_participant(connection, episode, external)
  end

  defp update_external_products(connection, episode, external, _event, _state)
       when external.name in [:end_episode, :tenant_end_episode, :maximum_duration_expired] do
    complete_external_episode(connection, episode, external)
  end

  defp update_external_products(connection, episode, %{name: name} = external, _event, _state)
       when name in [:deny_admission, :admission_request_expired] do
    status = if name == :deny_admission, do: "denied", else: "expired"

    case lock_reserved_admission_for_external(connection, episode, external) do
      {:ok, admission} ->
        finalize_admission_row(connection, episode, admission.id, status, external)
        complete_denied_admission_product(connection, episode, admission)

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp update_external_products(
         connection,
         episode,
         %{name: :stop_participant_screen_share} = external,
         _event,
         _state
       ) do
    Postgrex.query!(
      connection,
      SQL.release_screen_share_lease(),
      episode_params(episode) ++
        [uuid(external.target_participant_id), external.target_participant_generation]
    )
  end

  defp update_external_products(connection, episode, %{name: name} = external, event, _state)
       when name in [:start_recording, :stop_recording],
       do: finalize_recording_product(connection, episode, external, event.payload["status"], nil)

  defp update_external_products(
         connection,
         episode,
         %{name: :tenant_set_deadline} = external,
         _event,
         _state
       ),
       do: update_deadline_product(connection, episode, external)

  defp update_external_products(_connection, _episode, _external, _event, _state), do: :ok

  defp finalize_admission_row(connection, episode, admission_id, status, external) do
    params =
      episode_params(episode) ++
        [uuid(admission_id), status, uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.finalize_admission_request(), params).rows do
      [[_participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp complete_denied_admission_product(connection, episode, admission) do
    params = episode_params(episode) ++ [uuid(admission.participant_id)]

    Postgrex.query!(connection, SQL.supersede_admission_join_intent(), params)
    Postgrex.query!(connection, SQL.complete_admission_participant(), params)
    :ok
  end

  defp complete_external_participant(connection, episode, external) do
    params =
      episode_params(episode) ++
        [uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.complete_external_participant(), params).rows do
      [row] ->
        participant_webhook_object(row)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp complete_external_episode(connection, episode, external) do
    webhook_object =
      case Postgrex.query!(connection, SQL.complete_external_episode(), episode_params(episode)).rows do
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
          Postgrex.rollback(connection, {:error, :invalid_state})
      end

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_participants(),
      episode_params(episode)
    )

    Postgrex.query!(
      connection,
      SQL.supersede_pending_lifecycle_intents(),
      episode_params(episode) ++ [uuid(external.external_operation_id)]
    )

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_admissions(),
      episode_params(episode) ++ [uuid(external.external_operation_id)]
    )

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_recordings(),
      episode_params(episode)
    )

    webhook_object
  end

  defp update_deadline_product(connection, episode, external) do
    params =
      episode_params(episode) ++
        [external.payload["deadlineAtMs"], external.deadline_generation]

    case Postgrex.query!(connection, SQL.update_episode_deadline(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :stale_deadline_generation})
    end
  end

  defp finalize_recording_product(connection, episode, external, status, failure_code) do
    params =
      episode_params(episode) ++
        [uuid(external.recording_id), status, failure_code]

    case Postgrex.query!(connection, SQL.finalize_recording(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp maybe_persist_recording_failure(connection, episode, external, state, failure_code)
       when external.name in [:start_recording, :stop_recording] do
    payload = %{
      "recording_id" => external.recording_id,
      "status" => "failed",
      "failure_code" => failure_code
    }

    case Reducer.apply_external(state, :recording_status_changed, payload) do
      {:ok, event, next_state} ->
        _event_id = persist_external_event(connection, episode, external, event, next_state)
        finalize_recording_product(connection, episode, external, "failed", failure_code)
        notify_head(connection, episode, event.revision)
        next_state

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp maybe_persist_recording_failure(_connection, _episode, _external, state, _failure_code),
    do: state

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:admit_participant, :deny_admission, :admission_request_expired] do
    params =
      episode_params(episode) ++
        [
          uuid(external.payload["admissionRequestId"]),
          uuid(external.external_operation_id)
        ]

    case Postgrex.query!(connection, SQL.release_admission_request_reservation(), params).rows do
      [[_participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:remove_participant, :participant_leave] do
    params =
      episode_params(episode) ++
        [uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.restore_participant_active(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:end_episode, :tenant_end_episode, :maximum_duration_expired] do
    case Postgrex.query!(connection, SQL.restore_episode_active(), episode_params(episode)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(_connection, _episode, _external), do: :ok

  defp delete_operation_fences(connection, episode, external) do
    Postgrex.query!(
      connection,
      SQL.delete_operation_fences(),
      episode_params(episode) ++ [uuid(external.external_operation_id)]
    )
  end

  defp mark_external_applied(connection, episode, external, event_id, revision) do
    params =
      episode_params(episode) ++
        [uuid(external.external_operation_id), nullable_dump(event_id), revision]

    case Postgrex.query!(connection, SQL.apply_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp mark_external_failed(connection, episode, external, failure_code) do
    params = episode_params(episode) ++ [uuid(external.external_operation_id), failure_code]

    case Postgrex.query!(connection, SQL.fail_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp commit_external_receipt(connection, episode, external, event_id, revision, state) do
    if external.actor_participant_id do
      params = [
        uuid(episode.tenant_id),
        uuid(episode.episode_id),
        uuid(external.actor_participant_id),
        external.request_key,
        uuid(external.external_operation_id),
        uuid(event_id),
        revision,
        Reducer.digest(state)
      ]

      case Postgrex.query!(connection, SQL.commit_operation_receipt(), params).rows do
        [[_command_id]] -> :ok
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end
  end

  defp reject_external_receipt(connection, episode, external) do
    if external.actor_participant_id do
      params = [
        uuid(episode.tenant_id),
        uuid(episode.episode_id),
        uuid(external.actor_participant_id),
        external.request_key,
        uuid(external.external_operation_id)
      ]

      case Postgrex.query!(connection, SQL.reject_operation_receipt(), params).rows do
        [[_command_id]] -> :ok
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end
  end

  defp lifecycle_transaction(connection, episode, lifecycle_intent_id) do
    configure_transaction(connection)
    control = lock_lifecycle_control(connection, episode)
    intent = lock_lifecycle_intent(connection, episode, lifecycle_intent_id)

    case intent.status do
      "applied" -> lifecycle_decision(connection, episode, lifecycle_intent_id, intent)
      "superseded" -> superseded_lifecycle_decision(lifecycle_intent_id, intent)
      "pending" -> apply_pending_lifecycle(connection, episode, control, intent)
    end
  end

  defp lock_lifecycle_control(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_control(), episode_params(episode)).rows do
      [row] -> control_row(row)
      [] -> Postgrex.rollback(connection, {:error, :episode_not_found})
    end
  end

  defp lock_lifecycle_intent(connection, episode, lifecycle_intent_id) do
    params = lifecycle_intent_params(episode, lifecycle_intent_id)

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
          participant_id: nullable_uuid(participant_id),
          participant_generation: generation,
          payload: payload,
          terminal_reason: reason,
          applied_event_id: nullable_uuid(event_id),
          applied_revision: revision,
          journey_id: nullable_uuid(journey_id),
          parent_journey_event_id: nullable_uuid(parent_journey_event_id),
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
         {:ok, state} <- validate_fold(episode, control),
         payload = lifecycle_payload(intent, participant, state),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, lifecycle_name(intent.name), payload) do
      persist_lifecycle_commit(connection, episode, intent, event, next_state)
    else
      {:error, reason} ->
        Postgrex.rollback(connection, {:error, normalize_lifecycle_error(reason)})
    end
  end

  defp lock_lifecycle_episode_status(connection, episode) do
    case Postgrex.query!(connection, SQL.lock_episode(), episode_params(episode)).rows do
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
      admission_params = episode_params(episode) ++ [admission_request_id]

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
               episode_params(episode) ++ [participant_id]
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
    params = episode_params(episode) ++ [uuid(intent.participant_id)]

    case Postgrex.query!(connection, SQL.lock_participant(), params).rows do
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

  defp persist_lifecycle_commit(connection, episode, intent, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)

    stored_event =
      event
      |> Map.put(:event_id, event_id)
      |> Map.put(:command_id, nil)
      |> Map.put(:lifecycle_intent_id, intent.id)
      |> Map.put(:schema_version, @schema_version)
      |> Map.put(:resulting_state_digest, digest)

    event_bytes = encoded_event_bytes(stored_event)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_lifecycle_event(connection, episode, stored_event, event_bytes)
    lifecycle_checkpoint(:after_event_insert, episode, intent.id)
    update_lifecycle_control(connection, episode, event.name, state, event_bytes)
    webhook_object = update_lifecycle_product(connection, episode, intent, event)
    mark_lifecycle_applied(connection, episode, intent.id, event_id, event.revision)
    lifecycle_checkpoint(:after_intent_applied, episode, intent.id)

    if webhook_object != :no_webhook do
      WebhookProducer.produce(connection, episode, intent, webhook_object)
    end

    lifecycle_checkpoint(:after_webhook_production, episode, intent.id)
    notify_head(connection, episode, event.revision)

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
      uuid(episode.tenant_id),
      uuid(episode.space_id),
      uuid(episode.episode_id),
      uuid(event.event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      uuid(event.lifecycle_intent_id),
      event.schema_version,
      event.resulting_state_digest,
      event_bytes
    ])
  end

  defp update_lifecycle_control(connection, episode, name, state, event_bytes) do
    params = [
      uuid(episode.tenant_id),
      uuid(episode.space_id),
      uuid(episode.episode_id),
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
      episode_params(episode) ++
        [uuid(intent.participant_id), intent.participant_generation]

    case Postgrex.query!(connection, SQL.activate_lifecycle_participant(), params).rows do
      [row] ->
        participant_webhook_object(row)

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
      episode_params(episode) ++
        [uuid(intent.participant_id), intent.participant_generation]

    case Postgrex.query!(connection, SQL.complete_lifecycle_participant(), params).rows do
      [row] ->
        participant_webhook_object(row)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp update_lifecycle_product(connection, episode, %{name: "episode_ended"} = intent, _event) do
    Postgrex.query!(
      connection,
      SQL.supersede_pending_lifecycle_intents(),
      episode_params(episode) ++ [uuid(intent.id)]
    )

    Postgrex.query!(connection, SQL.complete_all_episode_participants(), episode_params(episode))

    case Postgrex.query!(connection, SQL.complete_lifecycle_episode(), episode_params(episode)).rows do
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

  defp participant_webhook_object([
         id,
         identity_id,
         space_id,
         episode_id,
         name,
         status,
         joined_at,
         left_at,
         updated_at
       ]) do
    %{
      id: UUID.load!(id),
      identity_id: nullable_uuid(identity_id),
      space_id: UUID.load!(space_id),
      episode_id: UUID.load!(episode_id),
      name: name,
      status: status,
      joined_at: joined_at,
      left_at: left_at,
      updated_at: updated_at
    }
  end

  defp mark_lifecycle_applied(connection, episode, intent_id, event_id, revision) do
    params = lifecycle_intent_params(episode, intent_id) ++ [uuid(event_id), revision]

    case Postgrex.query!(connection, SQL.mark_lifecycle_intent_applied(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp lifecycle_decision(connection, episode, lifecycle_intent_id, intent) do
    params = [uuid(episode.tenant_id), uuid(episode.episode_id), uuid(lifecycle_intent_id)]

    case Postgrex.query!(connection, SQL.read_lifecycle_event(), params).rows do
      [row] ->
        event = event_from_row(row)

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

  defp decision_transaction(connection, identity, command) do
    configure_transaction(connection)
    checkpoint(:after_transaction_begin, identity, command)
    {control, episode_status, participant} = lock_authority(connection, identity)
    checkpoint(:after_authority_lock, identity, command)

    receipt = fetch_receipt(connection, identity, command)
    checkpoint(:after_receipt_lookup, identity, command)

    decision =
      case receipt do
        {:ok, row} ->
          decision_from_receipt(command, row)

        :not_found ->
          decide_new(connection, identity, command, control, episode_status, participant)
      end

    checkpoint(:before_commit, identity, command)
    decision
  end

  defp configure_transaction(connection) do
    Postgrex.query!(connection, SQL.transaction_settings(), [], timeout: 2_000)
    %{rows: [[setting]]} = Postgrex.query!(connection, SQL.effective_synchronous_commit(), [])

    unless durable_synchronous_commit?(setting) do
      Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
    end
  end

  @doc false
  @spec durable_synchronous_commit?(term()) :: boolean()
  def durable_synchronous_commit?(setting), do: setting in ["on", "remote_apply"]

  defp lock_authority(connection, identity) do
    episode_params = episode_params(identity.episode)

    control =
      case Postgrex.query!(connection, SQL.lock_control(), episode_params).rows do
        [row] -> control_row(row)
        [] -> Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    episode_policy =
      case Postgrex.query!(connection, SQL.lock_episode(), episode_params).rows do
        [[status, config_snapshot, deadline_at, deadline_generation, created_at]] ->
          snapshot = if is_map(config_snapshot), do: config_snapshot, else: %{}

          %{
            status: status,
            role_capabilities:
              Map.get(snapshot, "roles", Map.get(snapshot, "role_capabilities", %{})),
            deadline_at: deadline_at,
            deadline_generation: deadline_generation,
            created_at: created_at
          }

        [] ->
          Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    participant =
      case Postgrex.query!(connection, SQL.lock_participant(), participant_params(identity)).rows do
        [[generation, status, role, capabilities]] ->
          %{generation: generation, status: status, role: role, capabilities: capabilities}

        [] ->
          nil
      end

    {control, episode_policy, participant}
  end

  defp fetch_receipt(connection, identity, command) do
    case Postgrex.query!(connection, SQL.select_receipt(), receipt_params(identity, command)).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  defp decide_new(connection, identity, command, control, episode_policy, participant) do
    with :ok <- validate_product_state(identity, command, episode_policy, participant),
         {:ok, state} <- validate_fold(identity.episode, control, episode_policy),
         :ok <- validate_command_authority(identity, command, state),
         decision <-
           Reducer.decide_command(
             state,
             identity.participant_id,
             command.name,
             command.payload
           ) do
      case decision do
        {:change, event, next_state} ->
          persist_commit(connection, identity, command, event, next_state)

        {:satisfied, unchanged_state} ->
          persist_satisfied(connection, identity, command, unchanged_state)

        {:error, reason} ->
          persist_rejection(connection, identity, command, terminal_reason(reason))
      end
    else
      {:error, reason} ->
        persist_rejection(connection, identity, command, terminal_reason(reason))
    end
  end

  defp validate_product_state(_identity, _command, %{status: status}, _participant)
       when status != "active",
       do: {:error, :episode_ended}

  defp validate_product_state(_identity, _command, _episode_status, nil),
    do: {:error, :participant_inactive}

  defp validate_product_state(identity, _command, _episode_status, participant)
       when participant.generation != identity.participant_generation,
       do: {:error, :stale_participant_generation}

  defp validate_product_state(_identity, _command, _episode_status, participant)
       when participant.status != "active",
       do: {:error, :participant_inactive}

  defp validate_product_state(_identity, command, _episode_policy, participant) do
    capability = required_capability(command.name)
    allowed = participant.capabilities

    if capability in allowed, do: :ok, else: {:error, :capability_denied}
  end

  defp validate_command_authority(_identity, _command, _state), do: :ok

  defp validate_fold(episode, control, episode_policy) do
    with @schema_version <- control.state_schema_version,
         {:ok, state} <- Reducer.from_snapshot(episode.episode_id, control.folded_state),
         true <- state.revision == control.revision,
         true <- Reducer.digest(state) == control.digest,
         true <- state.role_capabilities == episode_policy.role_capabilities do
      {:ok, state}
    else
      _ -> {:error, :invalid_state}
    end
  end

  defp validate_fold(episode, control) do
    policy = %{
      admission_policy: control.folded_state["admission_policy"],
      role_capabilities: control.folded_state["role_capabilities"]
    }

    validate_fold(episode, control, policy)
  end

  defp persist_rejection(connection, identity, command, reason) do
    receipt_bytes = receipt_bytes(command, :rejected, reason, nil, nil)

    Postgrex.query!(connection, SQL.insert_rejected_receipt(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      Atom.to_string(reason)
    ])

    case Postgrex.query!(connection, SQL.increment_rejected_receipt_capacity(), [
           uuid(identity.episode.tenant_id),
           uuid(identity.episode.space_id),
           uuid(identity.episode.episode_id),
           receipt_bytes
         ]).rows do
      [[_revision]] ->
        checkpoint(:after_receipt_insert, identity, command)
        %Decision{command_id: command.id, result: :rejected, reason: reason}

      [] ->
        Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp persist_commit(connection, identity, command, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)
    stored_event = stored_event(event, event_id, command.id, digest)
    event_bytes = encoded_event_bytes(stored_event)
    receipt_bytes = receipt_bytes(command, :committed, nil, event_id, event.revision, digest)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_event(connection, identity, command, stored_event, event_bytes)
    checkpoint(:after_event_insert, identity, command)
    update_command_product(connection, identity, event)
    update_control(connection, identity, state, event_bytes, receipt_bytes)
    checkpoint(:after_control_update, identity, command)
    insert_committed_receipt(connection, identity, command, event_id, event.revision, digest)
    checkpoint(:after_receipt_insert, identity, command)
    notify_head(connection, identity.episode, event.revision)

    %Decision{
      command_id: command.id,
      result: :committed,
      delivery: :original,
      event_id: event_id,
      revision: event.revision,
      state_digest: digest,
      event: stored_event
    }
  end

  defp insert_event(connection, identity, command, event, event_bytes) do
    Postgrex.query!(connection, SQL.insert_event(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id),
      uuid(event.event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      event.schema_version,
      event.resulting_state_digest,
      event_bytes
    ])
  end

  defp update_control(connection, identity, state, event_bytes, receipt_bytes) do
    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id),
      state.revision,
      Reducer.snapshot(state),
      Reducer.state_schema_version(),
      Reducer.digest(state),
      Reducer.snapshot_bytes(state),
      event_bytes,
      receipt_bytes
    ]

    case Postgrex.query!(connection, SQL.update_committed_control(), params).rows do
      [[revision]] when revision == state.revision -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp insert_committed_receipt(connection, identity, command, event_id, revision, digest) do
    Postgrex.query!(connection, SQL.insert_committed_receipt(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      uuid(event_id),
      revision,
      digest
    ])
  end

  defp persist_satisfied(connection, identity, command, state) do
    digest = Reducer.digest(state)
    receipt_bytes = receipt_bytes(command, :satisfied, nil, nil, state.revision, digest)

    Postgrex.query!(connection, SQL.insert_satisfied_receipt(), [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      state.revision,
      digest
    ])

    case Postgrex.query!(connection, SQL.increment_satisfied_receipt_capacity(), [
           uuid(identity.episode.tenant_id),
           uuid(identity.episode.space_id),
           uuid(identity.episode.episode_id),
           receipt_bytes
         ]).rows do
      [[revision]] when revision == state.revision ->
        checkpoint(:after_receipt_insert, identity, command)

        %Decision{
          command_id: command.id,
          result: :satisfied,
          delivery: :original,
          revision: state.revision,
          state_digest: digest
        }

      [] ->
        Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp update_command_product(connection, identity, %{name: "role_assigned"} = event) do
    product_update!(
      connection,
      SQL.update_participant_role(),
      episode_params(identity.episode) ++
        [uuid(event.payload["participant_id"]), event.payload["role"]]
    )
  end

  defp update_command_product(_connection, _identity, _event), do: :ok

  defp product_update!(connection, sql, params) do
    case Postgrex.query!(connection, sql, params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp notify_head(connection, episode, revision) do
    payload =
      "#{episode.tenant_id}:#{episode.space_id}:#{episode.episode_id}:#{revision}"

    case DeliveryGate.decide(:postgres_head_hint, %{revision: revision}) do
      :deliver -> Postgrex.query!(connection, SQL.notify_head(), [payload])
      :drop -> :ok
    end
  end

  defp recovery_transaction(connection, %Identity{} = identity, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])

    with {:ok, control} <- read_control(connection, episode_params(identity.episode)),
         {:ok, status} <- read_episode_status(connection, episode_params(identity.episode)),
         {:ok, state} <- validate_fold(identity.episode, control) do
      case validate_recovery_identity(connection, identity, status) do
        :ok ->
          build_recovery(
            connection,
            identity.episode,
            state,
            status,
            cursor,
            identity.protocol_version
          )

        {:terminal, reason} ->
          terminal_recovery(state, reason)

        {:error, reason} ->
          {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp recovery_transaction(connection, %EpisodeKey{} = episode, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])
    params = episode_params(episode)

    with {:ok, control} <- read_control(connection, params),
         {:ok, status} <- read_episode_status(connection, params),
         {:ok, state} <- validate_fold(episode, control) do
      build_recovery(connection, episode, state, status, cursor, 1)
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_recovery_identity(_connection, _identity, status) when status != "active",
    do: {:terminal, :episode_ended}

  defp validate_recovery_identity(connection, identity, _status) do
    case Postgrex.query!(connection, SQL.read_participant_status(), participant_params(identity)).rows do
      [[generation, _status]] when generation != identity.participant_generation ->
        {:terminal, :stale_participant_generation}

      [[_generation, "active"]] ->
        validate_admission_intent(connection, identity)

      [[_generation, _status]] ->
        {:terminal, :participant_inactive}

      [] ->
        {:terminal, :participant_inactive}
    end
  end

  defp validate_admission_intent(_connection, %Identity{admission_lifecycle_intent_id: nil}),
    do: :ok

  defp validate_admission_intent(connection, identity) do
    params = participant_params(identity) ++ [uuid(identity.admission_lifecycle_intent_id)]

    case Postgrex.query!(connection, SQL.read_admission_intent(), params).rows do
      [["applied"]] -> :ok
      _ -> {:error, :invalid_admission_intent}
    end
  end

  defp read_control(connection, params) do
    case Postgrex.query!(connection, SQL.read_control(), params).rows do
      [[revision, folded_state, schema, digest, _space_id]] ->
        {:ok,
         %{
           revision: revision,
           folded_state: folded_state,
           state_schema_version: schema,
           digest: digest
         }}

      [] ->
        {:error, :episode_not_found}
    end
  end

  defp read_episode_status(connection, params) do
    case Postgrex.query!(connection, SQL.read_episode_status(), params).rows do
      [[status]] -> {:ok, status}
      [] -> {:error, :episode_not_found}
    end
  end

  defp build_recovery(_connection, _episode, state, status, nil, protocol_version),
    do: snapshot_recovery(state, status, protocol_version)

  defp build_recovery(connection, episode, state, status, cursor, protocol_version)
       when is_map(cursor) do
    head = recovery_head(state)

    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: recovery_mode(status, :up_to_date), head: head, snapshot: nil, events: []}

      valid_replay_cursor?(connection, episode, cursor, head) ->
        replay_recovery(
          connection,
          episode,
          state,
          status,
          cursor.revision,
          head.revision,
          protocol_version
        )

      true ->
        snapshot_recovery(state, status, protocol_version)
    end
  end

  defp build_recovery(_connection, _episode, state, status, _cursor, protocol_version),
    do: snapshot_recovery(state, status, protocol_version)

  defp valid_replay_cursor?(connection, episode, cursor, head) do
    valid_shape =
      is_integer(cursor.revision) and cursor.revision >= 0 and cursor.revision < head.revision and
        cursor.state_schema_version == @schema_version and is_binary(cursor.digest)

    valid_shape and cursor_digest(connection, episode, cursor.revision) == cursor.digest
  end

  defp cursor_digest(_connection, episode, 0),
    do: episode.episode_id |> Reducer.new() |> Reducer.digest()

  defp cursor_digest(connection, episode, revision) do
    params = [uuid(episode.tenant_id), uuid(episode.episode_id), revision]

    case Postgrex.query!(connection, SQL.read_cursor_digest(), params).rows do
      [[digest]] -> digest
      [] -> nil
    end
  end

  defp replay_recovery(
         connection,
         episode,
         state,
         status,
         revision,
         head_revision,
         protocol_version
       ) do
    params = [uuid(episode.tenant_id), uuid(episode.episode_id), revision, head_revision]

    [[event_count, encoded_bytes]] =
      Postgrex.query!(connection, SQL.replay_summary(), params).rows

    if event_count <= @max_replay_events and encoded_bytes <= @max_replay_bytes do
      %Recovery{
        mode: recovery_mode(status, :replay),
        head: recovery_head(state),
        snapshot: nil,
        events: [],
        replay_cursor: revision
      }
    else
      snapshot_recovery(state, status, protocol_version)
    end
  end

  defp snapshot_recovery(state, status, protocol_version) do
    %Recovery{
      mode: recovery_mode(status, :snapshot),
      head: recovery_head(state),
      snapshot: Reducer.snapshot(state, protocol_version),
      events: [],
      terminal_reason: if(status == "ended", do: :episode_ended)
    }
  end

  defp terminal_recovery(state, reason) do
    %Recovery{
      mode: :terminal,
      head: recovery_head(state),
      snapshot: nil,
      events: [],
      terminal_reason: reason
    }
  end

  defp recovery_mode("ended", _active_mode), do: :terminal
  defp recovery_mode(_status, active_mode), do: active_mode

  defp recovery_head(state) do
    %{
      revision: state.revision,
      state_schema_version: Reducer.state_schema_version(),
      digest: Reducer.digest(state)
    }
  end

  defp cursor_matches_head?(cursor, head) do
    cursor.revision == head.revision and
      cursor.state_schema_version == head.state_schema_version and cursor.digest == head.digest
  end

  defp event_from_row([
         event_id,
         base_revision,
         revision,
         name,
         payload,
         actor_id,
         command_id,
         lifecycle_intent_id,
         external_operation_id,
         schema_version,
         digest,
         _encoded_bytes
       ]) do
    %{
      event_id: UUID.load!(event_id),
      base_revision: base_revision,
      revision: revision,
      name: name,
      payload: payload,
      actor_participant_id: nullable_uuid(actor_id),
      command_id: command_id,
      lifecycle_intent_id: nullable_uuid(lifecycle_intent_id),
      external_operation_id: nullable_uuid(external_operation_id),
      schema_version: schema_version,
      resulting_state_digest: digest
    }
  end

  defp control_row([revision, folded_state, schema, digest, snapshot_bytes]) do
    %{
      revision: revision,
      folded_state: folded_state,
      state_schema_version: schema,
      digest: digest,
      snapshot_bytes: snapshot_bytes
    }
  end

  defp decision_from_receipt(
         command,
         [fingerprint, _outcome, _reason, _event, _revision, _digest, _operation_id]
       )
       when fingerprint != command.fingerprint do
    %Decision{
      command_id: command.id,
      result: :command_id_conflict,
      reason: :command_id_conflict
    }
  end

  defp decision_from_receipt(
         command,
         [_fingerprint, "pending", nil, event_id, revision, digest, operation_id]
       ) do
    %Decision{
      command_id: command.id,
      result: :pending,
      delivery: :duplicate,
      event_id: UUID.load!(event_id),
      external_operation_id: UUID.load!(operation_id),
      revision: revision,
      state_digest: digest
    }
  end

  defp decision_from_receipt(
         command,
         [_fingerprint, "committed", nil, event_id, revision, digest, operation_id]
       ) do
    %Decision{
      command_id: command.id,
      result: duplicate_result(command, :committed),
      delivery: :duplicate,
      event_id: UUID.load!(event_id),
      external_operation_id: nullable_uuid(operation_id),
      revision: revision,
      state_digest: digest
    }
  end

  defp decision_from_receipt(
         command,
         [_fingerprint, "satisfied", nil, nil, revision, digest, nil]
       ) do
    %Decision{
      command_id: command.id,
      result: :satisfied,
      delivery: :duplicate,
      revision: revision,
      state_digest: digest
    }
  end

  defp decision_from_receipt(
         command,
         [_fingerprint, "rejected", reason, event_id, revision, digest, operation_id]
       ) do
    %Decision{
      command_id: command.id,
      result: :rejected,
      reason: rejection_atom(reason),
      delivery: :duplicate,
      event_id: nullable_uuid(event_id),
      external_operation_id: nullable_uuid(operation_id),
      revision: revision,
      state_digest: digest
    }
  end

  defp stored_event(event, event_id, command_id, digest) do
    event
    |> Map.put(:event_id, event_id)
    |> Map.put(:command_id, command_id)
    |> Map.put(:lifecycle_intent_id, nil)
    |> Map.put(:schema_version, @schema_version)
    |> Map.put(:resulting_state_digest, digest)
  end

  defp receipt_bytes(command, outcome, reason, event_id, revision, digest \\ nil) do
    CanonicalJSON.encode!(%{
      "command_id" => command.id,
      "command_name" => Atom.to_string(command.name),
      "outcome" => Atom.to_string(outcome),
      "rejection_reason" => reason && Atom.to_string(reason),
      "event_id" => event_id,
      "resulting_revision" => revision,
      "resulting_state_digest" => digest && Base.encode16(digest, case: :lower),
      "request_fingerprint" => Base.url_encode64(command.fingerprint, padding: false)
    })
    |> byte_size()
  end

  defp encoded_event_bytes(event) do
    event
    |> Map.update!(:resulting_state_digest, &Base.encode16(&1, case: :lower))
    |> JSON.encode!()
    |> byte_size()
  end

  defp terminal_reason(:episode_ended), do: :episode_ended
  defp terminal_reason(:participant_inactive), do: :participant_inactive
  defp terminal_reason(:stale_participant_generation), do: :stale_participant_generation
  defp terminal_reason(:capability_denied), do: :capability_denied
  defp terminal_reason(:invalid_target), do: :invalid_target
  defp terminal_reason(:recording_in_progress), do: :recording_in_progress
  defp terminal_reason(:screen_share_in_use), do: :screen_share_in_use
  defp terminal_reason(:external_operation_failed), do: :external_operation_failed
  defp terminal_reason(_reason), do: :invalid_state

  defp rejection_atom("episode_ended"), do: :episode_ended
  defp rejection_atom("participant_inactive"), do: :participant_inactive
  defp rejection_atom("stale_participant_generation"), do: :stale_participant_generation
  defp rejection_atom("capability_denied"), do: :capability_denied
  defp rejection_atom("invalid_state"), do: :invalid_state
  defp rejection_atom("invalid_target"), do: :invalid_target
  defp rejection_atom("command_id_conflict"), do: :command_id_conflict
  defp rejection_atom("recording_in_progress"), do: :recording_in_progress
  defp rejection_atom("screen_share_in_use"), do: :screen_share_in_use
  defp rejection_atom("external_operation_failed"), do: :external_operation_failed

  defp required_capability(:set_hand_raised),
    do: "raiseHand"

  defp required_capability(:set_display_name), do: "renameSelf"
  defp required_capability(:set_admission_policy), do: "manageAdmission"
  defp required_capability(:assign_roles), do: "assignRoles"

  defp required_capability(name) when name in [:admit_participant, :deny_admission],
    do: "manageAdmission"

  defp required_capability(:mute_participant), do: "muteOthers"
  defp required_capability(:stop_participant_camera), do: "stopVideoOthers"
  defp required_capability(:stop_participant_screen_share), do: "stopScreenOthers"
  defp required_capability(:remove_participant), do: "removeParticipant"

  defp required_capability(name) when name in [:start_recording, :stop_recording],
    do: "manageRecording"

  defp required_capability(:participant_leave), do: "self"
  defp required_capability(:end_episode), do: "endEpisode"

  defp duplicate_result(_command, outcome), do: outcome

  defp receipt_command_name(command), do: Atom.to_string(command.name)

  defp resolve_uncertain(identity, command) do
    case resolve_receipt(identity, command) do
      {:ok, decision} -> {:ok, decision}
      :not_found -> {:retryable, :decision_unavailable}
      {:retryable, _reason} = retryable -> retryable
    end
  end

  defp resolve_uncertain_operation(identity, operation) do
    params =
      episode_params(identity.episode) ++
        [uuid(identity.participant_id), operation.request_key]

    case Postgrex.query(
           Database.connection(identity.episode, 1),
           SQL.select_operation_receipt(),
           params,
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} ->
        connection = Database.connection(identity.episode, 1)
        {:ok, operation_decision_from_receipt(connection, identity, operation, row)}

      {:ok, %{rows: []}} ->
        {:retryable, :decision_unavailable}

      _ ->
        {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp resolve_uncertain_internal_operation(episode, operation) do
    params = episode_params(episode) ++ [Atom.to_string(operation.name), operation.request_key]

    case Postgrex.query(
           Database.connection(episode, 1),
           SQL.select_internal_operation(),
           params,
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} ->
        external = external_operation_from_row(row)

        decision =
          if external.request_fingerprint == operation.fingerprint do
            operation_decision(external, :duplicate)
          else
            %OperationDecision{
              request_key: operation.request_key,
              result: :command_id_conflict,
              reason: :command_id_conflict
            }
          end

        {:ok, decision}

      {:ok, %{rows: []}} ->
        {:retryable, :decision_unavailable}

      _ ->
        {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp resolve_uncertain_finalization(episode, external_operation_id) do
    case read_operation(episode, external_operation_id) do
      {:ok, %{status: status} = external} when status in [:applied, :failed] ->
        {:ok, operation_decision(external, :duplicate)}

      {:ok, %{status: :pending}} ->
        {:retryable, :decision_unavailable}

      :not_found ->
        {:error, :operation_not_found}

      {:retryable, _reason} = retryable ->
        retryable
    end
  end

  defp resolve_uncertain_lifecycle(episode, lifecycle_intent_id) do
    connection = Database.connection(episode, 1)
    params = lifecycle_intent_params(episode, lifecycle_intent_id)

    case Postgrex.query(connection, SQL.read_lifecycle_intent_outcome(), params, timeout: 1_000) do
      {:ok, %{rows: [["applied", nil, event_id, revision]]}} ->
        event_params = [
          uuid(episode.tenant_id),
          uuid(episode.episode_id),
          uuid(lifecycle_intent_id)
        ]

        case Postgrex.query(connection, SQL.read_lifecycle_event(), event_params, timeout: 1_000) do
          {:ok, %{rows: [row]}} ->
            {:ok,
             %LifecycleDecision{
               lifecycle_intent_id: lifecycle_intent_id,
               result: :already_applied,
               event_id: UUID.load!(event_id),
               revision: revision,
               event: event_from_row(row)
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

  defp episode_params(episode),
    do: [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]

  defp participant_params(identity),
    do: episode_params(identity.episode) ++ [uuid(identity.participant_id)]

  defp lifecycle_intent_params(episode, lifecycle_intent_id),
    do: episode_params(episode) ++ [uuid(lifecycle_intent_id)]

  defp receipt_params(identity, command) do
    [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id),
      uuid(identity.participant_id),
      command.id
    ]
  end

  defp checkpoint(point, identity, command) do
    case Application.get_env(:chalk_sync, :stateholder_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: identity.episode.tenant_id,
          episode_id: identity.episode.episode_id,
          command_id: command.id
        })

      _ ->
        :ok
    end
  end

  defp lifecycle_checkpoint(point, episode, lifecycle_intent_id) do
    case Application.get_env(:chalk_sync, :lifecycle_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: episode.tenant_id,
          episode_id: episode.episode_id,
          lifecycle_intent_id: lifecycle_intent_id
        })

      _ ->
        :ok
    end
  end

  defp external_operation_checkpoint(point, episode, external) do
    case Application.get_env(:chalk_sync, :external_operation_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: episode.tenant_id,
          episode_id: episode.episode_id,
          external_operation_id: Map.get(external, :external_operation_id),
          request_key: Map.get(external, :request_key),
          operation: external.name
        })

      _ ->
        :ok
    end
  end

  defp observe_webhook_finalization(
         episode,
         external_operation_id,
         %{result: :applied, delivery: :original}
       ) do
    case read_operation(episode, external_operation_id) do
      {:ok, %{name: name} = operation}
      when name in [
             :remove_participant,
             :participant_leave,
             :end_episode,
             :tenant_end_episode,
             :maximum_duration_expired
           ] ->
        event_name = external_webhook_event_name(name)

        observe_webhook_production(
          episode,
          "sync_external:#{operation.external_operation_id}:#{event_name}",
          "external_operation"
        )

      _ ->
        :ok
    end
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end

  defp observe_webhook_finalization(_episode, _external_operation_id, _decision), do: :ok

  defp observe_lifecycle_webhook(
         episode,
         lifecycle_intent_id,
         %{result: :applied, event: %{name: event_name}}
       )
       when event_name in ["participant_joined", "participant_left", "episode_ended"] do
    webhook_event_name = lifecycle_webhook_event_name(event_name)

    observe_webhook_production(
      episode,
      "sync_lifecycle:#{lifecycle_intent_id}:#{webhook_event_name}",
      "lifecycle_intent"
    )
  end

  defp observe_lifecycle_webhook(_episode, _lifecycle_intent_id, _decision), do: :ok

  defp observe_webhook_production(episode, transition_key, transition) do
    case Postgrex.query(
           Database.connection(episode, 1),
           WebhookSQL.production_summary(),
           [uuid(episode.tenant_id), transition_key],
           timeout: 1_000
         ) do
      {:ok, %{rows: rows}} ->
        Enum.each(rows, &emit_webhook_observation(&1, transition))

      _ ->
        :ok
    end
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end

  defp emit_webhook_observation(
         [event_name, api_version, journey_id, trace_id, span_id, delivery_count],
         transition
       ) do
    context = Observability.persisted_context(UUID.load!(journey_id), trace_id, span_id)

    attributes = %{
      api_version: api_version,
      event_name: event_name,
      producer: "sync",
      transition: transition
    }

    Observability.linked_phase(context, "sync.webhook.production.committed", attributes)

    Observability.linked_phase(context, "sync.webhook.fanout.queued", %{
      api_version: api_version,
      delivery_count: delivery_count,
      event_name: event_name,
      producer: "sync",
      transition: transition
    })

    Telemetry.execute(
      [:webhook, :production],
      %{count: 1},
      %{api_version: api_version, event_name: event_name, outcome: :committed}
    )

    Telemetry.execute(
      [:webhook, :fanout],
      %{count: delivery_count},
      %{api_version: api_version, event_name: event_name, outcome: :queued}
    )
  end

  defp external_webhook_event_name(name)
       when name in [:remove_participant, :participant_leave],
       do: "participant.left"

  defp external_webhook_event_name(name)
       when name in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: "episode.ended"

  defp lifecycle_webhook_event_name("participant_joined"), do: "participant.joined"
  defp lifecycle_webhook_event_name("participant_left"), do: "participant.left"
  defp lifecycle_webhook_event_name("episode_ended"), do: "episode.ended"

  defp uuid(value), do: UUID.dump!(value)
  defp nullable_dump(nil), do: nil
  defp nullable_dump(value), do: uuid(value)
  defp nullable_uuid(nil), do: nil
  defp nullable_uuid(value), do: UUID.load!(value)
end
