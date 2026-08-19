defmodule ChalkSync.WhiteboardV1.PostgresRepository do
  @moduledoc "Postgres authority for whiteboard-v1 scenes, elements, permissions, and receipts."

  @behaviour ChalkSync.WhiteboardV1.Repository

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.SQL

  @impl true
  def connect(%Identity{} = identity) do
    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           {:ok, scene} <- current_scene(connection, identity) do
        {:ok, Map.merge(authority, scene)}
      end
    end)
  end

  @impl true
  def commit_update(%Identity{} = identity, operation) do
    fingerprint = fingerprint(operation)

    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           :ok <- require_capability(authority, "drawWhiteboard"),
           {:ok, scene} <- current_scene(connection, identity),
           :ok <- current_scene?(scene, operation.scene_id),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           :ok <- upsert_elements(connection, identity, scene.scene_id, operation.elements),
           {:ok, revision} <- advance_scene(connection, identity, scene.scene_id),
           :ok <-
             insert_receipt(
               connection,
               identity,
               operation.operation_id,
               fingerprint,
               "submit_update",
               %{
                 scene_id: scene.scene_id,
                 revision: revision,
                 elements: operation.elements,
                 presenting: nil
               }
             ),
           :ok <- notify_head(connection, identity, scene.scene_id, revision) do
        {:ok, commit(operation.operation_id, :committed, scene.scene_id, revision)}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok, commit(operation.operation_id, :duplicate, scene_id, revision)}

        other ->
          other
      end
    end)
  end

  @impl true
  def clear(%Identity{} = identity, operation) do
    fingerprint = fingerprint(operation)

    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           :ok <- require_capability(authority, "manageWhiteboard"),
           {:ok, scene} <- current_scene(connection, identity),
           :ok <- current_scene?(scene, operation.scene_id),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           new_scene_id = UUID.generate(),
           :ok <- retire_scene(connection, identity, scene.scene_id),
           :ok <- insert_scene(connection, identity, new_scene_id, scene.is_presenting),
           :ok <-
             insert_receipt(
               connection,
               identity,
               operation.operation_id,
               fingerprint,
               "clear",
               %{scene_id: new_scene_id, revision: 0, elements: nil, presenting: nil}
             ),
           :ok <- notify_head(connection, identity, new_scene_id, 0) do
        {:ok, commit(operation.operation_id, :committed, new_scene_id, 0)}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok, commit(operation.operation_id, :duplicate, scene_id, revision)}

        other ->
          other
      end
    end)
  end

  @impl true
  def set_draw_permission(%Identity{} = identity, operation) do
    fingerprint = fingerprint(operation)

    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           :ok <- require_capability(authority, "manageWhiteboard"),
           {:ok, scene} <- current_scene(connection, identity),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           :ok <- upsert_permission(connection, identity, operation),
           :ok <-
             insert_receipt(
               connection,
               identity,
               operation.operation_id,
               fingerprint,
               "set_draw_permission",
               %{
                 scene_id: scene.scene_id,
                 revision: scene.revision,
                 elements: nil,
                 presenting: nil
               }
             ) do
        {:ok, commit(operation.operation_id, :committed, scene.scene_id, scene.revision)}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok, commit(operation.operation_id, :duplicate, scene_id, revision)}

        other ->
          other
      end
    end)
  end

  @impl true
  def set_presentation(%Identity{} = identity, operation) do
    fingerprint = fingerprint(operation)

    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           :ok <- require_capability(authority, "drawWhiteboard"),
           {:ok, scene} <- current_scene(connection, identity),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           {:ok, revision, presenting} <-
             update_presentation(connection, identity, scene.scene_id, operation.presenting),
           :ok <-
             insert_receipt(
               connection,
               identity,
               operation.operation_id,
               fingerprint,
               "set_presentation",
               %{
                 scene_id: scene.scene_id,
                 revision: revision,
                 elements: nil,
                 presenting: presenting
               }
             ),
           :ok <- notify_head(connection, identity, scene.scene_id, revision) do
        {:ok,
         operation.operation_id
         |> commit(:committed, scene.scene_id, revision)
         |> Map.put(:presenting, presenting)}
      else
        {:duplicate, scene_id, revision, presenting} when is_boolean(presenting) ->
          {:ok,
           operation.operation_id
           |> commit(:duplicate, scene_id, revision)
           |> Map.put(:presenting, presenting)}

        other ->
          other
      end
    end)
  end

  @impl true
  def snapshot(%Identity{} = identity) do
    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           {:ok, scene} <- current_scene(connection, identity),
           {:ok, elements} <- snapshot_elements(connection, identity, scene.scene_id) do
        {:ok, Map.merge(scene, %{elements: elements, can_draw: authority.can_draw})}
      end
    end)
  end

  @impl true
  def read_after(%Identity{} = identity, scene_id, revision) do
    transaction(identity, fn connection ->
      with {:ok, _authority} <- authority(connection, identity),
           {:ok, scene} <- current_scene(connection, identity),
           :ok <- current_scene?(scene, scene_id) do
        read_after_rows(connection, identity, scene_id, revision)
      end
    end)
  end

  defp transaction(identity, callback) do
    connection = Database.connection(identity.episode)

    case Postgrex.transaction(connection, &run_transaction(&1, callback)) do
      {:ok, result} ->
        result

      {:error, {:domain, failure}} ->
        failure

      {:error, %Postgrex.Error{postgres: %{code: code}}}
      when code in [:lock_not_available, :query_canceled] ->
        {:retryable, :overloaded}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp run_transaction(transaction, callback) do
    Postgrex.query!(transaction, SQL.transaction_settings(), [])

    case callback.(transaction) do
      {:ok, _result} = success -> success
      failure -> Postgrex.rollback(transaction, {:domain, failure})
    end
  end

  defp read_after_rows(connection, identity, scene_id, revision) do
    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.episode_id),
      uuid(scene_id),
      revision
    ]

    case Postgrex.query(connection, SQL.read_after(), params) do
      {:ok, %Postgrex.Result{rows: rows}} -> {:ok, Enum.map(rows, &read_after_event/1)}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp read_after_event([
         "submit_update",
         operation_id,
         encoded_scene_id,
         revision,
         elements,
         nil
       ]) do
    %{
      type: :update,
      operation_id: operation_id,
      scene_id: UUID.load!(encoded_scene_id),
      revision: revision,
      elements: elements
    }
  end

  defp read_after_event([
         "set_presentation",
         operation_id,
         encoded_scene_id,
         revision,
         nil,
         presenting
       ]) do
    %{
      type: :presentation,
      operation_id: operation_id,
      scene_id: UUID.load!(encoded_scene_id),
      revision: revision,
      presenting: presenting
    }
  end

  defp authority(connection, identity) do
    params =
      context(identity) ++
        [uuid(identity.participant_id), identity.participant_generation]

    case Postgrex.query(connection, SQL.lock_authority(), params) do
      {:ok, %Postgrex.Result{rows: [[_role, capabilities, can_draw]]}} ->
        role_capabilities =
          Enum.filter(capabilities, &(&1 in ["drawWhiteboard", "manageWhiteboard"]))

        participant_capabilities =
          if can_draw,
            do: Enum.uniq(["drawWhiteboard" | role_capabilities]),
            else: role_capabilities -- ["drawWhiteboard"]

        {:ok,
         %{
           capabilities: role_capabilities,
           participant_capabilities: participant_capabilities,
           can_draw: can_draw
         }}

      {:ok, %Postgrex.Result{rows: []}} ->
        {:error, :permission_denied}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp current_scene(connection, identity) do
    generated_scene_id = UUID.generate()

    with {:ok, _result} <-
           Postgrex.query(
             connection,
             SQL.ensure_scene(),
             context(identity) ++ [uuid(generated_scene_id)]
           ),
         {:ok, %Postgrex.Result{rows: [[scene_id, revision, app_state, is_presenting]]}} <-
           Postgrex.query(connection, SQL.lock_scene(), context(identity)) do
      {:ok,
       %{
         scene_id: UUID.load!(scene_id),
         revision: revision,
         app_state: app_state,
         is_presenting: is_presenting
       }}
    else
      {:ok, %Postgrex.Result{rows: []}} ->
        {:retryable, :storage_unavailable}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp receipt(connection, identity, operation_id, fingerprint) do
    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.participant_id),
      operation_id
    ]

    case Postgrex.query(connection, SQL.select_receipt(), params) do
      {:ok, %Postgrex.Result{rows: []}} ->
        :missing

      {:ok, %Postgrex.Result{rows: [[^fingerprint, scene_id, revision, event_presenting]]}} ->
        {:duplicate, UUID.load!(scene_id), revision, event_presenting}

      {:ok, %Postgrex.Result{rows: [_conflict]}} ->
        {:error, :operation_id_conflict}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp upsert_elements(connection, identity, scene_id, elements) do
    Enum.reduce_while(elements, :ok, fn element, :ok ->
      encoded_bytes = element |> JSON.encode!() |> byte_size()

      params =
        context(identity) ++
          [
            uuid(scene_id),
            element["id"],
            element["type"],
            element["version"],
            element["version_nonce"],
            element["index"],
            element["is_deleted"],
            element["payload"],
            encoded_bytes
          ]

      case Postgrex.query(connection, SQL.upsert_element(), params) do
        {:ok, _result} -> {:cont, :ok}
        {:error, _error} -> {:halt, {:retryable, :storage_unavailable}}
      end
    end)
  end

  defp advance_scene(connection, identity, scene_id) do
    params = context(identity) ++ [uuid(scene_id)]

    case Postgrex.query(connection, SQL.update_scene_head(), params) do
      {:ok, %Postgrex.Result{rows: [[revision, _count, _bytes]]}} -> {:ok, revision}
      {:ok, %Postgrex.Result{rows: []}} -> {:error, :invalid_payload}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp insert_receipt(
         connection,
         identity,
         operation_id,
         fingerprint,
         operation_name,
         event
       ) do
    event_encoded_bytes =
      if event.elements, do: event.elements |> JSON.encode!() |> byte_size(), else: 0

    params =
      context(identity) ++
        [
          uuid(identity.participant_id),
          identity.participant_generation,
          operation_id,
          fingerprint,
          operation_name,
          uuid(event.scene_id),
          event.revision,
          event.elements,
          event.presenting,
          event_encoded_bytes
        ]

    case Postgrex.query(connection, SQL.insert_receipt(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp retire_scene(connection, identity, scene_id) do
    case Postgrex.query(connection, SQL.retire_scene(), context(identity) ++ [uuid(scene_id)]) do
      {:ok, %Postgrex.Result{num_rows: 1}} -> :ok
      {:ok, _result} -> {:error, :stale_scene}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp insert_scene(connection, identity, scene_id, is_presenting) do
    case Postgrex.query(
           connection,
           SQL.insert_scene(),
           context(identity) ++ [uuid(scene_id), is_presenting]
         ) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp update_presentation(connection, identity, scene_id, presenting) do
    params = context(identity) ++ [uuid(scene_id), presenting]

    case Postgrex.query(connection, SQL.update_presentation(), params) do
      {:ok, %Postgrex.Result{rows: [[revision, is_presenting]]}} ->
        {:ok, revision, is_presenting}

      {:ok, _result} ->
        {:error, :stale_scene}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp upsert_permission(connection, identity, operation) do
    params =
      context(identity) ++
        [
          uuid(operation.participant_id),
          operation.can_draw,
          uuid(identity.participant_id)
        ]

    case Postgrex.query(connection, SQL.upsert_permission(), params) do
      {:ok, %Postgrex.Result{num_rows: 1}} -> :ok
      {:ok, _result} -> {:error, :invalid_payload}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp snapshot_elements(connection, identity, scene_id) do
    params = [uuid(identity.episode.tenant_id), uuid(identity.episode.space_id), uuid(scene_id)]

    case Postgrex.query(connection, SQL.snapshot_elements(), params) do
      {:ok, %Postgrex.Result{rows: rows}} when length(rows) <= 10_000 ->
        {:ok, Enum.map(rows, &element/1)}

      {:ok, _result} ->
        {:error, :invalid_payload}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
    end
  end

  defp element([id, type, version, nonce, index, is_deleted, payload]) do
    %{
      "id" => id,
      "type" => type,
      "version" => version,
      "version_nonce" => nonce,
      "index" => index,
      "is_deleted" => is_deleted,
      "payload" => payload
    }
  end

  defp notify_head(connection, identity, scene_id, revision) do
    payload =
      Enum.join(
        [
          identity.episode.tenant_id,
          identity.episode.space_id,
          identity.episode.episode_id,
          scene_id,
          revision
        ],
        ":"
      )

    case Postgrex.query(connection, SQL.notify_head(), [payload]) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp require_capability(authority, capability) do
    if capability in authority.participant_capabilities,
      do: :ok,
      else: {:error, :permission_denied}
  end

  defp current_scene?(scene, scene_id) do
    if scene.scene_id == scene_id, do: :ok, else: {:error, :stale_scene}
  end

  defp commit(operation_id, outcome, scene_id, revision),
    do: %{
      operation_id: operation_id,
      outcome: outcome,
      scene_id: scene_id,
      revision: revision
    }

  defp fingerprint(operation),
    do: :crypto.hash(:sha256, JSON.encode!(operation))

  defp context(identity),
    do: [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.episode.episode_id)
    ]

  defp uuid(value), do: UUID.dump!(value)
end
