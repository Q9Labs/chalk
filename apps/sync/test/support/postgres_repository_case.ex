defmodule ChalkSync.WhiteboardV1.PostgresRepositoryCase do
  @moduledoc "Shared setup and helpers for the split test files."
  use ExUnit.CaseTemplate

  alias ChalkSync.SyncPostgres
  alias ChalkSync.TestProcess
  alias ChalkSync.UUID

  using do
    quote do
      import ChalkSync.WhiteboardV1.PostgresRepositoryCase
    end
  end

  defp database_url do
    System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
      System.get_env("CHALK_DATABASE_URL")
  end

  setup_all do
    if database_url() do
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(database_url())
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        SyncPostgres.restore_env(:database_connections, previous_connections)
        Enum.each(connections, &TestProcess.stop/1)
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

  def element(id, version, version_nonce) do
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

  def cleanup_whiteboard(connection, episode) do
    params = [uuid(episode.tenant_id), uuid(episode.space_id)]

    Enum.each(
      [
        "sync_whiteboard_files",
        "sync_whiteboard_operation_receipts",
        "sync_whiteboard_permissions",
        "sync_whiteboard_draw_policies",
        "sync_whiteboard_draw_policy_receipts",
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

  def uuid(value), do: UUID.dump!(value)
end
