defmodule ChalkSync.WhiteboardV1.PostgresRepository.Reads do
  @moduledoc """
  Replay, snapshot, draw-grant and Episode access reads.
  """

  alias ChalkSync.Contract.GeneratedWhiteboardV1
  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository.Store
  alias ChalkSync.WhiteboardV1.SQL

  @limits GeneratedWhiteboardV1.limits()
  @max_draw_grants @limits["drawAccessMaxGrants"]
  @max_replay_bytes @limits["socketQueueMaxBytes"]
  @max_replay_items @limits["snapshotPageMaxItems"]

  def episode_access(%EpisodeKey{} = episode) do
    params = [
      Store.uuid(episode.tenant_id),
      Store.uuid(episode.space_id),
      Store.uuid(episode.episode_id)
    ]

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
        {:retryable, {:storage_unavailable, Store.storage_failure(error)}}
    end
  catch
    :exit, _reason -> {:retryable, {:storage_unavailable, "exit"}}
  end

  def read_after_rows(connection, identity, scene_id, revision) do
    params = [
      Store.uuid(identity.episode.tenant_id),
      Store.uuid(identity.episode.episode_id),
      Store.uuid(scene_id),
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
         nil,
         _participant_id
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
         presenting,
         participant_id
       ]) do
    %{
      type: :presentation,
      operation_id: operation_id,
      scene_id: UUID.load!(encoded_scene_id),
      revision: revision,
      presenting: presenting,
      presenter_id: if(presenting, do: participant_id, else: nil)
    }
  end

  # Only hosts see the per-person choices, because only hosts can change them.
  def draw_grants(connection, identity, authority) do
    if "manageWhiteboard" in authority.capabilities do
      case Postgrex.query(
             connection,
             SQL.draw_grants(),
             Store.context(identity) ++ [@max_draw_grants]
           ) do
        {:ok, %Postgrex.Result{rows: rows}} ->
          {:ok, Enum.map(rows, fn [participant_id, can_draw] -> {participant_id, can_draw} end)}

        {:error, _error} ->
          {:retryable, :storage_unavailable}
      end
    else
      {:ok, []}
    end
  end

  def snapshot_elements(connection, identity, scene_id) do
    params = [
      Store.uuid(identity.episode.tenant_id),
      Store.uuid(identity.episode.space_id),
      Store.uuid(scene_id)
    ]

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
end
