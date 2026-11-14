defmodule ChalkSync.WhiteboardV1.PostgresRepository do
  @moduledoc "Postgres authority for whiteboard-v1 scenes, elements, permissions, and receipts."

  @behaviour ChalkSync.WhiteboardV1.Repository

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository.Mutations
  alias ChalkSync.WhiteboardV1.PostgresRepository.Reads
  alias ChalkSync.WhiteboardV1.PostgresRepository.Store

  @impl true
  defdelegate episode_access(episode), to: Reads

  @impl true
  def connect(%Identity{} = identity) do
    Store.transaction(identity, fn connection ->
      with {:ok, authority} <- Store.authority(connection, identity),
           {:ok, scene} <- Store.current_scene(connection, identity) do
        {:ok, Map.merge(authority, scene)}
      end
    end)
  end

  @impl true
  def commit_update(%Identity{} = identity, operation) do
    fingerprint = Store.fingerprint(operation)

    Store.transaction(identity, fn connection ->
      with {:ok, scene} <- Store.drawing_scene(connection, identity),
           :ok <- Store.current_scene?(scene, operation.scene_id),
           :missing <- Store.receipt(connection, identity, operation.operation_id, fingerprint),
           {:ok, changed_elements} <-
             Mutations.upsert_elements(connection, identity, scene.scene_id, operation.elements),
           {:ok, revision} <- Mutations.advance_scene(connection, identity, scene.scene_id),
           :ok <-
             Store.insert_receipt(
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
           :ok <- Store.notify_head(connection, identity, scene.scene_id, revision) do
        {:ok,
         Map.put(
           Store.commit(operation.operation_id, :committed, scene.scene_id, revision),
           :elements,
           changed_elements
         )}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok,
           Map.put(
             Store.commit(operation.operation_id, :duplicate, scene_id, revision),
             :elements,
             []
           )}

        other ->
          other
      end
    end)
  end

  @impl true
  def clear(%Identity{} = identity, operation) do
    fingerprint = Store.fingerprint(operation)

    Store.transaction(identity, fn connection ->
      with {:ok, authority} <- Store.authority(connection, identity),
           :ok <- Store.require_capability(authority, "manageWhiteboard"),
           {:ok, scene} <- Store.current_scene(connection, identity),
           :ok <- Store.current_scene?(scene, operation.scene_id),
           :missing <- Store.receipt(connection, identity, operation.operation_id, fingerprint),
           new_scene_id = UUID.generate(),
           :ok <- Mutations.retire_scene(connection, identity, scene.scene_id),
           :ok <-
             Mutations.insert_scene(
               connection,
               identity,
               new_scene_id,
               scene.is_presenting,
               scene.presenter_id
             ),
           :ok <-
             Store.insert_receipt(
               connection,
               identity,
               operation.operation_id,
               fingerprint,
               "clear",
               %{scene_id: new_scene_id, revision: 0, elements: nil, presenting: nil}
             ),
           :ok <- Store.notify_head(connection, identity, new_scene_id, 0) do
        {:ok, Store.commit(operation.operation_id, :committed, new_scene_id, 0)}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok, Store.commit(operation.operation_id, :duplicate, scene_id, revision)}

        other ->
          other
      end
    end)
  end

  @impl true
  def set_draw_permission(%Identity{} = identity, operation) do
    fingerprint = Store.fingerprint(operation)

    Store.transaction(identity, fn connection ->
      with {:ok, authority, scene} <- Store.locked_scene(connection, identity),
           :ok <- Store.require_capability(authority, "manageWhiteboard"),
           :missing <- Store.receipt(connection, identity, operation.operation_id, fingerprint),
           :ok <-
             Mutations.store_permission(connection, identity, authority.draw_policy, operation),
           :ok <-
             Store.insert_receipt(
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
           :ok <- Store.notify_access(connection, identity) do
        {:ok, Store.commit(operation.operation_id, :committed, scene.scene_id, scene.revision)}
      else
        {:duplicate, scene_id, revision, _event_presenting} ->
          {:ok, Store.commit(operation.operation_id, :duplicate, scene_id, revision)}

        other ->
          other
      end
    end)
  end

  @impl true
  def set_draw_policy(%Identity{} = identity, operation) do
    Store.transaction(identity, fn connection ->
      with {:ok, authority} <- Store.authority(connection, identity),
           :ok <- Store.require_capability(authority, "manageWhiteboard"),
           {:ok, scene} <- Store.current_scene(connection, identity),
           {:ok, outcome} <- Mutations.apply_draw_policy(connection, identity, operation) do
        {:ok, Store.commit(operation.operation_id, outcome, scene.scene_id, scene.revision)}
      end
    end)
  end

  @impl true
  def draw_access(%Identity{} = identity) do
    Store.transaction(identity, fn connection ->
      with {:ok, authority} <- Store.authority(connection, identity),
           {:ok, grants} <- Reads.draw_grants(connection, identity, authority) do
        {:ok, Map.put(authority, :grants, grants)}
      end
    end)
  end

  @impl true
  def set_presentation(%Identity{} = identity, operation) do
    fingerprint = Store.fingerprint(operation)

    Store.transaction(identity, fn connection ->
      with {:ok, scene} <- Store.drawing_scene(connection, identity),
           :missing <- Store.receipt(connection, identity, operation.operation_id, fingerprint),
           {:ok, revision, presenting} <-
             Mutations.update_presentation(
               connection,
               identity,
               scene.scene_id,
               operation.presenting
             ),
           :ok <-
             Store.insert_receipt(
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
           :ok <- Store.notify_head(connection, identity, scene.scene_id, revision) do
        {:ok,
         operation.operation_id
         |> Store.commit(:committed, scene.scene_id, revision)
         |> Map.put(:presenting, presenting)}
      else
        {:duplicate, scene_id, revision, presenting} when is_boolean(presenting) ->
          {:ok,
           operation.operation_id
           |> Store.commit(:duplicate, scene_id, revision)
           |> Map.put(:presenting, presenting)}

        other ->
          other
      end
    end)
  end

  @impl true
  def snapshot(%Identity{} = identity) do
    Store.transaction(identity, fn connection ->
      with {:ok, authority} <- Store.authority(connection, identity),
           {:ok, scene} <- Store.current_scene(connection, identity),
           {:ok, elements} <- Reads.snapshot_elements(connection, identity, scene.scene_id) do
        {:ok, Map.merge(scene, %{elements: elements, can_draw: authority.can_draw})}
      end
    end)
  end

  @impl true
  def read_after(%Identity{} = identity, scene_id, revision) do
    Store.transaction(identity, fn connection ->
      with {:ok, _authority} <- Store.authority(connection, identity),
           {:ok, scene} <- Store.current_scene(connection, identity),
           :ok <- Store.current_scene?(scene, scene_id) do
        Reads.read_after_rows(connection, identity, scene_id, revision)
      end
    end)
  end
end
