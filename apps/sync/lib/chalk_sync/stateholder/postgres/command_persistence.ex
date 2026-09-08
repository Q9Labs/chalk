defmodule ChalkSync.Stateholder.Postgres.CommandPersistence do
  @moduledoc false

  alias ChalkSync.CanonicalJSON
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Command, as: SQL
  alias ChalkSync.UUID

  @max_event_bytes 32 * 1024

  def append_control_change(
        connection,
        identity,
        command,
        event,
        state,
        event_bytes,
        receipt_bytes
      ) do
    insert_event(connection, identity, command, event, event_bytes)
    update_command_product(connection, identity, event)
    update_control(connection, identity, state, event_bytes, receipt_bytes)
  end

  def reject(connection, identity, command, reason) do
    receipt_bytes = receipt_bytes(command, :rejected, reason, nil, nil)

    Postgrex.query!(connection, SQL.insert_rejected_receipt(), [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      Atom.to_string(reason)
    ])

    case Postgrex.query!(connection, SQL.increment_rejected_receipt_capacity(), [
           Scope.uuid(identity.episode.tenant_id),
           Scope.uuid(identity.episode.space_id),
           Scope.uuid(identity.episode.episode_id),
           receipt_bytes
         ]).rows do
      [[_revision]] ->
        FaultHooks.command(:after_receipt_insert, identity, command)
        %Decision{command_id: command.id, result: :rejected, reason: reason}

      [] ->
        Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  def commit(connection, identity, command, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)
    stored_event = Control.stored_event(event, event_id, command.id, digest)
    event_bytes = Control.encoded_event_bytes(stored_event)
    receipt_bytes = receipt_bytes(command, :committed, nil, event_id, event.revision, digest)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    insert_event(connection, identity, command, stored_event, event_bytes)
    FaultHooks.command(:after_event_insert, identity, command)
    update_command_product(connection, identity, event)
    update_control(connection, identity, state, event_bytes, receipt_bytes)
    FaultHooks.command(:after_control_update, identity, command)
    insert_committed_receipt(connection, identity, command, event_id, event.revision, digest)
    FaultHooks.command(:after_receipt_insert, identity, command)
    Control.notify_head(connection, identity.episode, event.revision)

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
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.space_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(event.event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      event.schema_version,
      event.resulting_state_digest,
      event_bytes
    ])
  end

  defp update_control(connection, identity, state, event_bytes, receipt_bytes) do
    params = [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.space_id),
      Scope.uuid(identity.episode.episode_id),
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
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      Scope.uuid(event_id),
      revision,
      digest
    ])
  end

  def satisfy(connection, identity, command, state) do
    digest = Reducer.digest(state)
    receipt_bytes = receipt_bytes(command, :satisfied, nil, nil, state.revision, digest)

    Postgrex.query!(connection, SQL.insert_satisfied_receipt(), [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      receipt_command_name(command),
      state.revision,
      digest
    ])

    case Postgrex.query!(connection, SQL.increment_satisfied_receipt_capacity(), [
           Scope.uuid(identity.episode.tenant_id),
           Scope.uuid(identity.episode.space_id),
           Scope.uuid(identity.episode.episode_id),
           receipt_bytes
         ]).rows do
      [[revision]] when revision == state.revision ->
        FaultHooks.command(:after_receipt_insert, identity, command)

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
      Scope.episode(identity.episode) ++
        [Scope.uuid(event.payload["participant_id"]), event.payload["role"]]
    )
  end

  defp update_command_product(_connection, _identity, _event), do: :ok

  defp product_update!(connection, sql, params) do
    case Postgrex.query!(connection, sql, params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def receipt_bytes(command, outcome, reason, event_id, revision, digest \\ nil) do
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

  def receipt_command_name(command), do: Atom.to_string(command.name)
end
