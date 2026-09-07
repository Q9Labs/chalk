defmodule ChalkSync.Stateholder.Postgres.Control do
  @moduledoc false

  alias ChalkSync.DeliveryGate
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Control, as: SQL
  alias ChalkSync.UUID

  @schema_version 1

  def from_row([revision, folded_state, schema, digest, snapshot_bytes]) do
    %{
      revision: revision,
      folded_state: folded_state,
      state_schema_version: schema,
      digest: digest,
      snapshot_bytes: snapshot_bytes
    }
  end

  def stored_event(event, event_id, command_id, digest) do
    event
    |> Map.put(:event_id, event_id)
    |> Map.put(:command_id, command_id)
    |> Map.put(:lifecycle_intent_id, nil)
    |> Map.put(:schema_version, @schema_version)
    |> Map.put(:resulting_state_digest, digest)
  end

  def encoded_event_bytes(event) do
    event
    |> Map.update!(:resulting_state_digest, &Base.encode16(&1, case: :lower))
    |> JSON.encode!()
    |> byte_size()
  end

  def event_from_row([
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
      actor_participant_id: Scope.nullable_uuid(actor_id),
      command_id: command_id,
      lifecycle_intent_id: Scope.nullable_uuid(lifecycle_intent_id),
      external_operation_id: Scope.nullable_uuid(external_operation_id),
      schema_version: schema_version,
      resulting_state_digest: digest
    }
  end

  def notify_head(connection, episode, revision) do
    payload = "#{episode.tenant_id}:#{episode.space_id}:#{episode.episode_id}:#{revision}"

    case DeliveryGate.decide(:postgres_head_hint, %{revision: revision}) do
      :deliver -> Postgrex.query!(connection, SQL.notify_head(), [payload])
      :drop -> :ok
    end
  end

  def validate_fold(episode, control, episode_policy) do
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

  def validate_fold(episode, control) do
    policy = %{
      admission_policy: control.folded_state["admission_policy"],
      role_capabilities: control.folded_state["role_capabilities"]
    }

    validate_fold(episode, control, policy)
  end
end
