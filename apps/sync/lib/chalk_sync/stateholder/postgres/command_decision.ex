defmodule ChalkSync.Stateholder.Postgres.CommandDecision do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.CommandPersistence
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Command, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  def resolve_receipt(%Identity{} = identity, %Command{} = command) do
    connection = Database.connection(identity.episode, 1)
    params = Scope.receipt(identity, command)

    case Postgrex.query(connection, SQL.select_receipt(), params, timeout: 1_000) do
      {:ok, %{rows: [row]}} -> {:ok, from_receipt(command, row)}
      {:ok, %{rows: []}} -> :not_found
      {:error, _error} -> {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  def transaction(connection, identity, command) do
    Transaction.configure(connection)
    FaultHooks.command(:after_transaction_begin, identity, command)
    {control, episode_status, participant} = Authority.lock_command(connection, identity)
    FaultHooks.command(:after_authority_lock, identity, command)

    receipt = Authority.fetch_command_receipt(connection, identity, command)
    FaultHooks.command(:after_receipt_lookup, identity, command)

    decision =
      case receipt do
        {:ok, row} ->
          from_receipt(command, row)

        :not_found ->
          decide_new(connection, identity, command, control, episode_status, participant)
      end

    FaultHooks.command(:before_commit, identity, command)
    decision
  end

  defp decide_new(connection, identity, command, control, episode_policy, participant) do
    with {:ok, state} <-
           Authority.validate_command(identity, command, control, episode_policy, participant),
         decision <-
           Reducer.decide_command(
             state,
             identity.participant_id,
             command.name,
             command.payload
           ) do
      case decision do
        {:change, event, next_state} ->
          CommandPersistence.commit(connection, identity, command, event, next_state)

        {:satisfied, unchanged_state} ->
          CommandPersistence.satisfy(connection, identity, command, unchanged_state)

        {:error, reason} ->
          CommandPersistence.reject(connection, identity, command, terminal_reason(reason))
      end
    else
      {:error, reason} ->
        CommandPersistence.reject(connection, identity, command, terminal_reason(reason))
    end
  end

  def from_receipt(
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

  def from_receipt(
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

  def from_receipt(
        command,
        [_fingerprint, "committed", nil, event_id, revision, digest, operation_id]
      ) do
    %Decision{
      command_id: command.id,
      result: duplicate_result(command, :committed),
      delivery: :duplicate,
      event_id: UUID.load!(event_id),
      external_operation_id: Scope.nullable_uuid(operation_id),
      revision: revision,
      state_digest: digest
    }
  end

  def from_receipt(
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

  def from_receipt(
        command,
        [_fingerprint, "rejected", reason, event_id, revision, digest, operation_id]
      ) do
    %Decision{
      command_id: command.id,
      result: :rejected,
      reason: rejection_atom(reason),
      delivery: :duplicate,
      event_id: Scope.nullable_uuid(event_id),
      external_operation_id: Scope.nullable_uuid(operation_id),
      revision: revision,
      state_digest: digest
    }
  end

  def terminal_reason(:episode_ended), do: :episode_ended
  def terminal_reason(:participant_inactive), do: :participant_inactive
  def terminal_reason(:stale_participant_generation), do: :stale_participant_generation
  def terminal_reason(:capability_denied), do: :capability_denied
  def terminal_reason(:invalid_target), do: :invalid_target
  def terminal_reason(:recording_in_progress), do: :recording_in_progress
  def terminal_reason(:screen_share_in_use), do: :screen_share_in_use
  def terminal_reason(:external_operation_failed), do: :external_operation_failed
  def terminal_reason(_reason), do: :invalid_state

  def rejection_atom("episode_ended"), do: :episode_ended
  def rejection_atom("participant_inactive"), do: :participant_inactive
  def rejection_atom("stale_participant_generation"), do: :stale_participant_generation
  def rejection_atom("capability_denied"), do: :capability_denied
  def rejection_atom("invalid_state"), do: :invalid_state
  def rejection_atom("invalid_target"), do: :invalid_target
  def rejection_atom("command_id_conflict"), do: :command_id_conflict
  def rejection_atom("recording_in_progress"), do: :recording_in_progress
  def rejection_atom("screen_share_in_use"), do: :screen_share_in_use
  def rejection_atom("external_operation_failed"), do: :external_operation_failed

  defp duplicate_result(_command, outcome), do: outcome

  def resolve_uncertain(identity, command) do
    case resolve_receipt(identity, command) do
      {:ok, decision} -> {:ok, decision}
      :not_found -> {:retryable, :decision_unavailable}
      {:retryable, _reason} = retryable -> retryable
    end
  end
end
