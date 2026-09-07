defmodule ChalkSync.Stateholder.Postgres.ExternalOperationDecision do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationClaims
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims, as: ClaimsSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationDecision, as: SQL
  alias ChalkSync.UUID

  def from_receipt(
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

  def from_receipt(
        connection,
        identity,
        _operation,
        [_fingerprint, "pending", nil, nil, nil, nil, external_operation_id]
      ) do
    params = Scope.episode(identity.episode) ++ [external_operation_id]

    case Postgrex.query!(connection, ClaimsSQL.read_operation(), params).rows do
      [row] -> build(ExternalOperationRecord.from_row(row), :duplicate)
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def from_receipt(
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

  def from_receipt(
        _connection,
        _identity,
        operation,
        [_fingerprint, "rejected", reason, nil, nil, nil, external_operation_id]
      ) do
    %OperationDecision{
      request_key: operation.request_key,
      result: :failed,
      delivery: :duplicate,
      external_operation_id: Scope.nullable_uuid(external_operation_id),
      reason: CommandDecision.rejection_atom(reason)
    }
  end

  def build(operation, delivery, state \\ nil, event_id \\ nil, revision \\ nil) do
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

  def resolve_uncertain_operation(identity, operation) do
    params =
      Scope.episode(identity.episode) ++
        [Scope.uuid(identity.participant_id), operation.request_key]

    case Postgrex.query(
           Database.connection(identity.episode, 1),
           SQL.select_operation_receipt(),
           params,
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} ->
        connection = Database.connection(identity.episode, 1)
        {:ok, from_receipt(connection, identity, operation, row)}

      {:ok, %{rows: []}} ->
        {:retryable, :decision_unavailable}

      _ ->
        {:retryable, :decision_unavailable}
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  def resolve_uncertain_internal_operation(episode, operation) do
    params = Scope.episode(episode) ++ [Atom.to_string(operation.name), operation.request_key]

    case Postgrex.query(
           Database.connection(episode, 1),
           SQL.select_internal_operation(),
           params,
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} ->
        external = ExternalOperationRecord.from_row(row)

        decision =
          if external.request_fingerprint == operation.fingerprint do
            build(external, :duplicate)
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

  def resolve_uncertain_finalization(episode, external_operation_id) do
    case ExternalOperationClaims.read_operation(episode, external_operation_id) do
      {:ok, %{status: status} = external} when status in [:applied, :failed] ->
        {:ok, build(external, :duplicate)}

      {:ok, %{status: :pending}} ->
        {:retryable, :decision_unavailable}

      :not_found ->
        {:error, :operation_not_found}

      {:retryable, _reason} = retryable ->
        retryable
    end
  end
end
