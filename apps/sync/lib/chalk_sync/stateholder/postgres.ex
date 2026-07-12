defmodule ChalkSync.Stateholder.Postgres do
  @moduledoc """
  PostgreSQL authority for atomic control decisions and recovery reads.

  Every command locks the Session control row, resolves its receipt first,
  validates locked product facts, and commits the event, folded state, revision,
  and receipt together. Notification payloads are disposable head hints.
  """

  @behaviour ChalkSync.Stateholder

  require Logger

  alias ChalkSync.CanonicalJSON
  alias ChalkSync.Database
  alias ChalkSync.ProtocolV2
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Postgres.SQL
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  @transaction_timeout_ms 3_000
  @max_event_bytes 32 * 1024
  @max_replay_events 2_048
  @max_replay_bytes 2 * 1024 * 1024
  @schema_version 1

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
    connection = Database.connection(identity.session, 1)
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
  def apply_lifecycle_intent(%SessionKey{} = session, lifecycle_intent_id)
      when is_binary(lifecycle_intent_id) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case run_lifecycle_transaction(session, lifecycle_intent_id) do
          {:ok, %LifecycleDecision{} = decision} ->
            lifecycle_checkpoint(:after_commit_before_reply, session, lifecycle_intent_id)
            {:ok, decision}

          {:error, {:retryable, reason}} ->
            {:retryable, reason}

          {:error, {:error, reason}} ->
            {:error, reason}

          {:error, _reason} ->
            resolve_uncertain_lifecycle(session, lifecycle_intent_id)
        end

      :error ->
        {:error, :invalid_lifecycle_intent_id}
    end
  rescue
    exception ->
      Logger.error("sync lifecycle transaction became uncertain: #{Exception.message(exception)}")

      resolve_uncertain_lifecycle(session, lifecycle_intent_id)
  catch
    :exit, reason ->
      Logger.error("sync lifecycle transaction exited before resolution: #{inspect(reason)}")
      resolve_uncertain_lifecycle(session, lifecycle_intent_id)
  end

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(%SessionKey{} = session, lifecycle_intent_id, reason)
      when is_binary(lifecycle_intent_id) and is_atom(reason) do
    case UUID.dump(lifecycle_intent_id) do
      {:ok, _uuid} ->
        case Postgrex.query(
               Database.connection(session),
               SQL.record_lifecycle_failure(),
               lifecycle_intent_params(session, lifecycle_intent_id) ++ [Atom.to_string(reason)],
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
    session = %SessionKey{
      tenant_id: "background",
      room_id: "background",
      session_id: "background"
    }

    case Postgrex.query(
           Database.connection(session),
           SQL.discover_pending_lifecycle_intents(),
           [limit],
           timeout: 2_000
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn [tenant_id, room_id, session_id, intent_id] ->
           {%SessionKey{
              tenant_id: UUID.load!(tenant_id),
              room_id: UUID.load!(room_id),
              session_id: UUID.load!(session_id)
            }, UUID.load!(intent_id)}
         end)}

      {:error, _reason} ->
        {:retryable, :dependency_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor) do
    connection = Database.connection(identity.session)

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
  def recover(%SessionKey{} = session, cursor) do
    connection = Database.connection(session)

    case Postgrex.transaction(
           connection,
           &recovery_transaction(&1, session, cursor),
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
  def recover_session(%SessionKey{} = session, cursor), do: recover(session, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%SessionKey{} = session, after_revision, through_revision) do
    params = [
      uuid(session.tenant_id),
      uuid(session.session_id),
      after_revision,
      through_revision
    ]

    case Postgrex.query(
           Database.connection(session),
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
      Database.connection(identity.session),
      &decision_transaction(&1, identity, command),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync command"
    )
  end

  defp run_lifecycle_transaction(session, lifecycle_intent_id) do
    Postgrex.transaction(
      Database.connection(session),
      &lifecycle_transaction(&1, session, lifecycle_intent_id),
      timeout: @transaction_timeout_ms,
      commit_comment: "chalk sync lifecycle intent"
    )
  end

  defp lifecycle_transaction(connection, session, lifecycle_intent_id) do
    configure_transaction(connection)
    control = lock_lifecycle_control(connection, session)
    intent = lock_lifecycle_intent(connection, session, lifecycle_intent_id)

    case intent.status do
      "applied" -> lifecycle_decision(connection, session, lifecycle_intent_id, intent)
      "superseded" -> superseded_lifecycle_decision(lifecycle_intent_id, intent)
      "pending" -> apply_pending_lifecycle(connection, session, control, intent)
    end
  end

  defp lock_lifecycle_control(connection, session) do
    case Postgrex.query!(connection, SQL.lock_control(), session_params(session)).rows do
      [row] -> control_row(row)
      [] -> Postgrex.rollback(connection, {:error, :session_not_found})
    end
  end

  defp lock_lifecycle_intent(connection, session, lifecycle_intent_id) do
    params = lifecycle_intent_params(session, lifecycle_intent_id)

    case Postgrex.query!(connection, SQL.lock_lifecycle_intent(), params).rows do
      [[status, name, participant_id, generation, payload, reason, event_id, revision]] ->
        %{
          id: lifecycle_intent_id,
          status: status,
          name: name,
          participant_session_id: nullable_uuid(participant_id),
          participant_session_generation: generation,
          payload: payload,
          terminal_reason: reason,
          applied_event_id: nullable_uuid(event_id),
          applied_revision: revision
        }

      [] ->
        Postgrex.rollback(connection, {:error, :lifecycle_intent_not_found})
    end
  end

  defp apply_pending_lifecycle(connection, session, control, intent) do
    session_status = lock_lifecycle_session_status(connection, session)
    participant = lock_lifecycle_participant(connection, session, intent)

    with :ok <- validate_lifecycle_product_state(intent, session_status, participant),
         {:ok, state} <- validate_fold(session, control),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, lifecycle_name(intent.name), intent.payload) do
      persist_lifecycle_commit(connection, session, intent, event, next_state)
    else
      {:error, reason} ->
        Postgrex.rollback(connection, {:error, normalize_lifecycle_error(reason)})
    end
  end

  defp lock_lifecycle_session_status(connection, session) do
    case Postgrex.query!(connection, SQL.lock_session(), session_params(session)).rows do
      [[status]] -> status
      [] -> Postgrex.rollback(connection, {:error, :session_not_found})
    end
  end

  defp lock_lifecycle_participant(_connection, _session, %{name: "session_ended"}), do: nil

  defp lock_lifecycle_participant(connection, session, intent) do
    params = session_params(session) ++ [uuid(intent.participant_session_id)]

    case Postgrex.query!(connection, SQL.lock_participant(), params).rows do
      [[generation, status, _capabilities]] -> %{generation: generation, status: status}
      [] -> Postgrex.rollback(connection, {:error, :participant_not_found})
    end
  end

  defp validate_lifecycle_product_state(
         %{name: "participant_joined"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_session_generation ->
        {:error, :stale_participant_generation}

      participant.status != "joining" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_product_state(
         %{name: "participant_left"} = intent,
         "active",
         participant
       ) do
    cond do
      participant.generation != intent.participant_session_generation ->
        {:error, :stale_participant_generation}

      participant.status != "leaving" ->
        {:error, :invalid_lifecycle_transition}

      true ->
        :ok
    end
  end

  defp validate_lifecycle_product_state(%{name: "session_ended"}, "ending", nil), do: :ok

  defp validate_lifecycle_product_state(%{name: name}, status, _participant)
       when name in ["participant_joined", "participant_left"] and status in ["ending", "ended"],
       do: {:error, :session_ending}

  defp validate_lifecycle_product_state(_intent, _status, _participant),
    do: {:error, :invalid_lifecycle_transition}

  defp persist_lifecycle_commit(connection, session, intent, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)

    stored_event =
      event
      |> Map.put(:event_id, event_id)
      |> Map.put(:command_id, nil)
      |> Map.put(:lifecycle_intent_id, intent.id)
      |> Map.put(:schema_version, @schema_version)
      |> Map.put(:resulting_state_digest, digest)

    event_bytes = stored_event |> ProtocolV2.event() |> byte_size()

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_lifecycle_event(connection, session, stored_event, event_bytes)
    lifecycle_checkpoint(:after_event_insert, session, intent.id)
    update_lifecycle_control(connection, session, intent.name, state, event_bytes)
    update_lifecycle_product(connection, session, intent, event)
    mark_lifecycle_applied(connection, session, intent.id, event_id, event.revision)
    lifecycle_checkpoint(:after_intent_applied, session, intent.id)
    notify_head(connection, session, event.revision)

    %LifecycleDecision{
      lifecycle_intent_id: intent.id,
      result: :applied,
      event_id: event_id,
      revision: event.revision,
      event: stored_event
    }
  end

  defp insert_lifecycle_event(connection, session, event, event_bytes) do
    Postgrex.query!(connection, SQL.insert_lifecycle_event(), [
      uuid(session.tenant_id),
      uuid(session.room_id),
      uuid(session.session_id),
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

  defp update_lifecycle_control(connection, session, name, state, event_bytes) do
    params = [
      uuid(session.tenant_id),
      uuid(session.room_id),
      uuid(session.session_id),
      state.revision,
      Reducer.snapshot(state),
      Reducer.state_schema_version(),
      Reducer.digest(state),
      Reducer.snapshot_bytes(state),
      event_bytes
    ]

    query =
      case name do
        "participant_joined" -> SQL.update_join_control()
        "participant_left" -> SQL.update_leave_control()
        "session_ended" -> SQL.update_end_control()
      end

    case Postgrex.query!(connection, query, params).rows do
      [[revision]] when revision == state.revision -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp update_lifecycle_product(
         connection,
         session,
         %{name: "participant_joined"} = intent,
         _event
       ) do
    params =
      session_params(session) ++
        [uuid(intent.participant_session_id), intent.participant_session_generation]

    case Postgrex.query!(connection, SQL.activate_lifecycle_participant(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp update_lifecycle_product(connection, session, %{name: "participant_left"} = intent, _event) do
    params =
      session_params(session) ++
        [uuid(intent.participant_session_id), intent.participant_session_generation]

    case Postgrex.query!(connection, SQL.complete_lifecycle_participant(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp update_lifecycle_product(connection, session, %{name: "session_ended"} = intent, _event) do
    Postgrex.query!(
      connection,
      SQL.supersede_pending_lifecycle_intents(),
      session_params(session) ++ [uuid(intent.id)]
    )

    Postgrex.query!(connection, SQL.complete_all_session_participants(), session_params(session))

    case Postgrex.query!(connection, SQL.complete_lifecycle_session(), session_params(session)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp mark_lifecycle_applied(connection, session, intent_id, event_id, revision) do
    params = lifecycle_intent_params(session, intent_id) ++ [uuid(event_id), revision]

    case Postgrex.query!(connection, SQL.mark_lifecycle_intent_applied(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_lifecycle_transition})
    end
  end

  defp lifecycle_decision(connection, session, lifecycle_intent_id, intent) do
    params = [uuid(session.tenant_id), uuid(session.session_id), uuid(lifecycle_intent_id)]

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

  defp lifecycle_name("participant_joined"), do: :participant_joined
  defp lifecycle_name("participant_left"), do: :participant_left
  defp lifecycle_name("session_ended"), do: :session_ended

  defp normalize_lifecycle_error(:revision_gap), do: :invalid_state
  defp normalize_lifecycle_error(:invalid_payload), do: :invalid_lifecycle_intent
  defp normalize_lifecycle_error(:unknown_event), do: :invalid_lifecycle_intent
  defp normalize_lifecycle_error(reason), do: reason

  defp lifecycle_terminal_reason("superseded_by_session_end"),
    do: :superseded_by_session_end

  defp lifecycle_terminal_reason("participant_already_terminal"),
    do: :participant_already_terminal

  defp lifecycle_terminal_reason("participant_generation_replaced"),
    do: :participant_generation_replaced

  defp decision_transaction(connection, identity, command) do
    configure_transaction(connection)
    checkpoint(:after_transaction_begin, identity, command)
    {control, session_status, participant} = lock_authority(connection, identity)
    checkpoint(:after_authority_lock, identity, command)

    receipt = fetch_receipt(connection, identity, command)
    checkpoint(:after_receipt_lookup, identity, command)

    decision =
      case receipt do
        {:ok, row} ->
          decision_from_receipt(command, row)

        :not_found ->
          decide_new(connection, identity, command, control, session_status, participant)
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
    session_params = session_params(identity.session)

    control =
      case Postgrex.query!(connection, SQL.lock_control(), session_params).rows do
        [row] -> control_row(row)
        [] -> Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    session_status =
      case Postgrex.query!(connection, SQL.lock_session(), session_params).rows do
        [[status]] -> status
        [] -> Postgrex.rollback(connection, {:retryable, :dependency_unavailable})
      end

    participant =
      case Postgrex.query!(connection, SQL.lock_participant(), participant_params(identity)).rows do
        [[generation, status, capabilities]] ->
          %{generation: generation, status: status, capabilities: capabilities}

        [] ->
          nil
      end

    {control, session_status, participant}
  end

  defp fetch_receipt(connection, identity, command) do
    case Postgrex.query!(connection, SQL.select_receipt(), receipt_params(identity, command)).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  defp decide_new(connection, identity, command, control, session_status, participant) do
    with :ok <- validate_product_state(identity, command, session_status, participant),
         {:ok, state} <- validate_fold(identity.session, control),
         {:ok, event, next_state} <-
           Reducer.decide_command(
             state,
             identity.participant_session_id,
             command.name,
             command.payload
           ) do
      persist_commit(connection, identity, command, event, next_state)
    else
      {:error, reason} ->
        persist_rejection(connection, identity, command, terminal_reason(reason))
    end
  end

  defp validate_product_state(_identity, _command, session_status, _participant)
       when session_status != "active",
       do: {:error, :session_ended}

  defp validate_product_state(_identity, _command, _session_status, nil),
    do: {:error, :participant_inactive}

  defp validate_product_state(identity, _command, _session_status, participant)
       when participant.generation != identity.participant_session_generation,
       do: {:error, :stale_participant_generation}

  defp validate_product_state(_identity, _command, _session_status, participant)
       when participant.status != "active",
       do: {:error, :participant_inactive}

  defp validate_product_state(_identity, command, _session_status, participant)
       when command.name in [:raise_hand, :lower_hand] do
    if "control:hand" in participant.capabilities,
      do: :ok,
      else: {:error, :capability_denied}
  end

  defp validate_fold(session, control) do
    with @schema_version <- control.state_schema_version,
         {:ok, state} <- Reducer.from_snapshot(session.session_id, control.folded_state),
         true <- state.revision == control.revision,
         true <- Reducer.digest(state) == control.digest do
      {:ok, state}
    else
      _ -> {:error, :invalid_state}
    end
  end

  defp persist_rejection(connection, identity, command, reason) do
    receipt_bytes = receipt_bytes(command, :rejected, reason, nil, nil)

    Postgrex.query!(connection, SQL.insert_rejected_receipt(), [
      uuid(identity.session.tenant_id),
      uuid(identity.session.session_id),
      uuid(identity.participant_session_id),
      identity.participant_session_generation,
      command.id,
      command.fingerprint,
      Atom.to_string(command.name),
      Atom.to_string(reason)
    ])

    case Postgrex.query!(connection, SQL.increment_rejected_receipt_capacity(), [
           uuid(identity.session.tenant_id),
           uuid(identity.session.room_id),
           uuid(identity.session.session_id),
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
    event_bytes = stored_event |> ProtocolV2.event() |> byte_size()
    receipt_bytes = receipt_bytes(command, :committed, nil, event_id, event.revision)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_event(connection, identity, command, stored_event, event_bytes)
    checkpoint(:after_event_insert, identity, command)
    update_control(connection, identity, state, event_bytes, receipt_bytes)
    checkpoint(:after_control_update, identity, command)
    insert_committed_receipt(connection, identity, command, event_id, event.revision)
    checkpoint(:after_receipt_insert, identity, command)
    notify_head(connection, identity.session, event.revision)

    %Decision{
      command_id: command.id,
      result: :committed,
      event_id: event_id,
      revision: event.revision,
      event: stored_event
    }
  end

  defp insert_event(connection, identity, command, event, event_bytes) do
    Postgrex.query!(connection, SQL.insert_event(), [
      uuid(identity.session.tenant_id),
      uuid(identity.session.room_id),
      uuid(identity.session.session_id),
      uuid(event.event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      uuid(identity.participant_session_id),
      identity.participant_session_generation,
      command.id,
      event.schema_version,
      event.resulting_state_digest,
      event_bytes
    ])
  end

  defp update_control(connection, identity, state, event_bytes, receipt_bytes) do
    params = [
      uuid(identity.session.tenant_id),
      uuid(identity.session.room_id),
      uuid(identity.session.session_id),
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

  defp insert_committed_receipt(connection, identity, command, event_id, revision) do
    Postgrex.query!(connection, SQL.insert_committed_receipt(), [
      uuid(identity.session.tenant_id),
      uuid(identity.session.session_id),
      uuid(identity.participant_session_id),
      identity.participant_session_generation,
      command.id,
      command.fingerprint,
      Atom.to_string(command.name),
      uuid(event_id),
      revision
    ])
  end

  defp notify_head(connection, session, revision) do
    payload =
      "#{session.tenant_id}:#{session.room_id}:#{session.session_id}:#{revision}"

    Postgrex.query!(connection, SQL.notify_head(), [payload])
  end

  defp recovery_transaction(connection, %Identity{} = identity, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])

    with {:ok, control} <- read_control(connection, session_params(identity.session)),
         {:ok, status} <- read_session_status(connection, session_params(identity.session)),
         {:ok, state} <- validate_fold(identity.session, control) do
      case validate_recovery_identity(connection, identity, status) do
        :ok -> build_recovery(connection, identity.session, state, status, cursor)
        {:terminal, reason} -> terminal_recovery(state, reason)
        {:error, reason} -> {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp recovery_transaction(connection, %SessionKey{} = session, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])
    params = session_params(session)

    with {:ok, control} <- read_control(connection, params),
         {:ok, status} <- read_session_status(connection, params),
         {:ok, state} <- validate_fold(session, control) do
      build_recovery(connection, session, state, status, cursor)
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_recovery_identity(_connection, _identity, status) when status != "active",
    do: {:terminal, :session_ended}

  defp validate_recovery_identity(connection, identity, _status) do
    case Postgrex.query!(connection, SQL.read_participant_status(), participant_params(identity)).rows do
      [[generation, _status]] when generation != identity.participant_session_generation ->
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
      [[revision, folded_state, schema, digest, _room_id]] ->
        {:ok,
         %{
           revision: revision,
           folded_state: folded_state,
           state_schema_version: schema,
           digest: digest
         }}

      [] ->
        {:error, :session_not_found}
    end
  end

  defp read_session_status(connection, params) do
    case Postgrex.query!(connection, SQL.read_session_status(), params).rows do
      [[status]] -> {:ok, status}
      [] -> {:error, :session_not_found}
    end
  end

  defp build_recovery(_connection, _session, state, status, nil),
    do: snapshot_recovery(state, status)

  defp build_recovery(connection, session, state, status, cursor) when is_map(cursor) do
    head = recovery_head(state)

    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: recovery_mode(status, :up_to_date), head: head, snapshot: nil, events: []}

      valid_replay_cursor?(connection, session, cursor, head) ->
        replay_recovery(connection, session, state, status, cursor.revision, head.revision)

      true ->
        snapshot_recovery(state, status)
    end
  end

  defp build_recovery(_connection, _session, state, status, _cursor),
    do: snapshot_recovery(state, status)

  defp valid_replay_cursor?(connection, session, cursor, head) do
    valid_shape =
      is_integer(cursor.revision) and cursor.revision >= 0 and cursor.revision < head.revision and
        cursor.state_schema_version == @schema_version and is_binary(cursor.digest)

    valid_shape and cursor_digest(connection, session, cursor.revision) == cursor.digest
  end

  defp cursor_digest(_connection, session, 0),
    do: session.session_id |> Reducer.new() |> Reducer.digest()

  defp cursor_digest(connection, session, revision) do
    params = [uuid(session.tenant_id), uuid(session.session_id), revision]

    case Postgrex.query!(connection, SQL.read_cursor_digest(), params).rows do
      [[digest]] -> digest
      [] -> nil
    end
  end

  defp replay_recovery(connection, session, state, status, revision, head_revision) do
    params = [uuid(session.tenant_id), uuid(session.session_id), revision, head_revision]

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
      snapshot_recovery(state, status)
    end
  end

  defp snapshot_recovery(state, status) do
    %Recovery{
      mode: recovery_mode(status, :snapshot),
      head: recovery_head(state),
      snapshot: Reducer.snapshot(state),
      events: [],
      terminal_reason: if(status == "ended", do: :session_ended)
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
      actor_participant_session_id: nullable_uuid(actor_id),
      command_id: command_id,
      lifecycle_intent_id: nullable_uuid(lifecycle_intent_id),
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

  defp decision_from_receipt(command, [fingerprint, _outcome, _reason, _event, _revision])
       when fingerprint != command.fingerprint do
    %Decision{
      command_id: command.id,
      result: :command_id_conflict,
      reason: :command_id_conflict
    }
  end

  defp decision_from_receipt(command, [_fingerprint, "committed", nil, event_id, revision]) do
    %Decision{
      command_id: command.id,
      result: :duplicate,
      event_id: UUID.load!(event_id),
      revision: revision
    }
  end

  defp decision_from_receipt(command, [_fingerprint, "rejected", reason, nil, nil]) do
    %Decision{command_id: command.id, result: :rejected, reason: rejection_atom(reason)}
  end

  defp stored_event(event, event_id, command_id, digest) do
    event
    |> Map.put(:event_id, event_id)
    |> Map.put(:command_id, command_id)
    |> Map.put(:lifecycle_intent_id, nil)
    |> Map.put(:schema_version, @schema_version)
    |> Map.put(:resulting_state_digest, digest)
  end

  defp receipt_bytes(command, outcome, reason, event_id, revision) do
    CanonicalJSON.encode!(%{
      "command_id" => command.id,
      "command_name" => Atom.to_string(command.name),
      "outcome" => Atom.to_string(outcome),
      "rejection_reason" => reason && Atom.to_string(reason),
      "event_id" => event_id,
      "resulting_revision" => revision,
      "request_fingerprint" => Base.url_encode64(command.fingerprint, padding: false)
    })
    |> byte_size()
  end

  defp terminal_reason(:session_ended), do: :session_ended
  defp terminal_reason(:participant_inactive), do: :participant_inactive
  defp terminal_reason(:stale_participant_generation), do: :stale_participant_generation
  defp terminal_reason(:capability_denied), do: :capability_denied
  defp terminal_reason(_reason), do: :invalid_state

  defp rejection_atom("session_ended"), do: :session_ended
  defp rejection_atom("participant_inactive"), do: :participant_inactive
  defp rejection_atom("stale_participant_generation"), do: :stale_participant_generation
  defp rejection_atom("capability_denied"), do: :capability_denied
  defp rejection_atom("invalid_state"), do: :invalid_state
  defp rejection_atom("command_id_conflict"), do: :command_id_conflict

  defp resolve_uncertain(identity, command) do
    case resolve_receipt(identity, command) do
      {:ok, decision} -> {:ok, decision}
      :not_found -> {:retryable, :decision_unavailable}
      {:retryable, _reason} = retryable -> retryable
    end
  end

  defp resolve_uncertain_lifecycle(session, lifecycle_intent_id) do
    connection = Database.connection(session, 1)
    params = lifecycle_intent_params(session, lifecycle_intent_id)

    case Postgrex.query(connection, SQL.read_lifecycle_intent_outcome(), params, timeout: 1_000) do
      {:ok, %{rows: [["applied", nil, event_id, revision]]}} ->
        event_params = [
          uuid(session.tenant_id),
          uuid(session.session_id),
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

  defp session_params(session),
    do: [uuid(session.tenant_id), uuid(session.room_id), uuid(session.session_id)]

  defp participant_params(identity),
    do: session_params(identity.session) ++ [uuid(identity.participant_session_id)]

  defp lifecycle_intent_params(session, lifecycle_intent_id),
    do: session_params(session) ++ [uuid(lifecycle_intent_id)]

  defp receipt_params(identity, command) do
    [
      uuid(identity.session.tenant_id),
      uuid(identity.session.room_id),
      uuid(identity.session.session_id),
      uuid(identity.participant_session_id),
      command.id
    ]
  end

  defp checkpoint(point, identity, command) do
    case Application.get_env(:chalk_sync, :stateholder_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: identity.session.tenant_id,
          session_id: identity.session.session_id,
          command_id: command.id
        })

      _ ->
        :ok
    end
  end

  defp lifecycle_checkpoint(point, session, lifecycle_intent_id) do
    case Application.get_env(:chalk_sync, :lifecycle_fault_hook) do
      hook when is_function(hook, 2) ->
        hook.(point, %{
          tenant_id: session.tenant_id,
          session_id: session.session_id,
          lifecycle_intent_id: lifecycle_intent_id
        })

      _ ->
        :ok
    end
  end

  defp uuid(value), do: UUID.dump!(value)
  defp nullable_uuid(nil), do: nil
  defp nullable_uuid(value), do: UUID.load!(value)
end
