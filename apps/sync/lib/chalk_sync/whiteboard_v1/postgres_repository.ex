defmodule ChalkSync.WhiteboardV1.PostgresRepository do
  @moduledoc "Postgres authority for whiteboard-v1 scenes, elements, permissions, and receipts."

  @behaviour ChalkSync.WhiteboardV1.Repository

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Fanout
  alias ChalkSync.WhiteboardV1.SQL

  @limits GeneratedWhiteboardV1.limits()
  @max_replay_items @limits["snapshotPageMaxItems"]
  @max_replay_bytes @limits["socketQueueMaxBytes"]
  @max_draw_grants @limits["drawAccessMaxGrants"]
  # Policy changes allowed in one Episode; far above what a real call needs.
  @max_draw_policy_receipts 1024

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
      with {:ok, scene} <- drawing_scene(connection, identity),
           :ok <- current_scene?(scene, operation.scene_id),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           {:ok, changed_elements} <-
             upsert_elements(connection, identity, scene.scene_id, operation.elements),
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
                 elements: changed_elements,
                 presenting: nil
               }
             ),
           :ok <- notify_head(connection, identity, scene.scene_id, revision) do
        {:ok,
         Map.put(
           commit(operation.operation_id, :committed, scene.scene_id, revision),
           :elements,
           changed_elements
         )}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok,
           Map.put(commit(operation.operation_id, :duplicate, scene_id, revision), :elements, [])}

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
      with {:ok, authority, scene} <- locked_scene(connection, identity),
           :ok <- require_capability(authority, "manageWhiteboard"),
           :missing <- receipt(connection, identity, operation.operation_id, fingerprint),
           :ok <- store_permission(connection, identity, authority.draw_policy, operation),
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
             ),
           :ok <- notify_access(connection, identity) do
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
  def set_draw_policy(%Identity{} = identity, operation) do
    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           :ok <- require_capability(authority, "manageWhiteboard"),
           {:ok, scene} <- current_scene(connection, identity),
           {:ok, outcome} <- apply_draw_policy(connection, identity, operation) do
        {:ok, commit(operation.operation_id, outcome, scene.scene_id, scene.revision)}
      end
    end)
  end

  @impl true
  def draw_access(%Identity{} = identity) do
    transaction(identity, fn connection ->
      with {:ok, authority} <- authority(connection, identity),
           {:ok, grants} <- draw_grants(connection, identity, authority) do
        {:ok, Map.put(authority, :grants, grants)}
      end
    end)
  end

  @impl true
  def set_presentation(%Identity{} = identity, operation) do
    fingerprint = fingerprint(operation)

    transaction(identity, fn connection ->
      with {:ok, scene} <- drawing_scene(connection, identity),
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

  @impl true
  def episode_access(%EpisodeKey{} = episode) do
    params = [uuid(episode.tenant_id), uuid(episode.space_id), uuid(episode.episode_id)]

    case Postgrex.query(Database.connection(episode), SQL.episode_access(), params,
           timeout: 1_000
         ) do
      {:ok, %Postgrex.Result{rows: []}} ->
        {:error, :not_found}

      {:ok, %Postgrex.Result{rows: [[episode_status | _participant] | _rest] = rows}} ->
        participants =
          for [_episode_status, id, generation, status] <- rows, id != nil, into: %{} do
            {{UUID.load!(id), generation}, status}
          end

        {:ok, %{status: episode_status, participants: participants}}

      {:error, error} ->
        {:retryable, {:storage_unavailable, storage_failure(error)}}
    end
  catch
    :exit, _reason -> {:retryable, {:storage_unavailable, "exit"}}
  end

  @doc false
  # A bounded category for close evidence; the error itself can carry query text and values.
  def storage_failure(%DBConnection.ConnectionError{reason: :queue_timeout}), do: "queue_timeout"
  def storage_failure(%DBConnection.ConnectionError{}), do: "connection"
  def storage_failure(%Postgrex.Error{postgres: %{code: :query_canceled}}), do: "timeout"
  def storage_failure(%Postgrex.Error{}), do: "postgres"
  def storage_failure(_error), do: "unknown"

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

    # Check metadata under the scene lock before Postgrex loads any event JSON.
    with :ok <- read_after_fits?(connection, params),
         {:ok, %Postgrex.Result{rows: rows}} <-
           Postgrex.query(connection, SQL.read_after(), params) do
      {:ok, Enum.map(rows, &read_after_event/1)}
    else
      {:error, :cursor_reset_required} = reset -> reset
      {:error, _error} -> {:retryable, :storage_unavailable}
      other -> other
    end
  end

  defp read_after_fits?(connection, params) do
    case Postgrex.query(connection, SQL.read_after_size(), params) do
      {:ok, %Postgrex.Result{rows: [[count, bytes]]}}
      when count <= @max_replay_items and bytes <= @max_replay_bytes ->
        :ok

      {:ok, _result} ->
        {:error, :cursor_reset_required}

      {:error, _error} ->
        {:retryable, :storage_unavailable}
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
      {:ok, %Postgrex.Result{rows: [[_role, capabilities, can_draw, draw_policy]]}} ->
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
           can_draw: can_draw,
           draw_policy: draw_policy
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

  defp drawing_scene(connection, identity) do
    with {:ok, authority, scene} <- locked_scene(connection, identity),
         :ok <- require_capability(authority, "drawWhiteboard") do
      {:ok, scene}
    end
  end

  # A policy or per-person change commits while holding the scene lock, so the
  # rule and the policy are read again once this transaction holds it. The
  # first read takes the participant row lock first, which keeps the lock
  # order of every other write.
  defp locked_scene(connection, identity) do
    with {:ok, _locked} <- authority(connection, identity),
         {:ok, scene} <- current_scene(connection, identity),
         {:ok, authority} <- authority(connection, identity) do
      {:ok, authority, scene}
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
    result =
      Enum.reduce_while(elements, {:ok, []}, fn element, {:ok, changed} ->
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
          {:ok, %Postgrex.Result{num_rows: 1}} -> {:cont, {:ok, [element | changed]}}
          {:ok, %Postgrex.Result{num_rows: 0}} -> {:cont, {:ok, changed}}
          {:error, _error} -> {:halt, {:retryable, :storage_unavailable}}
        end
      end)

    case result do
      {:ok, changed} -> {:ok, Enum.reverse(changed)}
      other -> other
    end
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

  # Under picked, no row already means not picked, and a stored false would
  # still block the person after the host switches back to everyone.
  defp store_permission(connection, identity, "picked", %{can_draw: false} = operation) do
    case Postgrex.query(
           connection,
           SQL.delete_permission(),
           context(identity) ++ [uuid(operation.participant_id)]
         ) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp store_permission(connection, identity, _draw_policy, operation),
    do: upsert_permission(connection, identity, operation)

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

  defp apply_draw_policy(connection, identity, operation) do
    with :missing <- draw_policy_receipt(connection, identity, operation),
         :ok <- draw_policy_capacity(connection, identity),
         :ok <- upsert_draw_policy(connection, identity, operation),
         :ok <- insert_draw_policy_receipt(connection, identity, operation),
         :ok <- notify_access(connection, identity) do
      {:ok, :committed}
    else
      :duplicate -> {:ok, :duplicate}
      other -> other
    end
  end

  defp draw_policy_receipt(connection, identity, operation) do
    params = [
      uuid(identity.episode.tenant_id),
      uuid(identity.episode.space_id),
      uuid(identity.participant_id),
      operation.operation_id
    ]

    case Postgrex.query(connection, SQL.select_draw_policy_receipt(), params) do
      {:ok, %Postgrex.Result{rows: []}} -> :missing
      {:ok, %Postgrex.Result{rows: [[policy]]}} when policy == operation.policy -> :duplicate
      {:ok, %Postgrex.Result{rows: [_conflict]}} -> {:error, :operation_id_conflict}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp upsert_draw_policy(connection, identity, operation) do
    params = context(identity) ++ [operation.policy, uuid(identity.participant_id)]

    case Postgrex.query(connection, SQL.upsert_draw_policy(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp insert_draw_policy_receipt(connection, identity, operation) do
    params =
      context(identity) ++
        [uuid(identity.participant_id), operation.operation_id, operation.policy]

    case Postgrex.query(connection, SQL.insert_draw_policy_receipt(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  # Receipts are never evicted, so a retry from any time in the call stays a
  # duplicate. New changes stop at the cap instead, as rate_limited.
  defp draw_policy_capacity(connection, identity) do
    case Postgrex.query(connection, SQL.count_draw_policy_receipts(), context(identity)) do
      {:ok, %Postgrex.Result{rows: [[count]]}} when count < @max_draw_policy_receipts -> :ok
      {:ok, _result} -> {:error, :rate_limited}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  # Only hosts see the per-person choices, because only hosts can change them.
  defp draw_grants(connection, identity, authority) do
    if "manageWhiteboard" in authority.capabilities do
      case Postgrex.query(connection, SQL.draw_grants(), context(identity) ++ [@max_draw_grants]) do
        {:ok, %Postgrex.Result{rows: rows}} ->
          {:ok, Enum.map(rows, fn [participant_id, can_draw] -> {participant_id, can_draw} end)}

        {:error, _error} ->
          {:retryable, :storage_unavailable}
      end
    else
      {:ok, []}
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

  defp notify_access(connection, identity) do
    case Postgrex.query(connection, SQL.notify_access(), [Fanout.access_payload(identity.episode)]) do
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
