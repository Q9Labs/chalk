defmodule ChalkSync.Stateholder.Postgres.RoleTransitionPlanner.Persist do
  @moduledoc """
  Writes a pending role transition: its parent operation, children and capacity check.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Postgres.CommandPersistence
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: ExternalOperationsSQL
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionPlanner, as: SQL
  alias ChalkSync.UUID

  @max_event_bytes 32 * 1024
  @max_pending_operations 2_048

  def persist_pending_role_transition(
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
    stored_event = Control.stored_event(event, event_id, command.id, digest)
    event_bytes = Control.encoded_event_bytes(stored_event)

    receipt_bytes =
      CommandPersistence.receipt_bytes(
        command,
        :pending,
        nil,
        event_id,
        event.revision,
        digest
      )

    parent_id = UUID.generate()

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    CommandPersistence.append_control_change(
      connection,
      identity,
      command,
      stored_event,
      state,
      event_bytes,
      receipt_bytes
    )

    insert_role_transition_parent(connection, identity, command, affected, parent_id)
    insert_role_transition_children(connection, identity.episode, affected, parent_id, sources)

    parent = role_transition_parent(identity, command, affected, parent_id)
    PublicationFences.install(connection, identity.episode, parent, affected, sources)

    Postgrex.query!(connection, SQL.insert_pending_role_transition_receipt(), [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      command.id,
      command.fingerprint,
      CommandPersistence.receipt_command_name(command),
      Scope.uuid(parent_id),
      Scope.uuid(event_id),
      event.revision,
      digest
    ])

    Control.notify_head(connection, identity.episode, event.revision)

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
    case Postgrex.query!(
           connection,
           ExternalOperationsSQL.count_pending_operations(),
           Scope.episode(episode)
         ).rows do
      [[count]] when count + required <= @max_pending_operations -> :ok
      _ -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end


  defp insert_role_transition_parent(connection, identity, command, affected, parent_id) do
    payload = Map.put(command.payload, "commandName", Atom.to_string(command.name))
    request_key = String.replace(identity.participant_id, "-", "") <> "_" <> command.id

    Postgrex.query!(connection, SQL.insert_role_transition_parent(), [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.space_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(parent_id),
      request_key,
      command.fingerprint,
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      Scope.uuid(affected.id),
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
        Scope.episode(episode) ++
          [
            Scope.uuid(child_id),
            Scope.uuid(parent_id),
            request_key,
            :crypto.hash(:sha256, request_key),
            Scope.uuid(affected.id),
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
end
