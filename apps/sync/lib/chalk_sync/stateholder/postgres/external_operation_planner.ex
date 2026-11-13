defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner do
  @moduledoc false

  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Persist
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Prepare
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationDecision, as: DecisionSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction

  @max_pending_operations 2_048

  def accept_transaction(connection, identity, operation) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)

    case fetch_operation_receipt(connection, identity, operation) do
      {:ok, row} ->
        ExternalOperationDecision.from_receipt(connection, identity, operation, row)

      :not_found ->
        participant =
          Authority.lock_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        with :ok <- Authority.validate_operation_actor(identity, operation, policy, participant),
             :ok <- JoinSeats.validate_leave(connection, identity, operation),
             {:ok, state} <- Control.validate_fold(identity.episode, control, policy),
             {:ok, context} <- Prepare.prepare_operation(connection, identity, operation, policy, state),
             :ok <- ensure_operation_capacity(connection, identity.episode) do
          Persist.persist_operation_acceptance(connection, identity, operation, policy, state, context)
        else
          {:error, :overloaded} ->
            Postgrex.rollback(connection, {:retryable, :overloaded})

          {:error, reason} ->
            Persist.persist_operation_rejection(
              connection,
              identity,
              operation,
              CommandDecision.terminal_reason(reason)
            )
        end
    end
  end

  def accept_internal_transaction(connection, episode, operation) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, episode)
    policy = Authority.lock_episode(connection, episode)

    case fetch_internal_operation(connection, episode, operation) do
      {:ok, existing} when existing.request_fingerprint != operation.fingerprint ->
        %OperationDecision{
          request_key: operation.request_key,
          result: :command_id_conflict,
          reason: :command_id_conflict
        }

      {:ok, existing} ->
        ExternalOperationDecision.build(existing, :duplicate)

      :not_found ->
        result =
          with {:ok, state} <- Control.validate_fold(episode, control, policy) do
            persist_new_internal_operation(connection, episode, operation, policy, state)
          end

        case result do
          %OperationDecision{} = decision ->
            decision

          {:error, :overloaded} ->
            Postgrex.rollback(connection, {:retryable, :overloaded})

          {:error, :recording_policy_disabled} ->
            %OperationDecision{
              request_key: operation.request_key,
              result: :terminal,
              reason: :recording_policy_disabled
            }

          {:error, reason} ->
            Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp fetch_operation_receipt(connection, identity, operation) do
    params =
      Scope.episode(identity.episode) ++
        [Scope.uuid(identity.participant_id), operation.request_key]

    case Postgrex.query!(connection, DecisionSQL.select_operation_receipt(), params).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  def fetch_internal_operation(connection, episode, operation) do
    params =
      Scope.episode(episode) ++ [Atom.to_string(operation.name), operation.request_key]

    case Postgrex.query!(connection, DecisionSQL.select_internal_operation(), params).rows do
      [row] -> {:ok, ExternalOperationRecord.from_row(row)}
      [] -> :not_found
    end
  end

  defp ensure_operation_capacity(connection, episode) do
    case Postgrex.query!(connection, SQL.count_pending_operations(), Scope.episode(episode)).rows do
      [[count]] when count < @max_pending_operations -> :ok
      _ -> {:error, :overloaded}
    end
  end

  def persist_new_internal_operation(connection, episode, operation, policy, state) do
    with :ok <- Prepare.validate_internal_operation(operation),
         {:ok, context} <-
           Prepare.prepare_internal_operation(connection, episode, operation, policy, state),
         :ok <- ensure_operation_capacity(connection, episode) do
      Persist.persist_internal_operation_acceptance(
        connection,
        episode,
        operation,
        policy,
        state,
        context
      )
    end
  end
end
