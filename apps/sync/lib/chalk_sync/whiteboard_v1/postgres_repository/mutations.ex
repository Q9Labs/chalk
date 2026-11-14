defmodule ChalkSync.WhiteboardV1.PostgresRepository.Mutations do
  @moduledoc """
  Row writes for scenes, elements, presentation, draw permissions and draw policy.
  """

  alias ChalkSync.WhiteboardV1.PostgresRepository.Store
  alias ChalkSync.WhiteboardV1.SQL

  # Policy changes allowed in one Episode; far above what a real call needs.
  @max_draw_policy_receipts 1024

  def upsert_elements(connection, identity, scene_id, elements) do
    result =
      Enum.reduce_while(elements, {:ok, []}, fn element, {:ok, changed} ->
        encoded_bytes = element |> JSON.encode!() |> byte_size()

        params =
          Store.context(identity) ++
            [
              Store.uuid(scene_id),
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

  def advance_scene(connection, identity, scene_id) do
    params = Store.context(identity) ++ [Store.uuid(scene_id)]

    case Postgrex.query(connection, SQL.update_scene_head(), params) do
      {:ok, %Postgrex.Result{rows: [[revision, _count, _bytes]]}} -> {:ok, revision}
      {:ok, %Postgrex.Result{rows: []}} -> {:error, :invalid_payload}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  def retire_scene(connection, identity, scene_id) do
    case Postgrex.query(
           connection,
           SQL.retire_scene(),
           Store.context(identity) ++ [Store.uuid(scene_id)]
         ) do
      {:ok, %Postgrex.Result{num_rows: 1}} -> :ok
      {:ok, _result} -> {:error, :stale_scene}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  def insert_scene(connection, identity, scene_id, is_presenting, presenter_id) do
    case Postgrex.query(
           connection,
           SQL.insert_scene(),
           Store.context(identity) ++
             [Store.uuid(scene_id), is_presenting, Store.nullable_uuid(presenter_id)]
         ) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  def update_presentation(connection, identity, scene_id, presenting) do
    params =
      Store.context(identity) ++
        [Store.uuid(scene_id), presenting, Store.uuid(identity.participant_id)]

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
  def store_permission(connection, identity, "picked", %{can_draw: false} = operation) do
    case Postgrex.query(
           connection,
           SQL.delete_permission(),
           Store.context(identity) ++ [Store.uuid(operation.participant_id)]
         ) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  def store_permission(connection, identity, _draw_policy, operation),
    do: upsert_permission(connection, identity, operation)

  defp upsert_permission(connection, identity, operation) do
    params =
      Store.context(identity) ++
        [
          Store.uuid(operation.participant_id),
          operation.can_draw,
          Store.uuid(identity.participant_id)
        ]

    case Postgrex.query(connection, SQL.upsert_permission(), params) do
      {:ok, %Postgrex.Result{num_rows: 1}} -> :ok
      {:ok, _result} -> {:error, :invalid_payload}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  def apply_draw_policy(connection, identity, operation) do
    with :missing <- draw_policy_receipt(connection, identity, operation),
         :ok <- draw_policy_capacity(connection, identity),
         :ok <- upsert_draw_policy(connection, identity, operation),
         :ok <- insert_draw_policy_receipt(connection, identity, operation),
         :ok <- Store.notify_access(connection, identity) do
      {:ok, :committed}
    else
      :duplicate -> {:ok, :duplicate}
      other -> other
    end
  end

  defp draw_policy_receipt(connection, identity, operation) do
    params = [
      Store.uuid(identity.episode.tenant_id),
      Store.uuid(identity.episode.space_id),
      Store.uuid(identity.participant_id),
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
    params = Store.context(identity) ++ [operation.policy, Store.uuid(identity.participant_id)]

    case Postgrex.query(connection, SQL.upsert_draw_policy(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  defp insert_draw_policy_receipt(connection, identity, operation) do
    params =
      Store.context(identity) ++
        [Store.uuid(identity.participant_id), operation.operation_id, operation.policy]

    case Postgrex.query(connection, SQL.insert_draw_policy_receipt(), params) do
      {:ok, _result} -> :ok
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end

  # Receipts are never evicted, so a retry from any time in the call stays a
  # duplicate. New changes stop at the cap instead.
  defp draw_policy_capacity(connection, identity) do
    case Postgrex.query(connection, SQL.count_draw_policy_receipts(), Store.context(identity)) do
      {:ok, %Postgrex.Result{rows: [[count]]}} when count < @max_draw_policy_receipts -> :ok
      {:ok, _result} -> {:error, :draw_policy_limit}
      {:error, _error} -> {:retryable, :storage_unavailable}
    end
  end
end
