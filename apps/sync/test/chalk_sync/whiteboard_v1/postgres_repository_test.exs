defmodule ChalkSync.WhiteboardV1.PostgresRepositoryTest do
  use ExUnit.Case, async: false

  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.PostgresRepository

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  setup %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_episode(connection, 2)

    on_exit(fn ->
      cleanup_whiteboard(connection, fixture.episode)
      SyncPostgres.cleanup(connection, fixture.episode)
    end)

    {:ok,
     connection: connection,
     host: hd(fixture.identities),
     participant: List.last(fixture.identities)}
  end

  test "persists stable receipts, scene epochs, and drawing permissions", %{
    host: host,
    participant: participant
  } do
    assert {:ok, %{scene_id: scene_id, revision: 0, can_draw: true}} =
             PostgresRepository.connect(host)

    update = %{
      operation_id: "whiteboard-update-0001",
      scene_id: scene_id,
      elements: [element("shape-1", 1, 20)]
    }

    assert {:ok, %{outcome: :committed, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    assert {:ok, %{outcome: :duplicate, revision: 1, scene_id: ^scene_id}} =
             PostgresRepository.commit_update(host, update)

    conflicting = %{update | elements: [element("shape-1", 2, 19)]}
    assert {:error, :operation_id_conflict} = PostgresRepository.commit_update(host, conflicting)

    assert {:ok, %{revision: 1, elements: [stored]}} = PostgresRepository.snapshot(participant)
    assert stored["id"] == "shape-1"
    assert stored["version"] == 1

    permission = %{
      operation_id: "whiteboard-permission-0001",
      participant_id: participant.participant_id,
      can_draw: false
    }

    assert {:ok, %{outcome: :committed, revision: 1}} =
             PostgresRepository.set_draw_permission(host, permission)

    denied_update = %{
      operation_id: "whiteboard-update-0002",
      scene_id: scene_id,
      elements: [element("shape-2", 1, 30)]
    }

    assert {:error, :permission_denied} =
             PostgresRepository.commit_update(participant, denied_update)

    clear = %{operation_id: "whiteboard-clear-0001", scene_id: scene_id}

    assert {:ok, %{outcome: :committed, scene_id: new_scene_id, revision: 0}} =
             PostgresRepository.clear(host, clear)

    assert new_scene_id != scene_id
    assert {:error, :stale_scene} = PostgresRepository.commit_update(host, denied_update)

    assert {:ok, %{scene_id: ^new_scene_id, revision: 0, elements: []}} =
             PostgresRepository.snapshot(host)
  end

  defp element(id, version, version_nonce) do
    %{
      "id" => id,
      "type" => "rectangle",
      "version" => version,
      "version_nonce" => version_nonce,
      "index" => "a0",
      "is_deleted" => false,
      "payload" => %{"x" => 10, "y" => 20, "width" => 100, "height" => 60}
    }
  end

  defp cleanup_whiteboard(connection, episode) do
    params = [uuid(episode.tenant_id), uuid(episode.space_id)]

    Enum.each(
      [
        "sync_whiteboard_files",
        "sync_whiteboard_operation_receipts",
        "sync_whiteboard_permissions",
        "sync_whiteboard_elements",
        "sync_whiteboard_scenes"
      ],
      fn table ->
        Postgrex.query!(
          connection,
          "delete from #{table} where tenant_id = $1 and space_id = $2",
          params
        )
      end
    )
  end

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  catch
    :exit, _reason -> :ok
  end

  defp uuid(value), do: UUID.dump!(value)
end
